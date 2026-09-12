import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { isAdminRole } from "@/lib/roles";
import { buildRepMatcher } from "@/lib/rep-identity";
import { DEFAULT_OFFICE, OFFICE_FILTER_OPTIONS } from "@/lib/offices";
import {
  OfficeFilterProvider,
  OfficeFilterToggle,
  useOfficeFilter,
} from "@/components/OfficeFilterContext";
import {
  ArcadeCard,
  ArcadePanel,
  ArcadePill,
  MobileCard,
  MobileCardHeader,
  MobileCardList,
  NeonButton,
  RangeChip,
  metricText,
} from "@/components/arcade";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useWeekSelector } from "@/hooks/useWeekSelector";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import {
  addDaysISO,
  dateFromISO,
  formatWeekRange,
  laMonthStartISO,
  laTodayISO,
  monthStartISO,
  nextMonthStartISO,
} from "@/lib/dates";
import {
  aggregateCloseKombat,
  auditBlockCards,
  countReps,
  isReload,
  resolveCards,
  volumeReps,
  type AttentionItem,
  type AttentionKind,
  type BlockCard,
  type CardOutcome,
  type KombatTotals,
  type RepStats,
} from "@/lib/close-kombat";
import { getKombatSyncInfo, syncBlockCards } from "@/lib/close-kombat.functions";
import { GlossarySheet, type GlossarySections } from "@/components/GlossarySheet";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  Crown,
  RefreshCw,
  Swords,
} from "lucide-react";

/**
 * Close Kombat — sales-rep standings straight from the Monday.com Block
 * boards, in Monday's own column language (Iss / BO / OL / RS / PM / Sale).
 * Day / Week / Month / Year ranges are all LA-calendar (card_date is the
 * physical appointment date — no 7 PM report lock here). Standings are ranked by sale
 * volume in every range (owner, 2026-07-30). Shared cards: each rep gets
 * full RESULT credit but the sale VOLUME splits evenly (owner, 2026-07-29);
 * Office Appointments are not leads and aren't tracked here (owner,
 * 2026-07-29 — upsale money still counts in Revenue). The totals row counts
 * each card exactly once.
 */
export function CloseKombat() {
  return (
    // Sticky per device: most reps work one office, and this page is their
    // whole app — resetting to All Offices cost a tap every open (R-13).
    <OfficeFilterProvider storageKey="ti_kombat_office">
      <CloseKombatInner />
    </OfficeFilterProvider>
  );
}

type RangeTab = "day" | "week" | "month" | "year";
type DayPreset = "today" | "yesterday";

type ResolvedRange = {
  start: string;
  end: string;
  label: string;
  sub: string;
  isLive: boolean;
};

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

/** Result counts are whole numbers (full credit each rep); only revenue
 *  splits, and that renders through fmtMoney. */
const fmtCount = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/* One recipe for the standings' numeric cells; metricText composes the
 * dim-at-zero / kombat-faction coloring on top. */
const kbCell = "py-2.5 px-2 text-right tabular-nums";

const fmtPct = (p: number | null) => (p === null ? "—" : `${Math.round(p * 100)}%`);

/** Leads / Sale is a rate, not a share — one decimal, no % sign (owner,
 *  2026-07-30: "4.5, not 4.5654"). */
const fmtRatio = (n: number | null) => (n === null ? "—" : n.toFixed(1));

/** The company-totals tile wall as data (same pattern as StatLine's items):
 *  label · getter · accent, optional companion stat sharing the tile. */
type TileDef = {
  label: string;
  value: (t: KombatTotals) => string;
  accent: TileAccent;
  sub?: { label: string; value: (t: KombatTotals) => string; accent: TileAccent };
};
const COMPANY_TILES: TileDef[] = [
  { label: "Appts", value: (t) => fmtCount(t.appts), accent: "neon" },
  {
    label: "No Show",
    value: (t) => fmtCount(t.noShow),
    accent: "destructive",
    sub: { label: "NS %", value: (t) => fmtPct(t.noShowPct), accent: "destructive" },
  },
  {
    label: "No Demo",
    value: (t) => fmtCount(t.noDemo),
    accent: "destructive",
    sub: { label: "ND %", value: (t) => fmtPct(t.noDemoPct), accent: "destructive" },
  },
  {
    label: "OL",
    value: (t) => fmtCount(t.ol),
    accent: "warning",
    sub: { label: "OL %", value: (t) => fmtPct(t.olPct), accent: "warning" },
  },
  {
    label: "Reset",
    value: (t) => fmtCount(t.reset),
    accent: "accent",
    sub: { label: "Reset %", value: (t) => fmtPct(t.resetPct), accent: "accent" },
  },
  { label: "PM", value: (t) => fmtCount(t.pm), accent: "warning" },
  {
    label: "Sold",
    value: (t) => fmtCount(t.sold),
    accent: "victory",
    sub: { label: "Close %", value: (t) => fmtPct(t.closePct), accent: "neon" },
  },
  {
    label: "Reload",
    value: (t) => fmtCount(t.reloads),
    accent: "victory",
    sub: { label: "Reload %", value: (t) => fmtPct(t.reloadPct), accent: "victory" },
  },
  {
    label: "Cancels",
    value: (t) => fmtCount(t.cancels),
    accent: "destructive",
    sub: { label: "Cancel %", value: (t) => fmtPct(t.cancelPct), accent: "destructive" },
  },
  { label: "Sit %", value: (t) => fmtPct(t.sitPct), accent: "accent" },
  { label: "Leads / Sale", value: (t) => fmtRatio(t.leadsToSale), accent: "neon" },
  { label: "Revenue", value: (t) => fmtMoney(t.revenue), accent: "victory" },
];

/** Link context fetched on each side of the visible window (owner,
 *  2026-08-28): a save can land in the month after its sale, and the
 *  re-priced deal pays out on the ORIGINAL's date — so every view needs to
 *  see far enough both ways for linkSaves to pair the cards. Six weeks
 *  covers any month/week edge with room for a slow save. */
const SAVE_LINK_PAD_DAYS = 42;

