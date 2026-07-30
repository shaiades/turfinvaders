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
import { ArcadePanel, MobileCard, MobileCardHeader, MobileCardList } from "@/components/arcade";
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
  type BlockCard,
  type KombatTotals,
  type RepStats,
} from "@/lib/close-kombat";
import { syncBlockCards } from "@/lib/close-kombat.functions";
import { toast } from "sonner";
import { CalendarRange, ChevronLeft, ChevronRight, Crown, RefreshCw, Swords } from "lucide-react";

/**
 * Close Kombat — sales-rep standings straight from the Monday.com Block
 * boards, in Monday's own column language (Iss / BO / OL / RS / PM / Sale).
 * Day / Week / Month ranges are all LA-calendar (card_date is the physical
 * appointment date — no 7 PM report lock here). Shared cards: each rep gets
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

const fmtPct = (p: number | null) => (p === null ? "—" : `${Math.round(p * 100)}%`);

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
  ]);

  // --- Data: block_cards snapshots in range, office-filtered client-side.
  // Paged: PostgREST silently caps un-ranged selects at 1000 rows, and a
  // backfilled month (2 offices × ~4-5 boards) can exceed that — truncation
  // here would silently understate every stat. Walk until a short page.
  const cardsQuery = useQuery({
    queryKey: ["block_cards", range.start, range.end],
    queryFn: async () => {
      const PAGE = 1000;
      const all: BlockCard[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("block_cards")
          .select("*")
          .gte("card_date", range.start)
          .lte("card_date", range.end)
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

  const visible = useMemo(
    () => (cardsQuery.data ?? []).filter((c) => matches(c.office_location)),
    [cardsQuery.data, matches],
  );
  const { reps, totals } = useMemo(() => aggregateCloseKombat(visible), [visible]);

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
      if (res.wcc.errors.length > 0) {
        toast.warning(`WCC pass: ${res.wcc.errors.length} report board(s) failed — see logs`);
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
          <h1 className="font-display text-sm text-neon uppercase tracking-widest flex items-center gap-2">
            <Swords className="w-4 h-4" />
            Close Kombat
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Sales rep results · straight from the Monday.com Block boards
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={sync.isPending}
                onClick={() => sync.mutate("active")}
                title="Re-pull this week's two active Block boards"
              >
                <RefreshCw className={`w-4 h-4 ${sync.isPending ? "animate-spin" : ""}`} />
                Sync from Monday
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={sync.isPending}
                onClick={() => sync.mutate("all")}
                title="Backfill every SD/OC Block board Monday still lists"
              >
                Full history
              </Button>
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
        ).map((p) => {
          const active = tab === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setTab(p.id)}
              className={`px-3 py-2 rounded-full text-[10px] font-display uppercase tracking-widest whitespace-nowrap border transition-colors ${
                active
                  ? "bg-neon text-background border-neon"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-neon/40"
              }`}
            >
              {p.label}
            </button>
          );
        })}

        <span className="mx-1 h-5 w-px bg-border shrink-0" aria-hidden />

        {tab === "day" && (
          <>
            {(
              [
                { id: "today", label: "Today" },
                { id: "yesterday", label: "Yesterday" },
              ] as Array<{ id: DayPreset; label: string }>
            ).map((p) => {
              const active = dayPreset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setDayPreset(p.id)}
                  className={`px-2.5 py-1.5 rounded-full text-[10px] font-display uppercase tracking-widest whitespace-nowrap border transition-colors ${
                    active
                      ? "bg-neon text-background border-neon"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-neon/40"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
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
            <div className="px-3 py-1 rounded border border-neon/40 bg-neon/5 flex items-center gap-2 whitespace-nowrap">
              <CalendarRange className="w-4 h-4 text-neon shrink-0" />
              <span className="text-xs font-display">{range.label}</span>
            </div>
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
            <div className="px-3 py-1 rounded border border-neon/40 bg-neon/5 flex items-center gap-2 whitespace-nowrap">
              <CalendarRange className="w-4 h-4 text-neon shrink-0" />
              <span className="text-xs font-display">{range.label}</span>
            </div>
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
          don't count anywhere), so Sold + Reload + PM + Reset + No Show +
          No Demo + WCC + FTD always equals Appts. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-3">
        <KombatTile label="Appts" value={fmtCount(totals.appts)} accent="neon" />
        <KombatTile
          label="Sold"
          value={fmtCount(totals.sold)}
          accent="victory"
          sub={{ label: "Close %", value: fmtPct(totals.closePct), accent: "neon" }}
        />
        <KombatTile
          label="Reload"
          value={fmtCount(totals.reloads)}
          accent="victory"
          sub={{ label: "Reload %", value: fmtPct(totals.reloadPct), accent: "victory" }}
        />
        <KombatTile label="PM" value={fmtCount(totals.pm)} accent="warning" />
        <KombatTile
          label="Reset"
          value={fmtCount(totals.reset)}
          accent="accent"
          sub={{ label: "RS %", value: fmtPct(totals.rsPct), accent: "accent" }}
        />
        <KombatTile label="No Show" value={fmtCount(totals.noShow)} accent="destructive" />
        <KombatTile
          label="No Demo"
          value={fmtCount(totals.noDemo)}
          accent="destructive"
          sub={{ label: "ND %", value: fmtPct(totals.noDemoPct), accent: "destructive" }}
        />
        <KombatTile label="WCC" value={fmtCount(totals.wcc)} accent="destructive" />
        <KombatTile label="FTD" value={fmtCount(totals.ftd)} accent="destructive" />
        <KombatTile label="Sit %" value={fmtPct(totals.sitPct)} accent="accent" />
        <KombatTile label="Revenue" value={fmtMoney(totals.revenue)} accent="victory" />
      </div>

      <ArcadePanel
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
                    <th className="text-right py-2 px-2 font-normal">Reset</th>
                    <th className="text-right py-2 px-2 font-normal">PM</th>
                    <th className="text-right py-2 px-2 font-normal">Sold</th>
                    <th className="text-right py-2 px-2 font-normal">Reload</th>
                    <th className="text-right py-2 px-2 font-normal">WCC</th>
                    <th className="text-right py-2 px-2 font-normal">FTD</th>
                    <th className="text-right py-2 px-2 font-normal">OL</th>
                    <th className="text-right py-2 px-2 font-normal">Sit %</th>
                    <th className="text-right py-2 px-2 font-normal">Close %</th>
                    <th className="text-right py-2 px-2 font-normal">RS %</th>
                    <th className="text-right py-2 px-2 font-normal">Reload %</th>
                    <th className="text-right py-2 pl-2 font-normal">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {reps.map((r, i) => (
                    <tr
                      key={r.rep}
                      className={`border-b border-border/40 hover:bg-surface-elevated ${
                        isMe(r.rep) ? "bg-neon/5 ring-1 ring-inset ring-neon/30" : ""
                      }`}
                    >
                      <td className="py-2.5 pr-2 text-muted-foreground tabular-nums">
                        {i === 0 && r.sold + r.reloads > 0 ? (
                          <Crown className="w-4 h-4 text-warning inline" aria-label="Champion" />
                        ) : (
                          i + 1
                        )}
                      </td>
                      <td className="py-2.5 pr-2 font-medium">
                        {r.rep}
                        <FlawlessBadge r={r} />
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums">{fmtCount(r.appts)}</td>
                      <td className="py-2.5 px-2 text-right tabular-nums text-destructive">
                        {fmtCount(r.noShow)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums text-destructive">
                        {fmtCount(r.noDemo)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums text-accent">
                        {fmtCount(r.reset)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums text-warning">
                        {fmtCount(r.pm)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums text-victory font-medium">
                        {fmtCount(r.sold)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums text-victory">
                        {fmtCount(r.reloads)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums text-destructive">
                        {fmtCount(r.wcc)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums text-destructive">
                        {fmtCount(r.ftd)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums text-muted-foreground">
                        {fmtCount(r.ol)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs">
                        {fmtPct(r.sitPct)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs">
                        {fmtPct(r.closePct)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs text-accent">
                        {fmtPct(r.rsPct)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs text-victory">
                        {fmtPct(r.reloadPct)}
                      </td>
                      <td className="py-2.5 pl-2 text-right tabular-nums text-victory">
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
                    <td className="py-2.5 px-2 text-right tabular-nums">
                      {fmtCount(totals.reset)}
                    </td>
                    <td className="py-2.5 px-2 text-right tabular-nums">{fmtCount(totals.pm)}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums">{fmtCount(totals.sold)}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums">
                      {fmtCount(totals.reloads)}
                    </td>
                    <td className="py-2.5 px-2 text-right tabular-nums">{fmtCount(totals.wcc)}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums">{fmtCount(totals.ftd)}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums">{fmtCount(totals.ol)}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs">
                      {fmtPct(totals.sitPct)}
                    </td>
                    <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs">
                      {fmtPct(totals.closePct)}
                    </td>
                    <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs">
                      {fmtPct(totals.rsPct)}
                    </td>
                    <td className="py-2.5 px-2 text-right tabular-nums font-display text-xs">
                      {fmtPct(totals.reloadPct)}
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
                  className={isMe(r.rep) ? "border-neon/40 bg-neon/5" : undefined}
                >
                  <MobileCardHeader
                    left={
                      <span className="flex items-center gap-1.5">
                        {i === 0 && r.sold + r.reloads > 0 ? (
                          <Crown className="w-3.5 h-3.5 text-warning shrink-0" />
                        ) : (
                          <span className="text-muted-foreground tabular-nums">{i + 1}.</span>
                        )}
                        {r.rep}
                        <FlawlessBadge r={r} />
                      </span>
                    }
                    right={<span className="text-victory">{fmtMoney(r.revenue)}</span>}
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
                  right={<span className="text-victory">{fmtMoney(totals.revenue)}</span>}
                />
                <StatLine s={totals} />
              </MobileCard>
            </MobileCardList>
          </>
        )}
      </ArcadePanel>

      <p className="text-[10px] text-muted-foreground">
        Columns mirror the Monday.com Block boards — Iss = issued lead · BO splits into No Show / No
        Demo · RS = Reset · Sale = Sold. Office Appointments (job visit, upsale, check pickup) are
        not leads and aren&apos;t tracked here, though upsale money still counts in Revenue. CTC,
        Not Issued, and Add Rep cards don&apos;t count anywhere. Sold and Reload are separate
        results — a Reload is still a sale, so both count toward Close % and Revenue. WCC = sale
        later marked Cancelled or CTC on the monthly Sales Report; FTD = financial turn down — both
        leave Sold and Revenue but still count as demos (they update when a sync runs). One result
        per card (Sold &gt; PM &gt; Reset &gt; BO). An appointment with nothing marked on the board
        yet doesn&apos;t count anywhere — it joins Appts and the stats the moment a result lands, so
        Sold + Reload + PM + Reset + No Show + No Demo + WCC + FTD always adds up to Appts. On a
        shared card each rep gets full result credit but the sale volume splits evenly; the
        All-cards row counts each card once. Sit % = demos ÷ Appts · Close % = (Sold + Reload) ÷
        demos · RS % = Reset ÷ Appts · Reload % = Reload ÷ Appts · ND % = No Demo ÷ Appts, where
        demos = Sold + Reload + PM + WCC + FTD.
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
    { label: "Reset", value: fmtCount(s.reset), className: "text-accent" },
    { label: "PM", value: fmtCount(s.pm), className: "text-warning" },
    { label: "Sold", value: fmtCount(s.sold), className: "text-victory" },
    { label: "Reload", value: fmtCount(s.reloads), className: "text-victory" },
    { label: "WCC", value: fmtCount(s.wcc), className: "text-destructive" },
    { label: "FTD", value: fmtCount(s.ftd), className: "text-destructive" },
    { label: "OL", value: fmtCount(s.ol), className: "text-muted-foreground" },
    { label: "Sit", value: fmtPct(s.sitPct) },
    { label: "Close", value: fmtPct(s.closePct) },
    { label: "RS %", value: fmtPct(s.rsPct), className: "text-accent" },
    { label: "Reload %", value: fmtPct(s.reloadPct), className: "text-victory" },
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
    <div className="arcade-card p-4">
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
    </div>
  );
}
