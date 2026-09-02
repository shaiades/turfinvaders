import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { isAdminRole } from "@/lib/roles";
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
  weekStartOfISO,
} from "@/lib/dates";
import {
  aggregateCloseKombat,
  auditBlockCards,
  type AttentionItem,
  type AttentionKind,
  type BlockCard,
  type KombatTotals,
  type RepStats,
} from "@/lib/close-kombat";
import { syncBlockCards } from "@/lib/close-kombat.functions";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Crown, RefreshCw, Swords } from "lucide-react";

/**
 * Close Kombat — sales-rep standings straight from the Monday.com Block
 * boards, in Monday's own column language (Iss / BO / OL / RS / PM / Sale).
 * Day / Week / Month ranges are all LA-calendar (card_date is the physical
 * appointment date — no 7 PM report lock here). Standings are ranked by sale
 * volume in every range (owner, 2026-07-30). Shared cards: each rep gets
 * full RESULT credit but the sale VOLUME splits evenly (owner, 2026-07-29);
 * Office Appointments are not leads and aren't tracked here (owner,
 * 2026-07-29 — upsale money still counts in Revenue). The totals row counts
 * each card exactly once.
 */
export function CloseKombat() {
  return (
    <OfficeFilterProvider>
      <CloseKombatInner />
    </OfficeFilterProvider>
  );
}

type RangeTab = "day" | "week" | "month";
type DayPreset = "today" | "yesterday";