function CloseKombatInner() {
  const qc = useQueryClient();
  const { realRole, role, displayName } = useAuth();
  const { matches, office } = useOfficeFilter();
  const isAdmin = isAdminRole(realRole);
  // The rep-first layout keys off the EFFECTIVE role so View As previews it;
  // the admin controls above keep keying off realRole (the sync buttons must
  // not vanish from the owner mid-preview).
  const isRep = role === "sales_rep";

  // --- Range engine: Day / Week (Mon–Sun) / Month / Year, all LA-calendar ---
  const [tab, setTab] = useState<RangeTab>("day");
  const [dayPreset, setDayPreset] = useState<DayPreset>("today");
  // Mon–SUN (not the Mon–Sat pay week): Block boards carry Sunday groups and
  // those cards must not fall off the week view.
  const week = useWeekSelector({ endOffsetDays: 6 });
  const [monthStart, setMonthStart] = useState<string>(() => laMonthStartISO());
  const shiftMonth = (delta: 1 | -1) =>
    setMonthStart((m) => (delta > 0 ? nextMonthStartISO(m) : monthStartISO(addDaysISO(m, -1))));
  const isCurrentMonth = monthStart === laMonthStartISO();
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
    dateFromISO(monthStart),
  );
  const todayISO = laTodayISO();
  // Year = the LA calendar year, Jan 1 → Dec 31 — the "who's really the best
  // rep" view (owner, 2026-09-10). Same window semantics as every other tab:
  // volume is the year's own, and a cross-year save still pays out on its
  // original sale's date, so a Dec sale saved in Jan stays in Dec's year.
  const currentYear = Number(todayISO.slice(0, 4));
  const [year, setYear] = useState<number>(currentYear);
  const isCurrentYear = year === currentYear;

  const range: ResolvedRange = useMemo(() => {
    if (tab === "day") {
      const d = dayPreset === "yesterday" ? addDaysISO(todayISO, -1) : todayISO;
      return {
        start: d,
        end: d,
        label: dayPreset === "yesterday" ? "Yesterday" : "Today",
        sub: d,
        isLive: dayPreset === "today",
      };
    }
    if (tab === "week") {
      return {
        start: week.weekStartISO,
        end: week.weekEndISO,
        label: formatWeekRange(week.weekStart, week.weekEnd),
        sub: `${week.weekStartISO} → ${week.weekEndISO}`,
        isLive: week.isCurrentWeek,
      };
    }
    if (tab === "year") {
      return {
        start: `${year}-01-01`,
        end: `${year}-12-31`,
        label: String(year),
        sub: `${year}-01-01 → ${year}-12-31`,
        isLive: isCurrentYear,
      };
    }
    const monthEnd = addDaysISO(nextMonthStartISO(monthStart), -1);
    return {
      start: monthStart,
      end: monthEnd,
      label: monthLabel,
      sub: `${monthStart} → ${monthEnd}`,
      isLive: isCurrentMonth,
    };
  }, [
    tab,
    dayPreset,
    todayISO,
    week.weekStart,
    week.weekEnd,
    week.weekStartISO,
    week.weekEndISO,
    week.isCurrentWeek,
    monthStart,
    monthLabel,
    isCurrentMonth,
    year,
    isCurrentYear,
  ]);

  // --- Data: block_cards snapshots in range, office-filtered client-side.
  // Paged: PostgREST silently caps un-ranged selects at 1000 rows, and a
  // backfilled month (2 offices × ~4-5 boards) can exceed that — truncation
  // here would silently understate every stat. Walk until a short page.
  // One walk spans BOTH windows (stats range + volume window), padded by
  // SAVE_LINK_PAD_DAYS of pure link context on each side; the aggregate
  // takes the full set and counts only its own window.
  const fetchStart = addDaysISO(range.start, -SAVE_LINK_PAD_DAYS);
  const fetchEnd = addDaysISO(range.end, SAVE_LINK_PAD_DAYS);
  // Exactly the BlockCard fields — select("*") also dragged created_at /
  // updated_at across the wire for thousands of rows, for nothing.
  const CARD_COLUMNS =
    "monday_item_id, board_id, office_location, card_date, group_title, lead_name, reps, " +
    "iss, bo, ol, rs, pm, sale, sale_price, products, canvass_stats, wcc, comments, phone, " +
    "report_reps";
  const cardsQuery = useQuery({
    queryKey: ["block_cards", fetchStart, fetchEnd],
    // The abort signal MUST reach every page request (2026-09-02): a
    // full-history sync's realtime storm invalidated this query over and
    // over, react-query cancelled each stale fetch — but the un-wired page
    // requests kept running. ~1,000 zombie queries piled onto prod REST and
    // froze the page. With the signal wired, a cancelled refetch actually
    // aborts its in-flight pages.
    queryFn: async ({ signal }) => {
      const PAGE = 1000;
      const all: BlockCard[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("block_cards")
          .select(CARD_COLUMNS)
          .gte("card_date", fetchStart)
          .lte("card_date", fetchEnd)
          .order("monday_item_id")
          .range(from, from + PAGE - 1)
          .abortSignal(signal);
        if (error) throw error;
        all.push(...((data ?? []) as unknown as BlockCard[]));
        if (!data || data.length < PAGE) break;
      }
      return all;
    },
    staleTime: 15_000,
    // Range/view flips keep showing the previous range's real numbers for
    // the second the new fetch takes — all-zero tiles read as data loss.
    placeholderData: (prev) => prev,
  });

  useRealtimeInvalidate({
    channel: "close-kombat-live",
    tables: ["block_cards"],
    invalidateKeys: [["block_cards"]],
  });

  const officeCards = useMemo(
    () => (cardsQuery.data ?? []).filter((c) => matches(c.office_location)),
    [cardsQuery.data, matches],
  );
  // The whole padded fetch goes in; the window says what counts. Context
  // cards outside it only serve save→original linking (a July 30 sale saved
  // Aug 5 pays out in July at the save's price — owner, 2026-08-28).
  const { reps, totals } = useMemo(
    () => aggregateCloseKombat(officeCards, { start: range.start, end: range.end }),
    [officeCards, range.start, range.end],
  );
  // The standings' far-right money is the view's OWN range (owner,
  // 2026-09-08, superseding the 2026-08-04 week-in-progress convention the
  // dispatch board also dropped that day in PR #141): Today shows today's
  // volume, never yesterday's sale riding along on the week.

  // Board-hygiene callouts. Admins get the full office queue (realRole, so
  // "View as" previews don't hide it from the owner); reps get ONLY the flags
  // on cards bearing their own name (R-3) — blank_price counts their sale as
  // $0 and orphan_save counts their save money nowhere, and the person whose
  // paycheck it is was the one viewer who couldn't see the flag.
  const attentionAll = useMemo(
    () =>
      isAdmin || isRep
        ? auditBlockCards(officeCards, todayISO, { start: range.start, end: range.end })
        : [],
    [isAdmin, isRep, officeCards, todayISO, range.start, range.end],
  );
  const attention = isAdmin ? attentionAll : [];
  const [showAllAttention, setShowAllAttention] = useState(false);

  // --- Rep self-identity (R-4): the match ladder runs against CARD-LEVEL
  // names (block reps + report reps over the whole padded fetch), never the
  // standings rows — a rep whose only card counts NOWHERE (a Sold trapped on
  // a Not Issued card, an orphaned save) has no standings row, and that is
  // exactly when they most need their flags and deals to still find them
  // (review 2026-09-12). The wider pool also keeps the ambiguity guard
  // honest: a same-surname colleague is still a candidate on their day off.
  const allBoardNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of officeCards) {
      for (const n of countReps(c)) names.add(n);
      for (const n of volumeReps(c)) names.add(n);
    }
    return [...names];
  }, [officeCards]);
  const matcher = useMemo(
    () => buildRepMatcher(displayName, allBoardNames),
    [displayName, allBoardNames],
  );
  const myIdx = useMemo(() => reps.findIndex((r) => matcher.isMe(r.rep)), [reps, matcher]);
  const myRow = myIdx >= 0 ? reps[myIdx] : null;
  const ahead = myIdx > 0 ? reps[myIdx - 1] : null;

  const cardById = useMemo(() => {
    const m = new Map<string, BlockCard>();
    for (const c of officeCards) m.set(c.monday_item_id, c);
    return m;
  }, [officeCards]);

  // Flags find the rep through EITHER credit path: the Block card's reps or
  // the report stamp (rep_mismatch's whole point is that those disagree).
  const myAttention = useMemo(() => {
    if (!isRep || !matcher.matched) return [];
    return attentionAll.filter((it) => {
      if (it.reps.some(matcher.isMe)) return true;
      const card = cardById.get(it.monday_item_id);
      return card ? volumeReps(card).some(matcher.isMe) : false;
    });
  }, [isRep, matcher, attentionAll, cardById]);

  // Per-card resolution shared with the aggregate (save linking, cancel
  // revival, excluded gate) — MY DEALS must never contradict the standings
  // sitting under it on the same screen.
  const resolution = useMemo(() => resolveCards(officeCards), [officeCards]);

  // My Deals (R-2): the rep's own cards in the range, itemized — customer,
  // date, result, dollars. Display only; `resolution` keeps every row
  // telling the same story the aggregate counts.
  const myDeals = useMemo(() => {
    if (!isRep || !matcher.matched) return [];
    const rows: MyDeal[] = [];
    for (const c of officeCards) {
      if (!c.card_date || c.card_date < range.start || c.card_date > range.end) continue;
      const mine = countReps(c).some(matcher.isMe) || volumeReps(c).some(matcher.isMe);
      if (!mine) continue;
      const res = resolution.get(c.monday_item_id);
      if (!res) continue;
      if (res.isSave) {
        rows.push({
          id: c.monday_item_id,
          name: c.lead_name,
          date: c.card_date,
          outcome: "save",
          reload: false,
          price: c.sale_price,
          counted: false,
          revived: false,
          officeAppt: false,
          saveLanded: res.consumedSave,
        });
        continue;
      }
      if (res.outcome === "unmarked") continue; // joins the list once resulted
      rows.push({
        id: c.monday_item_id,
        name: c.lead_name,
        date: c.card_date,
        outcome: res.outcome,
        reload: res.outcome === "sold" && isReload(c),
        price: res.effectivePrice,
        counted: res.counted,
        revived: res.revivedBySave,
        officeAppt: res.officeAppt,
        saveLanded: false,
      });
    }
    rows.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    return rows;
  }, [isRep, matcher, officeCards, resolution, range.start, range.end]);
  const [dealsOpen, setDealsOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);

  // Staleness truth (R-5): cancels + rep splits move only when an admin runs
  // a sync — the "Live" chip is about the RANGE, not the stamps.
  const syncInfo = useQuery({
    queryKey: ["kombat_sync_info"],
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: () => getKombatSyncInfo(),
  });

  // Office war (R-15): SD vs OC over the range on screen, filter-independent.
  const officeRace = useMemo(() => {
    const win = { start: range.start, end: range.end };
    return OFFICE_FILTER_OPTIONS.filter((o) => o !== "All").map((o) => ({
      office: o,
      revenue: aggregateCloseKombat(
        (cardsQuery.data ?? []).filter((c) => (c.office_location ?? DEFAULT_OFFICE) === o),
        win,
      ).totals.revenue,
    }));
  }, [cardsQuery.data, range.start, range.end]);

  // Today's closers (R-10): every rep with a kept sale today, any range view
  // that includes today. Celebration, not accounting — but only sales the
  // standings actually COUNT (a hidden sale on a Not Issued card must not
  // get chips before the office fixes it).
  const todaysClosers = useMemo(() => {
    if (!range.isLive) return [] as Array<[string, number]>;
    const names = new Map<string, number>();
    for (const c of officeCards) {
      if (c.card_date !== todayISO) continue;
      const res = resolution.get(c.monday_item_id);
      if (!res || res.isSave || !res.counted || res.outcome !== "sold") continue;
      for (const n of countReps(c)) names.set(n, (names.get(n) ?? 0) + 1);
    }
    return [...names.entries()].sort((a, b) => b[1] - a[1]);
  }, [officeCards, resolution, todayISO, range.isLive]);

  // KA-CHING (R-10): my kept-sale count ticking up on a live range = a sale
  // just landed on the board. Guards (review 2026-09-12): only SETTLED data
  // may write or compare the baseline — a cold load's 0→3 hydration and a
  // range flip's placeholder rows must never read as a sale landing.
  const mySales = myRow ? myRow.sold + myRow.reloads : 0;
  const kaChingRef = useRef<{ key: string; sales: number } | null>(null);
  const [heroFlash, setHeroFlash] = useState(false);
  useEffect(() => {
    if (!isRep || !range.isLive) return;
    if (!cardsQuery.isSuccess || cardsQuery.isPlaceholderData) return;
    const key = `${range.start}:${range.end}:${office}`;
    const prev = kaChingRef.current;
    kaChingRef.current = { key, sales: mySales };
    if (!prev || prev.key !== key || mySales <= prev.sales) return;
    toast.success("KA-CHING! Sale confirmed — it's on the board. 🥊");
    setHeroFlash(true);
  }, [
    isRep,
    range.isLive,
    range.start,
    range.end,
    office,
    mySales,
    cardsQuery.isSuccess,
    cardsQuery.isPlaceholderData,
  ]);
  // Un-flash on its own timer so a tab/office flip inside the 3s window
  // can't strand the hero pulsing forever (the fire effect's cleanup used
  // to own the timer and dep churn killed it).
  useEffect(() => {
    if (!heroFlash) return;
    const t = setTimeout(() => setHeroFlash(false), 3_000);
    return () => clearTimeout(t);
  }, [heroFlash]);

  // --- Admin sync: pull the boards from Monday on demand ---
  const sync = useMutation({
    mutationFn: (scope: "active" | "all") => syncBlockCards({ data: { scope } }),
    onSuccess: (res) => {
      const fetched = res.results.reduce((s, r) => s + r.fetched, 0);
      toast.success(
        `Synced ${res.results.length} board${res.results.length === 1 ? "" : "s"} · ${fetched} cards`,
      );
      if (res.skipped.length > 0) {
        toast.warning(
          `${res.skipped.length} board${res.skipped.length === 1 ? "" : "s"} skipped — see webhook logs`,
        );
      }
      const cancels = res.wcc.reports.reduce((s, r) => s + r.cancelled, 0);
      if (cancels > 0) {
        toast.info(
          `${cancels} cancelled/CTC/FTD sale${cancels === 1 ? "" : "s"} on the Sales Reports`,
        );
      }
      if (res.wcc.reps_updated > 0) {
        toast.info(
          `${res.wcc.reps_updated} card${res.wcc.reps_updated === 1 ? "" : "s"} took rep credit from the Sales Reports`,
        );
      }
      if (res.wcc.reps_cleared > 0) {
        toast.info(
          `${res.wcc.reps_cleared} stale rep stamp${res.wcc.reps_cleared === 1 ? "" : "s"} cleared`,
        );
      }
      const repsColMissing = res.wcc.reports.filter((r) => r.reps_column_missing);
      if (repsColMissing.length > 0) {
        toast.warning(
          `No "Sales Rep" column found on ${repsColMissing.map((r) => r.name).join(", ")} — rep splits from that board are frozen until it's restored`,
        );
      }
      if (res.wcc.errors.length > 0) {
        toast.warning(`Cancels pass: ${res.wcc.errors.length} report board(s) failed — see logs`);
      }
      qc.invalidateQueries({ queryKey: ["block_cards"] });
      // The freshness caption must move the moment the sync that feeds it
      // lands (review 2026-09-12).
      qc.invalidateQueries({ queryKey: ["kombat_sync_info"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Sync failed"),
  });

  // Self rows go through the conservative match ladder (R-4) — the old
  // whole-string equality died on any board-name drift.
  const isMe = matcher.isMe;

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-sm text-kombat-gold uppercase tracking-widest flex items-center gap-2">
            <Swords className="w-4 h-4 text-kombat-red" />
            Close Kombat
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Sales rep results · straight from the Monday.com Block boards
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <>
              <NeonButton
                tone="kombat-gold"
                disabled={sync.isPending}
                onClick={() => sync.mutate("active")}
                title="Re-pull this week's two active Block boards"
              >
                <RefreshCw className={`w-4 h-4 ${sync.isPending ? "animate-spin" : ""}`} />
                Sync from Monday
              </NeonButton>
              <NeonButton
                tone="kombat-red"
                disabled={sync.isPending}
                onClick={() => sync.mutate("all")}
                title="Backfill every SD/OC Block board Monday still lists"
              >
                Full history
              </NeonButton>
            </>
          )}
          <OfficeFilterToggle />
        </div>
      </div>

      {/* Range tabs: Day / Week / Month / Year, plus each range's own controls */}
      <div
        data-tour="kombat-range"
        className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide"
      >
        {(
          [
            { id: "day", label: "Day" },
            { id: "week", label: "Week" },
            { id: "month", label: "Month" },
            { id: "year", label: "Year" },
          ] as Array<{ id: RangeTab; label: string }>
        ).map((p) => (
          <ArcadePill
            key={p.id}
            tone="kombat-gold"
            active={tab === p.id}
            onClick={() => setTab(p.id)}
          >
            {p.label}
          </ArcadePill>
        ))}

        <span className="mx-1 h-5 w-px bg-border shrink-0" aria-hidden />

        {tab === "day" && (
          <>
            {(
              [
                { id: "today", label: "Today" },
                { id: "yesterday", label: "Yesterday" },
              ] as Array<{ id: DayPreset; label: string }>
            ).map((p) => (
              <ArcadePill
                key={p.id}
                tone="kombat-gold"
                size="sm"
                active={dayPreset === p.id}
                onClick={() => setDayPreset(p.id)}
              >
                {p.label}
              </ArcadePill>
            ))}
          </>
        )}

        {tab === "week" && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => week.shiftWeek(-1)}
              title="Previous week"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <RangeChip>{range.label}</RangeChip>
            <Button size="sm" variant="outline" onClick={() => week.shiftWeek(1)} title="Next week">
              <ChevronRight className="w-4 h-4" />
            </Button>
            {!week.isCurrentWeek && (
              <Button size="sm" variant="ghost" onClick={() => week.goToWeek()}>
                Jump to current week
              </Button>
            )}
          </>
        )}

        {tab === "month" && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => shiftMonth(-1)}
              title="Previous month"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <RangeChip>{range.label}</RangeChip>
            <Button size="sm" variant="outline" onClick={() => shiftMonth(1)} title="Next month">
              <ChevronRight className="w-4 h-4" />
            </Button>
            {!isCurrentMonth && (
              <Button size="sm" variant="ghost" onClick={() => setMonthStart(laMonthStartISO())}>
                Jump to current month
              </Button>
            )}
          </>
        )}

        {tab === "year" && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setYear((y) => y - 1)}
              title="Previous year"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <RangeChip>{range.label}</RangeChip>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setYear((y) => y + 1)}
              title="Next year"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
            {!isCurrentYear && (
              <Button size="sm" variant="ghost" onClick={() => setYear(currentYear)}>
                Jump to current year
              </Button>
            )}
          </>
        )}

        <span className="ml-2 text-[10px] text-muted-foreground font-mono whitespace-nowrap">
          {range.sub}
        </span>
      </div>

      {/* Rep-first ordering (R-1): the closer's own range leads their one
          screen; the company tile wall moves below the standings for them.
          Admins keep the office pulse on top. */}
      {isRep && (
        <RepHero
          row={myRow}
          rank={myIdx}
          repCount={reps.length}
          ahead={ahead}
          rangeLabel={range.label}
          matched={matcher.matched}
          hasNames={allBoardNames.length > 0}
          flash={heroFlash}
          dim={cardsQuery.isPlaceholderData}
        />
      )}

      {isRep && myAttention.length > 0 && (
        <ArcadePanel
          faction="kombat"
          title={`Your cards need office attention · ${myAttention.length}`}
          action={
            <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              The office fixes these, then syncs
            </span>
          }
        >
          {/* Read-only by design: the rep can't fix Monday, but they're the
              most motivated auditor of their own money — a blank price means
              THEIR sale counts $0 until the office moves (R-3). */}
          <ul className="space-y-2">
            {myAttention.slice(0, ATTENTION_CAP).map((it) => (
              <AttentionRow key={it.monday_item_id} it={it} />
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-muted-foreground">
            These can shift your numbers — a blank price counts as $0 and an unlinked save counts
            nowhere until the boards are fixed and synced.
          </p>
        </ArcadePanel>
      )}

      {isRep && myDeals.length > 0 && (
        <ArcadePanel
          faction="kombat"
          title={`My Deals · ${range.label}`}
          action={
            <button
              onClick={() => setDealsOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-[10px] font-display uppercase tracking-widest text-kombat-gold min-h-11 px-2"
            >
              {dealsOpen ? "Hide" : `Show ${myDeals.length}`}
              {dealsOpen ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>
          }
        >
          {dealsOpen ? (
            <ul className="space-y-2">
              {myDeals.slice(0, 60).map((d) => (
                <MyDealRow key={d.id} d={d} />
              ))}
              {myDeals.length > 60 && (
                <li className="text-[10px] text-muted-foreground">
                  Showing the latest 60 of {myDeals.length}.
                </li>
              )}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              Every one of your cards in this range — customer, result, and the dollars — so
              &quot;which cancel took the money&quot; is never a mystery.
            </p>
          )}
        </ArcadePanel>
      )}

      {todaysClosers.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide">
          <span className="shrink-0 text-[10px] font-display uppercase tracking-widest text-kombat-gold">
            🎉 Today&apos;s closers
          </span>
          {todaysClosers.map(([name, n]) => (
            <span
              key={name}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-kombat-gold/40 bg-kombat-gold/5 px-3 py-1 text-[10px] font-display uppercase tracking-widest"
            >
              {name}
              <span className="text-kombat-gold tabular-nums">{n} sold</span>
            </span>
          ))}
        </div>
      )}

      {/* Company totals — computed from cards, never from summed rep rows.
          Appts = resulted cards only (owner, 2026-07-30 — unresulted cards
          don't count anywhere), so No Show + No Demo + Reset + PM + Sold
          always equals Appts. Cancels sit inside PM and Reloads sit outside
          Appts entirely, so neither belongs in that sum. Result order follows
          the board's own funnel (owner, 2026-07-30). While a new range's
          fetch is in flight the previous range's real numbers stay up
          (placeholderData) but dimmed — the Year fetch pages ~15 months of
          cards and can take seconds, and full-brightness stale numbers under
          a new label read as the new range's truth. */}
      {!isRep && <CompanyTiles totals={totals} dim={cardsQuery.isPlaceholderData} />}

      {attention.length > 0 && (
        <ArcadePanel
          faction="kombat"
          title={`Needs Attention · ${attention.length}`}
          action={
            <span className="text-[10px] font-display uppercase tracking-widest text-warning">
              Fix on Monday, then sync
            </span>
          }
        >
          {/* Capped so a backfilled past month can't bury the standings —
              items are sorted worst-first, so the cut only hides the tail. */}
          <ul className="space-y-2">
            {(showAllAttention ? attention : attention.slice(0, ATTENTION_CAP)).map((it) => (
              <AttentionRow key={it.monday_item_id} it={it} />
            ))}
          </ul>
          {attention.length > ATTENTION_CAP && (
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              onClick={() => setShowAllAttention((v) => !v)}
            >
              {showAllAttention
                ? "Show fewer"
                : `Show all ${attention.length} (${attention.length - ATTENTION_CAP} more)`}
            </Button>
          )}
        </ArcadePanel>
      )}

      <div data-tour="kombat-standings">
        <ArcadePanel
          faction="kombat"
          title={`Kombat Standings · ${range.label}`}
          action={
            cardsQuery.isPlaceholderData ? (
              <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground animate-pulse">
                Counting…
              </span>
            ) : range.isLive ? (
              <span className="text-[10px] font-display uppercase tracking-widest text-victory">
                Live
              </span>
            ) : undefined
          }
        >
          {/* Stamp freshness (R-5): the Live chip is about the RANGE — cancels
            and report splits only move when the office runs a sync. */}
          <p className="mb-3 text-[10px] text-muted-foreground">
            Results land live from the boards · cancels &amp; rep splits update when the office
            syncs
            {syncInfo.data ? ` — last sync ${relTime(syncInfo.data.lastSyncedAt)}` : ""}.
          </p>
          {cardsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading the bracket…</p>
          ) : reps.length === 0 ? (
            <div className="text-sm text-muted-foreground space-y-1">
              <p>No Block cards with reps in this range yet.</p>
              {isAdmin && (
                <p className="text-xs">
                  Hit <span className="text-foreground">Sync from Monday</span> to pull the active
                  boards, or <span className="text-foreground">Full history</span> to backfill past
                  weeks.
                </p>
              )}
            </div>
          ) : (
            <div className={cn("transition-opacity", cardsQuery.isPlaceholderData && "opacity-50")}>
              {/* Desktop table (Monday's column language) */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] font-display uppercase tracking-widest text-muted-foreground border-b border-border">
                      <th className="text-left py-2 pr-2 font-normal">#</th>
                      <th className="text-left py-2 pr-2 font-normal">Rep</th>
                      <th className="text-right py-2 px-2 font-normal">Appts</th>
                      <th className="text-right py-2 px-2 font-normal">No Show</th>
                      <th className="text-right py-2 px-2 font-normal">No Demo</th>
                      <th className="text-right py-2 px-2 font-normal">OL</th>
                      <th className="text-right py-2 px-2 font-normal">Reset</th>
                      <th className="text-right py-2 px-2 font-normal">PM</th>
                      <th className="text-right py-2 px-2 font-normal">Sold</th>
                      <th className="text-right py-2 px-2 font-normal">Reload</th>
                      <th className="text-right py-2 px-2 font-normal">Cancels</th>
                      <th className="text-right py-2 px-2 font-normal border-l border-border/60">
                        Sit %
                      </th>
                      <th className="text-right py-2 px-2 font-normal">NS %</th>
                      <th className="text-right py-2 px-2 font-normal">ND %</th>
                      <th className="text-right py-2 px-2 font-normal">OL %</th>
                      <th className="text-right py-2 px-2 font-normal">Reset %</th>
                      <th className="text-right py-2 px-2 font-normal">Close %</th>
                      <th className="text-right py-2 px-2 font-normal">Reload %</th>
                      <th className="text-right py-2 px-2 font-normal">Cancel %</th>
                      <th className="text-right py-2 px-2 font-normal">Leads / Sale</th>
                      <th
                        className="text-right py-2 pl-2 font-normal"
                        title="Sale volume over the range on screen — Today shows today's money only"
                      >
                        Volume
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {reps.map((r, i) => (
                      <tr
                        key={r.rep}
                        className={`border-b border-border/40 transition-colors duration-200 hover:bg-surface-elevated ${
                          isMe(r.rep)
                            ? "bg-kombat-gold/5 ring-1 ring-inset ring-kombat-gold/30"
                            : ""
                        }`}
                      >
                        <td className="py-2.5 pr-2 text-muted-foreground tabular-nums">
                          {i === 0 && r.revenue > 0 ? (
                            <Crown
                              className="w-4 h-4 text-kombat-gold inline"
                              aria-label="Champion"
                            />
                          ) : (
                            i + 1
                          )}
                        </td>
                        <td className="py-2.5 pr-2 font-medium">
                          {r.rep}
                          {isMe(r.rep) && <YouTag />}
                          <FlawlessBadge r={r} />
                        </td>
                        <td className={cn(kbCell, metricText(r.appts, "text-foreground"))}>
                          {fmtCount(r.appts)}
                        </td>
                        <td className={cn(kbCell, metricText(r.noShow, "text-destructive"))}>
                          {fmtCount(r.noShow)}
                        </td>
                        <td className={cn(kbCell, metricText(r.noDemo, "text-destructive"))}>
                          {fmtCount(r.noDemo)}
                        </td>
                        <td className={cn(kbCell, metricText(r.ol, "text-warning"))}>
                          {fmtCount(r.ol)}
                        </td>
                        <td className={cn(kbCell, metricText(r.reset, "text-accent"))}>
                          {fmtCount(r.reset)}
                        </td>
                        <td className={cn(kbCell, metricText(r.pm, "text-warning"))}>
                          {fmtCount(r.pm)}
                        </td>
                        <td
                          className={cn(
                            kbCell,
                            "font-medium",
                            metricText(r.sold, "text-kombat-gold"),
                          )}
                        >
                          {fmtCount(r.sold)}
                        </td>
                        <td className={cn(kbCell, metricText(r.reloads, "text-kombat-gold"))}>
                          {fmtCount(r.reloads)}
                        </td>
                        <td className={cn(kbCell, metricText(r.cancels, "text-destructive"))}>
                          {fmtCount(r.cancels)}
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs border-l border-border/60">
                          {fmtPct(r.sitPct)}
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs text-destructive">
                          {fmtPct(r.noShowPct)}
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs text-destructive">
                          {fmtPct(r.noDemoPct)}
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs text-warning">
                          {fmtPct(r.olPct)}
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs text-accent">
                          {fmtPct(r.resetPct)}
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs">
                          {fmtPct(r.closePct)}
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs text-victory">
                          {fmtPct(r.reloadPct)}
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs text-destructive">
                          {fmtPct(r.cancelPct)}
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs">
                          {fmtRatio(r.leadsToSale)}
                        </td>
                        <td
                          className={cn(
                            "py-2.5 pl-2 text-right tabular-nums",
                            metricText(r.revenue, "text-kombat-gold"),
                          )}
                        >
                          {fmtMoney(r.revenue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-neon/40 text-foreground">
                      <td className="py-2.5 pr-2" />
                      <td className="py-2.5 pr-2 font-display text-[10px] uppercase tracking-widest">
                        All cards
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums">
                        {fmtCount(totals.appts)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums">
                        {fmtCount(totals.noShow)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums">
                        {fmtCount(totals.noDemo)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums">{fmtCount(totals.ol)}</td>
                      <td className="py-2.5 px-2 text-right tabular-nums">
                        {fmtCount(totals.reset)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums">{fmtCount(totals.pm)}</td>
                      <td className="py-2.5 px-2 text-right tabular-nums">
                        {fmtCount(totals.sold)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums">
                        {fmtCount(totals.reloads)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums">
                        {fmtCount(totals.cancels)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs border-l border-border/60">
                        {fmtPct(totals.sitPct)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs">
                        {fmtPct(totals.noShowPct)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs">
                        {fmtPct(totals.noDemoPct)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs">
                        {fmtPct(totals.olPct)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs">
                        {fmtPct(totals.resetPct)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs">
                        {fmtPct(totals.closePct)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs">
                        {fmtPct(totals.reloadPct)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs">
                        {fmtPct(totals.cancelPct)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs">
                        {fmtRatio(totals.leadsToSale)}
                      </td>
                      <td className="py-2.5 pl-2 text-right tabular-nums">
                        {fmtMoney(totals.revenue)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Mobile cards — same precomputed rows */}
              <MobileCardList>
                {reps.map((r, i) => (
                  <MobileCard
                    key={r.rep}
                    className={isMe(r.rep) ? "border-kombat-gold/40 bg-kombat-gold/5" : undefined}
                  >
                    <MobileCardHeader
                      left={
                        <span className="flex items-center gap-1.5">
                          {i === 0 && r.revenue > 0 ? (
                            <Crown className="w-3.5 h-3.5 text-kombat-gold shrink-0" />
                          ) : (
                            <span className="text-muted-foreground tabular-nums">{i + 1}.</span>
                          )}
                          {r.rep}
                          {isMe(r.rep) && <YouTag />}
                          <FlawlessBadge r={r} />
                        </span>
                      }
                      right={
                        <span className={metricText(r.revenue, "text-kombat-gold")}>
                          {fmtMoney(r.revenue)}
                        </span>
                      }
                    />
                    <MobileStatBlock s={r} />
                  </MobileCard>
                ))}
                <MobileCard className="border-neon/40">
                  <MobileCardHeader
                    left={
                      <span className="font-display text-[10px] uppercase tracking-widest">
                        All cards
                      </span>
                    }
                    right={<span className="text-victory">{fmtMoney(totals.revenue)}</span>}
                  />
                  <MobileStatBlock s={totals} />
                </MobileCard>
              </MobileCardList>
            </div>
          )}
        </ArcadePanel>
      </div>

      {/* Office war (R-15): SD vs OC over the range on screen. Ignores the
          office filter on purpose — a race needs both lanes. */}
      <ArcadePanel
        faction="kombat"
        title={`Office War · ${range.label}`}
        action={
          cardsQuery.isPlaceholderData ? (
            <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground animate-pulse">
              Counting…
            </span>
          ) : undefined
        }
      >
        <div
          className={cn(
            "space-y-3 transition-opacity",
            cardsQuery.isPlaceholderData && "opacity-50",
          )}
        >
          {(() => {
            const max = Math.max(1, ...officeRace.map((o) => o.revenue));
            const top = Math.max(...officeRace.map((o) => o.revenue));
            return officeRace.map((o) => {
              const leads = o.revenue === top && o.revenue > 0;
              return (
                <div key={o.office} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-2 text-[10px] font-display uppercase tracking-widest">
                    <span className={leads ? "text-kombat-gold" : "text-muted-foreground"}>
                      {o.office}
                      {leads ? " 👑" : ""}
                    </span>
                    <span
                      className={cn(
                        "tabular-nums",
                        leads ? "text-kombat-gold" : "text-muted-foreground",
                      )}
                    >
                      {fmtMoney(o.revenue)}
                    </span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-surface-elevated overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${Math.round((o.revenue / max) * 100)}%`,
                        background: leads ? "var(--kombat-gold)" : "var(--kombat-red)",
                        boxShadow: leads ? "0 0 10px var(--kombat-gold)" : undefined,
                      }}
                    />
                  </div>
                </div>
              );
            });
          })()}
        </div>
      </ArcadePanel>

      {/* Reps still get the company pulse — just after their own story. */}
      {isRep && (
        <div>
          <div className="mb-2 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Company · {range.label}
          </div>
          <CompanyTiles totals={totals} dim={cardsQuery.isPlaceholderData} />
        </div>
      )}

      {/* The old ~600-word 10px legend paragraph carried pay-critical rules
          as one unreadable wall (rep audit R-7) — the same content lives in
          the structured glossary sheet now, phone-usable. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          data-tour="kombat-legend"
          onClick={() => setGlossaryOpen(true)}
          className="inline-flex items-center gap-1.5 min-h-11 px-3 rounded-md border border-kombat-gold/40 text-[10px] font-display uppercase tracking-widest text-kombat-gold hover:bg-surface-elevated"
        >
          <CircleHelp className="w-3.5 h-3.5" /> What the columns mean
        </button>
        <span className="text-[10px] text-muted-foreground">
          Columns mirror the Monday.com Block boards · one result per card · ranked by volume in
          every range.
        </span>
      </div>
      <GlossarySheet
        open={glossaryOpen}
        onOpenChange={setGlossaryOpen}
        sections={KOMBAT_GLOSSARY}
        title="What the columns mean"
        accentClass="text-kombat-gold"
      />
    </div>
  );
}

/** The Monday column language + every pay rule, structured (was the legend
 *  paragraph). Definitions mirror close-kombat.ts — if a rule changes there,
 *  change it here. */
const KOMBAT_GLOSSARY: GlossarySections = [
  {
    heading: "The columns",
    terms: [
      [
        "Appts",
        "Resulted lead cards only — a card with nothing marked yet doesn't count anywhere. No Show + No Demo + OL + Reset + PM + Sold always adds up to Appts.",
      ],
      ["No Show", "The lead wasn't there — half of the board's BO split."],
      ["No Demo", "The appointment happened but no demo ran — the other half of BO."],
      [
        "OL",
        "One-leg: the lead ran but didn't get demoed (one decision-maker). A result of its own, never a demo.",
      ],
      ["Reset", "Rescheduled to run again."],
      [
        "PM",
        "A demo that didn't end in a kept sale — includes FTDs (financial turn-downs) and cancelled sales: the demo ran, the money didn't.",
      ],
      ["Sold", "A kept sale from an issued lead."],
      [
        "Reload",
        "A re-sale to an existing customer — its own channel. The money counts in Volume/Revenue, but it's not an Appt: no lead was issued, so it stays out of every lead rate.",
      ],
      [
        "Cancels",
        "A written sale later marked Cancelled/CTC on the monthly Sales Report. The money comes back out, but you still sat that demo — it counts as a PM and the sit stands.",
      ],
    ],
  },
  {
    heading: "The rates",
    terms: [
      ["Sit %", "(PM + Sold) ÷ Appts."],
      ["Close %", "Sold ÷ (PM + Sold) — lead demos only, reloads excluded."],
      ["Cancel %", "Cancels ÷ (Sold + Cancels) — the share of written sales that died."],
      ["Reload %", "Reload ÷ (Sold + Reload) — the share of all sales that were reloads."],
      ["Leads/Sale", "Appts ÷ Sold, shown as a number (4.5), not a percentage."],
      ["—", 'An empty denominator. "No sales yet" and "0%" are different claims.'],
    ],
  },
  {
    heading: "The money",
    terms: [
      [
        "Volume",
        "Sale dollars over the RANGE ON SCREEN — Today shows today's money only, the Week tab that week's, and so on.",
      ],
      [
        "Splits",
        "Shared cards: every rep gets full result credit, the volume splits evenly. When the monthly Sales Report's rep pair disagrees with the Block card, the money follows the report (results stay with the card).",
      ],
      [
        "Blank $",
        "A blank Sale Price counts as $0, full stop — nothing is ever guessed in. It shows as a Blank Price flag until the office fixes the board.",
      ],
      [
        "Stamps",
        "Cancels and report splits move only when the office runs a sync — results land live, those don't. The line above the standings says when the stamps last moved.",
      ],
    ],
  },
  {
    heading: "Saves",
    terms: [
      [
        "Can/Save",
        "A sold job cancelled and a rep saved it — the office writes Can/Save in the save card's Comments.",
      ],
      [
        "The split",
        "The save's price REPLACES the original volume. The saver takes 50% off the top; the original rep(s) split the rest — one seller is 50/50, two sellers 50/25/25. The saver earns volume, not a Sold.",
      ],
      [
        "The month",
        "A save always pays on the ORIGINAL sale's date — save a July deal in August and the money lands in July's standings. Page back to see it.",
      ],
      ["Failed", "A Can/Save card with no price changed nothing — the job stayed dead."],
    ],
  },
  {
    heading: "The board",
    terms: [
      [
        "One result",
        "One result per card, in this order of authority: Cancel > FTD > Sold > PM > Reset > BO > OL.",
      ],
      [
        "Rank",
        "Reps are ranked by sale volume, highest first, in every range. The All-cards row counts each card exactly once.",
      ],
      [
        "Office Appt",
        "Job visits, upsales, check pickups — not leads, not tracked here; upsale money still counts in Revenue.",
      ],
      [
        "Excluded",
        "CTC, Not Issued, and Add Rep cards count nowhere (unless the Sales Report proves the sale ran).",
      ],
    ],
  },
];

/** The four numbers a closer checks between appointments, on the card face —
 *  the full stat wall folds out behind a tap (rep audit R-8; the old
 *  18-stat single-line sideways scroller buried Close % mid-swipe and made
 *  rep-vs-rep comparison a two-handed job at 375px). */
function MobileStatBlock({ s }: { s: KombatTotals }) {
  const [open, setOpen] = useState(false);
  const headline: Array<{ label: string; value: string; className?: string }> = [
    { label: "Appts", value: fmtCount(s.appts) },
    { label: "Sold", value: fmtCount(s.sold), className: "text-victory" },
    { label: "Close", value: fmtPct(s.closePct) },
    { label: "Cancels", value: fmtCount(s.cancels), className: "text-destructive" },
  ];
  const rest: Array<{ label: string; value: string; className?: string }> = [
    { label: "No Show", value: fmtCount(s.noShow), className: "text-destructive" },
    { label: "No Demo", value: fmtCount(s.noDemo), className: "text-destructive" },
    { label: "OL", value: fmtCount(s.ol), className: "text-warning" },
    { label: "Reset", value: fmtCount(s.reset), className: "text-accent" },
    { label: "PM", value: fmtCount(s.pm), className: "text-warning" },
    { label: "Reload", value: fmtCount(s.reloads), className: "text-victory" },
    { label: "Sit", value: fmtPct(s.sitPct) },
    { label: "NS %", value: fmtPct(s.noShowPct), className: "text-destructive" },
    { label: "ND %", value: fmtPct(s.noDemoPct), className: "text-destructive" },
    { label: "OL %", value: fmtPct(s.olPct), className: "text-warning" },
    { label: "Reset %", value: fmtPct(s.resetPct), className: "text-accent" },
    { label: "Reload %", value: fmtPct(s.reloadPct), className: "text-victory" },
    { label: "Cancel %", value: fmtPct(s.cancelPct), className: "text-destructive" },
    { label: "Leads / Sale", value: fmtRatio(s.leadsToSale) },
  ];
  const Stat = (it: { label: string; value: string; className?: string }) => (
    <span key={it.label} className="shrink-0">
      <span className={`font-medium ${it.className ?? ""}`}>{it.value}</span>{" "}
      <span className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">
        {it.label}
      </span>
    </span>
  );
  return (
    <div className="text-sm tabular-nums">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-x-3 flex-wrap gap-y-1 min-w-0">
          {headline.map(Stat)}
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Hide the full stat line" : "Show the full stat line"}
          className="shrink-0 inline-flex items-center justify-center min-h-11 min-w-11 rounded text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>
      {open && (
        <div className="mt-1.5 flex items-baseline gap-x-3 gap-y-1 flex-wrap border-t border-border/40 pt-1.5">
          {rest.map(Stat)}
        </div>
      )}
    </div>
  );
}

function YouTag() {
  return (
    <span className="ml-1.5 inline-block align-middle rounded border border-kombat-gold/60 bg-kombat-gold/10 px-1.5 py-0.5 text-[9px] font-display uppercase tracking-widest text-kombat-gold">
      You
    </span>
  );
}

/** "2h ago" for the sync-stamp caption; coarse on purpose. */
function relTime(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** The closer's own range, first (rep audit R-1). Money = REAL split volume
 *  only (owner call 2026-09-12 — no projections here); the four headline
 *  stats under it; rank + gap-to-next in ladder language (R-9). */
function RepHero({
  row,
  rank,
  repCount,
  ahead,
  rangeLabel,
  matched,
  hasNames,
  flash,
  dim,
}: {
  row: RepStats | null;
  rank: number;
  repCount: number;
  ahead: RepStats | null;
  rangeLabel: string;
  matched: string | null;
  /** Any board names existed to match against — the warning below is an
   *  IDENTITY claim and must never fire just because the rep hasn't closed
   *  in this range (review 2026-09-12: the matcher pool is card-level names
   *  over the padded fetch, so a quiet morning keeps `matched` alive). */
  hasNames: boolean;
  flash: boolean;
  dim: boolean;
}) {
  if (!matched && hasNames) {
    // Identity miss (R-4): say so instead of silently rendering a stranger's
    // board — the old failure mode was a rep who "wasn't on" their own ladder.
    return (
      <ArcadeCard faction="kombat" className="p-4" data-tour="kombat-hero">
        <div className="text-[10px] font-display uppercase tracking-widest text-warning">
          Couldn&apos;t find your row
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Your profile name didn&apos;t match any rep name on the boards. If you closed deals here,
          tell the office the name the boards use for you.
        </p>
      </ArcadeCard>
    );
  }
  const gap = ahead && row ? ahead.revenue - row.revenue : 0;
  return (
    <div
      data-tour="kombat-hero"
      className={cn(
        "rounded-xl border border-kombat-gold/40 bg-[color-mix(in_oklab,var(--kombat-gold)_7%,var(--surface))] p-5 transition-opacity",
        dim && "opacity-50",
        flash && "animate-pulse ring-2 ring-kombat-gold/60",
      )}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-kombat-gold/80">
            Your {rangeLabel} · Volume
          </div>
          <div className="mt-1.5 font-display text-4xl sm:text-5xl text-kombat-gold leading-none tabular-nums">
            {fmtMoney(row?.revenue ?? 0)}
          </div>
        </div>
        {row && (
          <div className="text-right">
            <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              Rank
            </div>
            <div className="mt-1 font-display text-2xl tabular-nums">
              {rank === 0 && row.revenue > 0 ? (
                <Crown className="w-6 h-6 text-kombat-gold inline" aria-label="Champion" />
              ) : (
                `#${rank + 1}`
              )}
              <span className="text-muted-foreground text-sm"> / {repCount}</span>
            </div>
          </div>
        )}
      </div>
      <div className="mt-3 flex items-baseline gap-x-4 gap-y-1 flex-wrap text-sm tabular-nums">
        <span>
          <span className="font-medium text-victory">{fmtCount(row?.sold ?? 0)}</span>{" "}
          <span className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">
            Sold
          </span>
        </span>
        <span>
          <span className="font-medium">{fmtPct(row?.closePct ?? null)}</span>{" "}
          <span className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">
            Close
          </span>
        </span>
        <span>
          <span className="font-medium text-destructive">{fmtCount(row?.cancels ?? 0)}</span>{" "}
          <span className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">
            Cancels
          </span>
        </span>
        <span>
          <span className="font-medium">{fmtCount(row?.appts ?? 0)}</span>{" "}
          <span className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">
            Appts
          </span>
        </span>
      </div>
      <div className="mt-2 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        {!row ? (
          "No resulted appointments in this range yet — the first result puts you on the board."
        ) : rank === 0 && row.revenue > 0 ? (
          "Top of the board 👑"
        ) : ahead ? (
          <>
            <span className="text-kombat-gold">{fmtMoney(gap)}</span> behind {ahead.rep}
          </>
        ) : (
          ""
        )}
      </div>
    </div>
  );
}

/** One card in MY DEALS (R-2): result-colored label + customer + dollars —
 *  the show-the-underlying-rows norm, pointed at the rep's own paycheck.
 *  Rows come pre-resolved through resolveCards, so a saved deal, an
 *  excluded card, or a re-priced sale reads EXACTLY the way the standings
 *  count it (review 2026-09-12). */
type MyDeal = {
  id: string;
  name: string | null;
  date: string | null;
  outcome: CardOutcome | "save";
  reload: boolean;
  price: number | null;
  counted: boolean;
  revived: boolean;
  officeAppt: boolean;
  saveLanded: boolean;
};

const DEAL_META: Record<CardOutcome | "save", { label: string; className: string }> = {
  sold: { label: "Sold", className: "text-kombat-gold" },
  cancelled: { label: "Cancelled", className: "text-destructive" },
  pm: { label: "PM · demo, no sale", className: "text-warning" },
  reset: { label: "Reset", className: "text-accent" },
  no_show: { label: "No Show", className: "text-destructive" },
  no_demo: { label: "No Demo", className: "text-destructive" },
  ol: { label: "One Leg", className: "text-warning" },
  unmarked: { label: "No result yet", className: "text-muted-foreground" },
  save: { label: "Save", className: "text-victory" },
};

function MyDealRow({ d }: { d: MyDeal }) {
  const meta = DEAL_META[d.outcome];
  const label = d.reload ? "Reload" : d.revived ? "Sold · saved" : meta.label;
  const note =
    d.outcome === "save"
      ? d.saveLanded
        ? "SAVE LANDED — your 50% pays on the ORIGINAL sale's month. Page back to see it."
        : d.price != null && d.price > 0
          ? "Priced but not linked to its original yet — counts nowhere until the office matches the cards."
          : "No price on the save card — the job stayed dead, nothing counts."
      : d.outcome === "cancelled"
        ? d.officeAppt
          ? "A dead reload/upsell — the money came back out (no sit involved)."
          : "The demo still counts as your sit — the money came back out."
        : d.revived
          ? "This deal cancelled and got SAVED — re-priced, and it still counts."
          : d.outcome === "sold" && !d.counted
            ? "NOT COUNTING — the sale is trapped on a Not Issued/CTC card until the office fixes the board."
            : null;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm border-b border-border/40 pb-2 last:border-b-0 last:pb-0">
      <span
        className={`font-display text-[10px] uppercase tracking-widest whitespace-nowrap ${
          d.outcome === "sold" && !d.counted ? "text-warning" : meta.className
        }`}
      >
        {label}
      </span>
      <span className="font-medium min-w-0 truncate">{d.name ?? "(unnamed card)"}</span>
      <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
        {d.date ?? "no date"}
      </span>
      {d.price != null && d.price > 0 && (
        <span
          className={`ml-auto tabular-nums ${
            d.outcome === "cancelled"
              ? "text-destructive line-through"
              : d.outcome === "sold" && !d.counted
                ? "text-warning"
                : "text-kombat-gold"
          }`}
        >
          {fmtMoney(d.price)}
        </span>
      )}
      {note && <span className="w-full text-[10px] text-muted-foreground">{note}</span>}
    </li>
  );
}

/** The 12-tile company wall, extracted so the rep layout can demote it
 *  below the standings (R-1) while admins keep it on top. */
function CompanyTiles({ totals, dim }: { totals: KombatTotals; dim: boolean }) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-3 transition-opacity",
        dim && "opacity-50",
      )}
    >
      {COMPANY_TILES.map((d) => (
        <KombatTile
          key={d.label}
          label={d.label}
          value={d.value(totals)}
          accent={d.accent}
          sub={d.sub && { label: d.sub.label, value: d.sub.value(totals), accent: d.sub.accent }}
        />
      ))}
    </div>
  );
}

function FlawlessBadge({ r }: { r: RepStats }) {
  if (r.sold + r.reloads < 1 || r.closePct !== 1) return null;
  return (
    <span className="ml-1.5 inline-block align-middle rounded border border-victory/40 px-1.5 py-0.5 text-[9px] font-display uppercase tracking-widest text-victory whitespace-nowrap">
      Flawless Victory
    </span>
  );
}

/** Rows shown before the "Show all" toggle kicks in — enough for a normal
 *  day's issues, small enough that a backfilled month can't bury the page. */
const ATTENTION_CAP = 12;

/** Money-impacting issues read red; bookkeeping drift reads amber. */
const ATTENTION_META: Record<AttentionKind, { label: string; className: string }> = {
  // The Monday copy-step double (an automation copies new sale cards): one
  // deal counting twice — money-doubling, the reddest flag there is.
  duplicate_sale: { label: "Duplicate Sale", className: "text-destructive" },
  excluded_sale: { label: "Hidden Sale", className: "text-destructive" },
  // A priced Can/Save that linked to no original: real money counting
  // nowhere until the cards match — as red as a hidden sale.
  orphan_save: { label: "Unlinked Save", className: "text-destructive" },
  no_reps: { label: "No Reps", className: "text-destructive" },
  blank_price: { label: "Blank Price", className: "text-destructive" },
  // Amber, not red: volume already follows the Sales Report, so nothing
  // counts wrong — but the boards CONTRADICT each other on who sat the deal.
  // (A report row that only ADDS names is the office's save split — the
  // saver in the pay pair — and never flags; owner, 2026-09-02.)
  rep_mismatch: { label: "Rep Mismatch", className: "text-warning" },
  unresolved: { label: "No Result", className: "text-warning" },
  no_weekday_group: { label: "Wrong Group", className: "text-warning" },
};

function AttentionRow({ it }: { it: AttentionItem }) {
  const meta = ATTENTION_META[it.kind];
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm border-b border-border/40 pb-2 last:border-b-0 last:pb-0">
      <span
        className={`font-display text-[10px] uppercase tracking-widest whitespace-nowrap ${meta.className}`}
      >
        {meta.label}
      </span>
      <span className="font-medium">{it.lead_name ?? "(unnamed card)"}</span>
      <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
        {it.card_date ?? "no date"} · {it.office_location}
        {it.reps.length > 0 ? ` · ${it.reps.join(", ")}` : ""}
      </span>
      <span className="text-xs text-muted-foreground">{it.detail}</span>
    </li>
  );
}

type TileAccent = "neon" | "victory" | "accent" | "warning" | "destructive" | "muted";

const TILE_ACCENT: Record<TileAccent, string> = {
  neon: "text-neon",
  victory: "text-victory",
  accent: "text-accent",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

function KombatTile({
  label,
  value,
  accent,
  sub,
}: {
  label: string;
  value: number | string;
  accent: TileAccent;
  /** Companion stat sharing the tile (e.g. Sold + Close %), right-aligned. */
  sub?: { label: string; value: number | string; accent: TileAccent };
}) {
  return (
    <ArcadeCard faction="kombat">
      <div className="flex items-baseline justify-between gap-2 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        <span>{label}</span>
        {sub && <span className="text-right">{sub.label}</span>}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className={`font-display text-2xl ${TILE_ACCENT[accent]}`}>{value}</span>
        {sub && (
          <span className={`font-display text-lg ${TILE_ACCENT[sub.accent]}`}>{sub.value}</span>
        )}
      </div>
    </ArcadeCard>
  );
}