type ResolvedRange = {
  start: string;
  end: string;
  /** Volume window for the standings' far-right money (owner, 2026-08-04,
   *  same convention as the dispatch board): the Mon–Sun week containing
   *  the day on the Day view; the selected range on Week/Month. */
  volStart: string;
  volEnd: string;
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
  const { realRole, displayName } = useAuth();
  const { matches } = useOfficeFilter();
  const isAdmin = isAdminRole(realRole);

  // --- Range engine: Day / Week (Mon–Sun) / Month, all LA-calendar ---
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

  const range: ResolvedRange = useMemo(() => {
    if (tab === "day") {
      const d = dayPreset === "yesterday" ? addDaysISO(todayISO, -1) : todayISO;
      const wk = weekStartOfISO(d);
      return {
        start: d,
        end: d,
        volStart: wk,
        volEnd: addDaysISO(wk, 6),
        label: dayPreset === "yesterday" ? "Yesterday" : "Today",
        sub: d,
        isLive: dayPreset === "today",
      };
    }
    if (tab === "week") {
      return {
        start: week.weekStartISO,
        end: week.weekEndISO,
        volStart: week.weekStartISO,
        volEnd: week.weekEndISO,
        label: formatWeekRange(week.weekStart, week.weekEnd),
        sub: `${week.weekStartISO} → ${week.weekEndISO}`,
        isLive: week.isCurrentWeek,
      };
    }
    const monthEnd = addDaysISO(nextMonthStartISO(monthStart), -1);
    return {
      start: monthStart,
      end: monthEnd,
      volStart: monthStart,
      volEnd: monthEnd,
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
  ]);

  // --- Data: block_cards snapshots in range, office-filtered client-side.
  // Paged: PostgREST silently caps un-ranged selects at 1000 rows, and a
  // backfilled month (2 offices × ~4-5 boards) can exceed that — truncation
  // here would silently understate every stat. Walk until a short page.
  // One walk spans BOTH windows (stats range + volume window), padded by
  // SAVE_LINK_PAD_DAYS of pure link context on each side; the aggregate
  // takes the full set and counts only its own window.
  const fetchStart = addDaysISO(
    range.volStart < range.start ? range.volStart : range.start,
    -SAVE_LINK_PAD_DAYS,
  );
  const fetchEnd = addDaysISO(
    range.volEnd > range.end ? range.volEnd : range.end,
    SAVE_LINK_PAD_DAYS,
  );
  const cardsQuery = useQuery({
    queryKey: ["block_cards", fetchStart, fetchEnd],
    queryFn: async () => {
      const PAGE = 1000;
      const all: BlockCard[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("block_cards")
          .select("*")
          .gte("card_date", fetchStart)
          .lte("card_date", fetchEnd)
          .order("monday_item_id")
          .range(from, from + PAGE - 1);
        if (error) throw error;
        all.push(...((data ?? []) as BlockCard[]));
        if (!data || data.length < PAGE) break;
      }
      return all;
    },
    staleTime: 15_000,
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
  // The standings' far-right money: sale volume over the week in progress on
  // the Day view (the selected range on Week/Month) — owner, 2026-08-04,
  // matching the dispatch board's convention.
  const vol = useMemo(() => {
    const agg = aggregateCloseKombat(officeCards, {
      start: range.volStart,
      end: range.volEnd,
    });
    return {
      byRep: new Map(agg.reps.map((r) => [r.rep, r.revenue])),
      total: agg.totals.revenue,
    };
  }, [officeCards, range.volStart, range.volEnd]);

  // Board-hygiene callouts for the office (ADMIN tier — realRole, so "View
  // as" previews don't hide it from the owner). Same cards the stats read,
  // so the list always describes exactly the range and office on screen.
  const attention = useMemo(
    () =>
      isAdmin ? auditBlockCards(officeCards, todayISO, { start: range.start, end: range.end }) : [],
    [isAdmin, officeCards, todayISO, range.start, range.end],
  );
  const [showAllAttention, setShowAllAttention] = useState(false);

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
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Sync failed"),
  });

  const myName = (displayName ?? "").trim().toLowerCase();
  const isMe = (rep: string) => myName !== "" && rep.trim().toLowerCase() === myName;

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

      {/* Range tabs: Day / Week / Month, plus each range's own controls */}
      <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
        {(
          [
            { id: "day", label: "Day" },
            { id: "week", label: "Week" },
            { id: "month", label: "Month" },
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

        <span className="ml-2 text-[10px] text-muted-foreground font-mono whitespace-nowrap">
          {range.sub}
        </span>
      </div>

      {/* Company totals — computed from cards, never from summed rep rows.
          Appts = resulted cards only (owner, 2026-07-30 — unresulted cards
          don't count anywhere), so No Show + No Demo + Reset + PM + Sold
          always equals Appts. Cancels sit inside PM and Reloads sit outside
          Appts entirely, so neither belongs in that sum. Result order follows
          the board's own funnel (owner, 2026-07-30). */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-3">
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

      <ArcadePanel
        faction="kombat"
        title={`Kombat Standings · ${range.label}`}
        action={
          range.isLive ? (
            <span className="text-[10px] font-display uppercase tracking-widest text-victory">
              Live
            </span>
          ) : undefined
        }
      >
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
          <>
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
                      title="Sale volume — Mon–Sun week in progress on the Day view; the selected range on Week/Month"
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
                        isMe(r.rep) ? "bg-kombat-gold/5 ring-1 ring-inset ring-kombat-gold/30" : ""
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
                          metricText(vol.byRep.get(r.rep) ?? 0, "text-kombat-gold"),
                        )}
                      >
                        {fmtMoney(vol.byRep.get(r.rep) ?? 0)}
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
                    <td className="py-2.5 px-2 text-right tabular-nums">{fmtCount(totals.sold)}</td>
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
                    <td className="py-2.5 pl-2 text-right tabular-nums">{fmtMoney(vol.total)}</td>
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
                        <FlawlessBadge r={r} />
                      </span>
                    }
                    right={
                      <span className={metricText(vol.byRep.get(r.rep) ?? 0, "text-kombat-gold")}>
                        {fmtMoney(vol.byRep.get(r.rep) ?? 0)}
                      </span>
                    }
                  />
                  <StatLine s={r} />
                </MobileCard>
              ))}
              <MobileCard className="border-neon/40">
                <MobileCardHeader
                  left={
                    <span className="font-display text-[10px] uppercase tracking-widest">
                      All cards
                    </span>
                  }
                  right={<span className="text-victory">{fmtMoney(vol.total)}</span>}
                />
                <StatLine s={totals} />
              </MobileCard>
            </MobileCardList>
          </>
        )}
      </ArcadePanel>

      <p className="text-[10px] text-muted-foreground">
        Columns mirror the Monday.com Block boards — Iss = issued lead · BO splits into No Show / No
        Demo · OL = one-leg (the lead ran but didn&apos;t get demoed — a result of its own, never a
        demo) · RS = Reset · Sale = Sold. Office Appointments (job visit, upsale, check pickup) are
        not leads and aren&apos;t tracked here, though upsale money still counts in Revenue. CTC,
        Not Issued, and Add Rep cards don&apos;t count anywhere. A Reload is a re-sale to an
        existing customer and stands as its own channel: it&apos;s counted whatever the Iss cell
        says (reloads happen at the job, so they&apos;re nearly always marked Office Appt), its
        money counts in Revenue, but it is not an Appt — no lead was issued for it, so it stays out
        of Sit %, Close %, Reset % and Leads / Sale. Cancels = a sale later marked Cancelled or CTC
        on the monthly Sales Report: the volume comes back out, but the rep still sat that demo, so
        it counts as a PM and the sit stands — 5 PM and 2 sales with 1 cancel reads as 6 PM and 1
        sale, still 7 sits. The Cancels column tallies those alongside rather than as a result of
        their own. An FTD (financial turn down) is a PM the same way — the demo ran, the money
        didn&apos;t. Both update when a sync runs. One result per card (Cancel &gt; FTD &gt; Sold
        &gt; PM &gt; Reset &gt; BO &gt; OL). An appointment with nothing marked on the board yet
        doesn&apos;t count anywhere — it joins Appts and the stats the moment a result lands, so No
        Show + No Demo + OL + Reset + PM + Sold always adds up to Appts. Reps are ranked by sale
        volume, highest first, in every range. On a shared card each rep gets full result credit but
        the sale volume splits evenly; the All-cards row counts each card once. When the monthly
        Sales Report&apos;s Sales Rep column disagrees with the Block card, the volume split follows
        the report (result counts stay with the Block card&apos;s own reps) and a Rep Mismatch
        callout flags the card so the Block board can be fixed. Sit % = (PM + Sold) ÷ Appts · NS % =
        No Show ÷ Appts · ND % = No Demo ÷ Appts · OL % = OL ÷ Appts · Reset % = Reset ÷ Appts ·
        Close % = Sold ÷ (PM + Sold) · Cancel % = Cancels ÷ (Sold + Cancels) · Leads / Sale = Appts
        ÷ Sold, shown as a number, not a percentage. Those are all lead metrics, so reloads are
        outside every one of them; Reload % = Reload ÷ (Sold + Reload) is the one that counts both,
        being the share of all sales that were reloads. A ratio with nothing in its denominator
        shows &quot;—&quot;, not 0%. Can/Save: when a sold job cancels and a rep saves it (the
        office writes &quot;Can/Save&quot; in the save card&apos;s Comments), the save&apos;s Sale
        Price replaces the original volume; the saver takes 50% and the original rep(s) split the
        other 50% evenly — one seller makes it 50/50, two sellers 50/25/25. The saver earns volume,
        not a Sold. A Can/Save card with no price is a failed save and changes nothing. Saves match
        their original sale by office + phone (customer name when the save has no phone), across
        month edges too — the re-priced volume always pays out on the original sale&apos;s date, so
        a July sale saved in August shows in July&apos;s standings. A Can/Save card never counts as
        an issued lead of its own — no Appt, no Sold, whatever gets marked on it — and a priced save
        that can&apos;t find its original raises an Unlinked Save callout instead of counting
        anywhere.
      </p>
    </div>
  );
}

/** Every lead stat on ONE line (owner request 2026-07-29), desktop-column
 *  order; scrolls sideways on narrow phones rather than wrapping. */
function StatLine({ s }: { s: KombatTotals }) {
  const items: Array<{ label: string; value: string; className?: string }> = [
    { label: "Appts", value: fmtCount(s.appts) },
    { label: "No Show", value: fmtCount(s.noShow), className: "text-destructive" },
    { label: "No Demo", value: fmtCount(s.noDemo), className: "text-destructive" },
    { label: "OL", value: fmtCount(s.ol), className: "text-warning" },
    { label: "Reset", value: fmtCount(s.reset), className: "text-accent" },
    { label: "PM", value: fmtCount(s.pm), className: "text-warning" },
    { label: "Sold", value: fmtCount(s.sold), className: "text-victory" },
    { label: "Reload", value: fmtCount(s.reloads), className: "text-victory" },
    { label: "Cancels", value: fmtCount(s.cancels), className: "text-destructive" },
    { label: "Sit", value: fmtPct(s.sitPct) },
    { label: "NS %", value: fmtPct(s.noShowPct), className: "text-destructive" },
    { label: "ND %", value: fmtPct(s.noDemoPct), className: "text-destructive" },
    { label: "OL %", value: fmtPct(s.olPct), className: "text-warning" },
    { label: "Reset %", value: fmtPct(s.resetPct), className: "text-accent" },
    { label: "Close", value: fmtPct(s.closePct) },
    { label: "Reload %", value: fmtPct(s.reloadPct), className: "text-victory" },
    { label: "Cancel %", value: fmtPct(s.cancelPct), className: "text-destructive" },
    { label: "Leads / Sale", value: fmtRatio(s.leadsToSale) },
  ];
  return (
    <div className="flex items-baseline gap-x-3 overflow-x-auto scrollbar-hide whitespace-nowrap text-sm tabular-nums">
      {items.map((it) => (
        <span key={it.label} className="shrink-0">
          <span className={`font-medium ${it.className ?? ""}`}>{it.value}</span>{" "}
          <span className="text-[9px] font-display uppercase tracking-wider text-muted-foreground">
            {it.label}
          </span>
        </span>
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
