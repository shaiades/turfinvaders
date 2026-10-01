import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, CircleHelp, Crown, Eye, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";
import {
  addDaysISO,
  dateFromISO,
  laDateISO,
  laMidnightUtcISO,
  laMonthStartISO,
  laTodayISO,
  monthStartISO,
  nextMonthStartISO,
  weekStartOfISO,
} from "@/lib/dates";
import { DEFAULT_OFFICE, OFFICE_LOCATIONS } from "@/lib/offices";
import {
  OfficeFilterProvider,
  OfficeFilterToggle,
  useOfficeFilter,
} from "@/components/OfficeFilterContext";
import {
  ArcadeCard,
  ArcadePanel,
  ArcadePill,
  ArcadeSkeleton,
  ArcadeStatTile,
  DeltaChip,
  MobileCard,
  MobileCardHeader,
  MobileCardList,
  MobileStat,
  MobileStatGrid,
  NeonBar,
  NeonButton,
  RangeChip,
  Sparkbars,
  type PanelStatus,
} from "@/components/arcade";
import { QueryStateCard } from "@/components/QueryStateCard";
import { GlossarySheet, type GlossarySections } from "@/components/GlossarySheet";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { useDispatchRoster, useDispatchVans } from "@/hooks/useFleetRoster";
import { usePendingDojoCount } from "@/hooks/usePendingDojoCount";
import { useCountUp } from "@/hooks/useCountUp";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useInView } from "@/hooks/useInView";
import { rewardToast } from "@/lib/reward-toast";
import { isLeadSourceName } from "@/lib/lead-sources";
import {
  aggregateCloseKombat,
  aggregateReportYear,
  buildPendingReportCheck,
  cardOutcome,
  filterReportRows,
  CARD_COLUMNS,
  SAVE_LINK_PAD_DAYS,
  type BlockCard,
  type ReportSaleRow,
} from "@/lib/close-kombat";
import { getKombatSyncInfo, syncBlockCards } from "@/lib/close-kombat.functions";
import { getCollectionsSyncInfo, syncCollections } from "@/lib/collections.functions";
import { getWhatChanged } from "@/lib/deviations.functions";
import {
  aggregateCollections,
  buildCashCurve,
  buildForwardOutlook,
  monthlyCollectionsTrend,
  rowCollectionState,
} from "@/lib/collections";
import {
  agingBuckets,
  buildCompletionCurve,
  daysBetween,
  financingMix,
  leverSensitivities,
  matchedSpanCollected,
  median,
  projectFromCurve,
  slipStats,
  topShare,
} from "@/lib/capital";
import { DOORS_TRACKED_SINCE } from "@/lib/funnel";
import {
  getClockPresence,
  getDispatchProduction,
  getFunnelBaseline,
  type DispatchResults,
} from "@/lib/dispatch.functions";
import { fetchMonthlyPaychecksChunked } from "@/lib/paychecks";
import { CashCurve } from "@/components/godmode/CashCurve";
import { CalendarHeatmap, type HeatDay } from "@/components/godmode/CalendarHeatmap";

const MiniSalesMap = lazy(() => import("@/components/godmode/MiniSalesMap"));

/**
 * God Mode v3 — judgment, levers, delivery (owner directives 2026-10-01).
 * One month, every axis, and now the exchange rates between them: pace vs
 * the editable target with matched-span deltas, speed of cash, the Path to
 * the annual goal, concentration risk, and per-panel status lights so the
 * whole page reads from its headers. Three money axes stay separate (the
 * ⓘ glossary holds the definitions); the receipts drawer itemizes the
 * headline; margin is shown only from hand-entered costs — never derived.
 */
export function GodMode({
  monthParam,
  setMonthParam,
}: {
  monthParam: string | null;
  setMonthParam: (m: string) => void;
}) {
  return (
    <OfficeFilterProvider storageKey="ti_godmode_office">
      <GodModeInner monthParam={monthParam} setMonthParam={setMonthParam} />
    </OfficeFilterProvider>
  );
}

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
const fmtShort = (n: number) =>
  Math.abs(n) >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(1)}M`
    : Math.abs(n) >= 1_000
      ? `$${Math.round(n / 1_000)}K`
      : `$${Math.round(n)}`;
/** Floored: the hero must never claim 100% while dollars are still out. */
const fmtPctFloor = (p: number | null) => (p === null ? "—" : `${Math.floor(p * 100)}%`);
const fmtPct = (p: number | null) => (p === null ? "—" : `${Math.round(p * 100)}%`);
const fmtCount = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const relTime = (iso: string | null): string => {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins) || mins < 0) return "just now";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const COLLECTION_COLUMNS =
  "monday_item_id, group_title, office, customer_name, planned_amount, actual_amount, " +
  "anticipated_date, collected_date, status, milestone, payment_type";

type CollectionRow = {
  monday_item_id: string;
  group_title: string | null;
  office: string | null;
  customer_name: string | null;
  planned_amount: number;
  actual_amount: number;
  anticipated_date: string | null;
  collected_date: string | null;
  status: string | null;
  milestone: string | null;
  payment_type: string | null;
};

type TrendRow = {
  collection_month: string;
  planned_amount: number;
  actual_amount: number;
  office: string | null;
  anticipated_date: string | null;
  collected_date: string | null;
};

// The axis definitions and semantics live here, behind each panel's ⓘ —
// seven permanent caption paragraphs were glance killers (v3 audit).
const GOD_GLOSSARY: GlossarySections = [
  {
    heading: "The three money axes (they never match)",
    terms: [
      ["Vault", "Collections-board dollars — what customers were scheduled to pay vs what landed"],
      [
        "Book",
        "The official Sales Report (Shark Tank parity) plus just-sold cards awaiting a report row",
      ],
      [
        "Field volume",
        "Confirmed-lead dollars net of WCC cancels — the canvasser pay axis; matches neither board",
      ],
    ],
  },
  {
    heading: "Vault fine print",
    terms: [
      ["Pace", "Projected month from the typical completion curve of the last 12 months"],
      ["MoM / YoY", "Matched spans — this month THROUGH TODAY vs the same days of that month"],
      ["Slip", "Median days between a payment's scheduled date and the day it landed"],
      ["Coverage", "Next month's board total vs target — a floor; the board is still filling"],
    ],
  },
  {
    heading: "Field semantics",
    terms: [
      ["Funnel days", "Generated/Confirmed count by submission day; Sits/Sales by block day"],
      ["Field leads", "Leads called in from the field; Next day = confirmed for tomorrow"],
      ["Vans", "The log-day snapshot — a mid-month van move counts where they actually were"],
      ["$/door", `Doors tracked since ${DOORS_TRACKED_SINCE} — earlier months have no door data`],
      ["QR/Internet", "Marketing leads aren't mirrored into the app yet — Monday board only"],
    ],
  },
  {
    heading: "Crew fine print",
    terms: [
      ["Canvasser pay", "The pay engine's month total for canvassers — NOT total company labor"],
      ["Contribution", "Collected × (1 − job-cost %) − office payroll, from your typed inputs"],
      ["Field cost/sale", "Canvasser pay ÷ field sales this month"],
    ],
  },
];

/** Section shell: skeleton until ready, then one-shot staggered reveal. */
function Reveal({
  ready,
  i,
  skeleton,
  className,
  children,
}: {
  ready: boolean;
  i: number;
  skeleton: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  if (!ready) return <div className={cn("min-w-0", className)}>{skeleton}</div>;
  return (
    <div
      className={cn("min-w-0 section-enter", className)}
      style={reduced ? undefined : { animationDelay: `${i * 70}ms` }}
    >
      {children}
    </div>
  );
}

function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="arcade-card p-5 space-y-3">
      <ArcadeSkeleton className="h-4 w-40" />
      {Array.from({ length: rows }, (_, i) => (
        <ArcadeSkeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

type PageResult = PromiseLike<{ data: unknown[] | null; error: unknown }>;
type PageBuilder = (
  from: number,
  to: number,
) => PageResult & { abortSignal: (signal: AbortSignal) => PageResult };

/** Paged PostgREST walk past the silent 1,000-row cap, abort-signal wired
 *  (the CloseKombat zombie-fetch lesson). The result is cast to T[] — the
 *  select strings are hand-matched to the row types beside each query. */
function paged<T>(build: PageBuilder) {
  return async ({ signal }: { signal?: AbortSignal }) => {
    const PAGE = 1000;
    const all: T[] = [];
    for (let from = 0; ; from += PAGE) {
      const builder = build(from, from + PAGE - 1);
      const { data, error } = await (signal ? builder.abortSignal(signal) : builder);
      if (error) throw error;
      all.push(...((data ?? []) as T[]));
      if (!data || data.length < PAGE) break;
    }
    return all;
  };
}

function GodModeInner({
  monthParam,
  setMonthParam,
}: {
  monthParam: string | null;
  setMonthParam: (m: string) => void;
}) {
  const { realRole, user } = useAuth();
  const qc = useQueryClient();
  const reduced = usePrefersReducedMotion();
  const { office, matches } = useOfficeFilter();
  const officeOrAll = office === "All" ? undefined : office;

  // --- Month engine (LA calendar, URL-backed) ---
  const todayISO = laTodayISO();
  const monthStart = monthParam ?? laMonthStartISO();
  const monthEnd = addDaysISO(nextMonthStartISO(monthStart), -1);
  const isCurrentMonth = monthStart === laMonthStartISO();
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
    dateFromISO(monthStart),
  );
  const shiftMonth = (delta: 1 | -1) =>
    setMonthParam(
      delta > 0 ? nextMonthStartISO(monthStart) : monthStartISO(addDaysISO(monthStart, -1)),
    );

  // --- Collections: this month's payment rows ---
  const collectionsQuery = useQuery({
    queryKey: ["report_collections", monthStart],
    queryFn: paged<CollectionRow>((from, to) =>
      supabase
        .from("report_collections")
        .select(COLLECTION_COLUMNS)
        .eq("collection_month", monthStart)
        .order("monday_item_id")
        .range(from, to),
    ),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
  const vault = useMemo(
    () => aggregateCollections(collectionsQuery.data ?? [], { office: officeOrAll, todayISO }),
    [collectionsQuery.data, officeOrAll, todayISO],
  );
  const curve = useMemo(
    () =>
      buildCashCurve(collectionsQuery.data ?? [], {
        monthStart,
        monthEnd,
        todayISO,
        office: officeOrAll,
      }),
    [collectionsQuery.data, monthStart, monthEnd, todayISO, officeOrAll],
  );

  // Next month's board feeds the forward outlook + coverage (current month).
  const nextMonth = nextMonthStartISO(monthStart);
  const nextMonthQuery = useQuery({
    queryKey: ["report_collections", nextMonth],
    enabled: isCurrentMonth,
    queryFn: paged<CollectionRow>((from, to) =>
      supabase
        .from("report_collections")
        .select(COLLECTION_COLUMNS)
        .eq("collection_month", nextMonth)
        .order("monday_item_id")
        .range(from, to),
    ),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
  const forward = useMemo(
    () =>
      isCurrentMonth
        ? buildForwardOutlook([...(collectionsQuery.data ?? []), ...(nextMonthQuery.data ?? [])], {
            todayISO,
            office: officeOrAll,
          })
        : null,
    [isCurrentMonth, collectionsQuery.data, nextMonthQuery.data, todayISO, officeOrAll],
  );

  // 13 months of slim rows WITH both dates: trend bars, matched-span
  // deltas, the completion curve, slip stats, and outstanding aging.
  const trendStart = `${Number(monthStart.slice(0, 4)) - 1}-${monthStart.slice(5, 7)}-01`;
  const trendQuery = useQuery({
    queryKey: ["report_collections", "trend", monthStart],
    queryFn: paged<TrendRow>((from, to) =>
      supabase
        .from("report_collections")
        .select(
          "collection_month, planned_amount, actual_amount, office, anticipated_date, collected_date",
        )
        .gte("collection_month", trendStart)
        .lte("collection_month", monthStart)
        .order("monday_item_id")
        .range(from, to),
    ),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
  const trendOffice = useMemo(
    () =>
      (trendQuery.data ?? []).filter((r) => officeOrAll === undefined || r.office === officeOrAll),
    [trendQuery.data, officeOrAll],
  );
  const trend = useMemo(
    () => monthlyCollectionsTrend(trendQuery.data ?? [], { office: officeOrAll }),
    [trendQuery.data, officeOrAll],
  );
  const trendByMonth = useMemo(() => new Map(trend.map((t) => [t.month, t])), [trend]);
  const sparkMonths = useMemo(() => {
    const months: string[] = [];
    let m = monthStart;
    for (let i = 0; i < 12; i++) {
      months.unshift(m);
      m = monthStartISO(addDaysISO(m, -1));
    }
    return months;
  }, [monthStart]);

  // MATCHED-SPAN deltas (v3 bug fix): this month THROUGH TODAY vs the same
  // day-span of the prior month / last year — never MTD vs a full month.
  const dayOfMonth = isCurrentMonth ? Number(todayISO.slice(8, 10)) : 31;
  const prevMonthStart = monthStartISO(addDaysISO(monthStart, -1));
  const prevMonthSpan = useMemo(() => {
    const rows = trendOffice.filter((r) => r.collection_month === prevMonthStart);
    return rows.length > 0 ? matchedSpanCollected(rows, prevMonthStart, dayOfMonth) : null;
  }, [trendOffice, prevMonthStart, dayOfMonth]);
  const yoySpan = useMemo(() => {
    const rows = trendOffice.filter((r) => r.collection_month === trendStart);
    return rows.length > 0 ? matchedSpanCollected(rows, trendStart, dayOfMonth) : null;
  }, [trendOffice, trendStart, dayOfMonth]);

  // Completion-curve pace: collections are lumpy milestone payments —
  // straight-line whipsaws early in the month; the 12-month median
  // completion curve says what % is typically banked by day N.
  const completion = useMemo(
    () => buildCompletionCurve(trendOffice.filter((r) => r.collection_month !== monthStart)),
    [trendOffice, monthStart],
  );

  // Speed of cash: median slip this month vs last; aging on EVERYTHING
  // outstanding across the loaded 13 months + next month's board.
  const slipNow = useMemo(
    () => slipStats(trendOffice.filter((r) => r.collection_month === monthStart)),
    [trendOffice, monthStart],
  );
  const slipPrev = useMemo(
    () => slipStats(trendOffice.filter((r) => r.collection_month === prevMonthStart)),
    [trendOffice, prevMonthStart],
  );
  const aging = useMemo(
    () =>
      agingBuckets(
        [
          ...trendOffice,
          ...(nextMonthQuery.data ?? []).filter(
            (r) => officeOrAll === undefined || r.office === officeOrAll,
          ),
        ],
        todayISO,
      ),
    [trendOffice, nextMonthQuery.data, officeOrAll, todayISO],
  );

  // --- Target + annual goal (editable; fail soft pre-migration) ---
  const targetQuery = useQuery({
    queryKey: ["company_targets"],
    queryFn: async () => {
      const { data, error } = await supabase.from("company_targets").select("*").maybeSingle();
      if (error) return null; // table/column not applied yet
      return data;
    },
    staleTime: 60_000,
  });
  const target = useMemo(() => {
    const t = targetQuery.data;
    if (!t) return null;
    if (office === "San Diego") return t.sd_target ?? null;
    if (office === "Orange County") return t.oc_target ?? null;
    return t.monthly_collected_target;
  }, [targetQuery.data, office]);
  const annualGoal =
    (targetQuery.data as { annual_goal?: number } | null)?.annual_goal ?? 100_000_000;
  const saveTarget = useMutation({
    mutationFn: async (value: number) => {
      const patch =
        office === "San Diego"
          ? { sd_target: value }
          : office === "Orange County"
            ? { oc_target: value }
            : { monthly_collected_target: value };
      const { error } = await supabase.from("company_targets").update(patch).eq("id", true);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Target updated");
      qc.invalidateQueries({ queryKey: ["company_targets"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save target"),
  });

  const pace = useMemo(() => {
    const daysInMonth = curve.days.length || 30;
    const day = Math.max(1, Math.min(daysInMonth, dayOfMonth));
    const straight = (vault.collected / day) * daysInMonth;
    const projected = !isCurrentMonth
      ? vault.collected
      : completion
        ? projectFromCurve(vault.collected, day, completion)
        : straight;
    return {
      projected,
      annualized: projected * 12,
      pctOfTarget: target ? vault.collected / target : null,
      curveBased: isCurrentMonth && completion !== null,
    };
  }, [curve.days.length, dayOfMonth, isCurrentMonth, vault.collected, target, completion]);

  // Coverage: next month's booked floor vs target (board still filling).
  const coverage = useMemo(() => {
    if (!isCurrentMonth || target === null) return null;
    const booked = (nextMonthQuery.data ?? [])
      .filter((r) => officeOrAll === undefined || r.office === officeOrAll)
      .reduce((s, r) => s + r.planned_amount, 0);
    return { booked, pct: booked / target };
  }, [isCurrentMonth, target, nextMonthQuery.data, officeOrAll]);

  // --- Close Kombat month book (shared constants from PR #275) ---
  const fetchStart = addDaysISO(monthStart, -SAVE_LINK_PAD_DAYS);
  const fetchEnd = addDaysISO(monthEnd, SAVE_LINK_PAD_DAYS);
  const cardsQuery = useQuery({
    queryKey: ["block_cards", fetchStart, fetchEnd],
    queryFn: paged<BlockCard>((from, to) =>
      supabase
        .from("block_cards")
        .select(CARD_COLUMNS)
        .gte("card_date", fetchStart)
        .lte("card_date", fetchEnd)
        .order("monday_item_id")
        .range(from, to),
    ),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
  const bookYear = Number(monthStart.slice(0, 4));
  const reportQuery = useQuery({
    queryKey: ["report_sales", bookYear],
    queryFn: paged<ReportSaleRow>((from, to) =>
      supabase
        .from("report_sales")
        .select(
          "monday_item_id, office, report_month, date_sold, sale_amt, cancel_amt, wcc, sales_count, reps, customer_name, phone",
        )
        .gte("report_month", `${bookYear}-01-01`)
        .lte("report_month", `${bookYear}-12-31`)
        .order("monday_item_id")
        .range(from, to),
    ),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
  const pendingCheck = useMemo(
    () => buildPendingReportCheck(reportQuery.data ?? []),
    [reportQuery.data],
  );
  const officeCards = useMemo(
    () => (cardsQuery.data ?? []).filter((c) => matches(c.office_location)),
    [cardsQuery.data, matches],
  );
  const kombat = useMemo(() => {
    const { totals } = aggregateCloseKombat(
      officeCards,
      { start: monthStart, end: monthEnd },
      { pendingReport: pendingCheck },
    );
    const f = filterReportRows(reportQuery.data ?? [], { month: monthStart, office: officeOrAll });
    const agg = aggregateReportYear(f.rows);
    const grossBook = agg.totals.revenue + agg.totals.cancelAmt;
    return {
      totals,
      bookRevenue: Math.round((agg.totals.revenue + totals.pendingRevenue) * 100) / 100,
      cancelAmt: agg.totals.cancelAmt,
      cancelPctOfBook: grossBook > 0 ? agg.totals.cancelAmt / grossBook : null,
      officeBlind: f.officeBlind,
    };
  }, [officeCards, reportQuery.data, monthStart, monthEnd, officeOrAll, pendingCheck]);
  // Book by month (whole loaded year): strip, cancel trend + sparkline.
  const bookTrend = useMemo(() => {
    const by = new Map<string, { revenue: number; cancel: number }>();
    for (const r of reportQuery.data ?? []) {
      if (officeOrAll && r.office !== null && r.office !== officeOrAll) continue;
      const slot = by.get(r.report_month) ?? { revenue: 0, cancel: 0 };
      slot.revenue += r.sale_amt;
      slot.cancel += r.cancel_amt;
      by.set(r.report_month, slot);
    }
    return [...by.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, ...v }));
  }, [reportQuery.data, officeOrAll]);
  const cancelPrev3 = useMemo(() => {
    const prior = bookTrend.filter((b) => b.month < monthStart).slice(-3);
    const rev = prior.reduce((s, b) => s + b.revenue, 0);
    const can = prior.reduce((s, b) => s + b.cancel, 0);
    return rev + can > 0 ? can / (rev + can) : null;
  }, [bookTrend, monthStart]);
  const cancelPctSeries = useMemo(
    () =>
      bookTrend.map((b) => {
        const gross = b.revenue + b.cancel;
        return gross > 0 ? (b.cancel / gross) * 100 : 0;
      }),
    [bookTrend],
  );
  const kombatRace = useMemo(() => {
    const monthRows = (reportQuery.data ?? []).filter((r) => r.report_month === monthStart);
    if (monthRows.length > 0 && monthRows.every((r) => r.office === null)) return null;
    const win = { start: monthStart, end: monthEnd };
    const lanes = OFFICE_LOCATIONS.map((o) => {
      const book = aggregateReportYear(monthRows.filter((r) => r.office === o)).totals.revenue;
      const pending = aggregateCloseKombat(
        (cardsQuery.data ?? []).filter((c) => (c.office_location ?? DEFAULT_OFFICE) === o),
        win,
        { pendingReport: pendingCheck },
      ).totals.pendingRevenue;
      return { office: o as string, amount: Math.round((book + pending) * 100) / 100 };
    });
    if (monthRows.length === 0 && lanes.every((l) => l.amount === 0)) return null;
    return lanes;
  }, [reportQuery.data, cardsQuery.data, monthStart, monthEnd, pendingCheck]);

  // --- Ground game (dispatch axis) ---
  const dispatchQuery = useQuery({
    queryKey: ["god_mode", "dispatch", monthStart],
    queryFn: () =>
      getDispatchProduction({
        data: {
          log_start: monthStart,
          log_end: monthEnd,
          vol_start: laMidnightUtcISO(monthStart),
          vol_end: laMidnightUtcISO(nextMonthStartISO(monthStart)),
        },
      }),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
  const ground = useMemo(() => {
    const d = dispatchQuery.data;
    if (!d) return null;
    const results = office === "All" ? d.results : (d.officeResults[office] ?? {});
    const volume = office === "All" ? d.volume : (d.officeVolume[office] ?? {});
    const cancels = office === "All" ? d.cancels : (d.officeCancels[office] ?? {});
    const cancelledVol = office === "All" ? d.cancelledVol : (d.officeCancelledVol[office] ?? {});
    const sumR = (f: (r: DispatchResults) => number) =>
      Object.values(results).reduce((s, r) => s + f(r), 0);
    const sumMap = (m: Record<string, number>) => Object.values(m).reduce((s, n) => s + n, 0);
    return {
      doors: sumR((r) => r.drs),
      talks: sumR((r) => r.tlk),
      leads: sumR((r) => r.lds),
      sits: sumR((r) => r.sit + r.sal),
      sales: sumR((r) => r.sal),
      volume: sumMap(volume),
      cancels: sumMap(cancels),
      cancelledVol: sumMap(cancelledVol),
    };
  }, [dispatchQuery.data, office]);

  // --- Lead funnel inputs (daily_metrics) + top-van concentration ---
  const leadMetricsQuery = useQuery({
    queryKey: ["god_mode", "lead_metrics", monthStart],
    queryFn: paged<{
      id: string;
      canvasser_id: string;
      team_id: string | null;
      office_location: string;
      leads_generated: number;
      leads_confirmed: number;
      future: number;
      killed: number;
    }>((from, to) =>
      supabase
        .from("daily_metrics")
        .select(
          "id, canvasser_id, team_id, office_location, leads_generated, leads_confirmed, future, killed",
        )
        .gte("metric_date", monthStart)
        .lte("metric_date", monthEnd)
        .order("id")
        .range(from, to),
    ),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
  const roster = useDispatchRoster();
  const factory = useMemo(() => {
    const rows = (leadMetricsQuery.data ?? []).filter(
      (r) => office === "All" || (r.office_location ?? DEFAULT_OFFICE) === office,
    );
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
    const byVan = new Map<string, number>();
    for (const r of rows) {
      if (r.team_id && r.leads_confirmed > 0) {
        byVan.set(r.team_id, (byVan.get(r.team_id) ?? 0) + r.leads_confirmed);
      }
    }
    return {
      generated: sum((r) => r.leads_generated),
      confirmed: sum((r) => r.leads_confirmed),
      future: sum((r) => r.future),
      killed: sum((r) => r.killed),
      confirmedByVan: byVan,
    };
  }, [leadMetricsQuery.data, office]);

  // --- Rhythm heatmap data ---
  const doorsQuery = useQuery({
    queryKey: ["god_mode", "doors", monthStart],
    queryFn: paged<{
      id: string;
      log_date: string;
      doors_knocked: number | null;
      office_location: string | null;
    }>((from, to) =>
      supabase
        .from("daily_logs")
        .select("id, log_date, doors_knocked, office_location")
        .gte("log_date", monthStart)
        .lte("log_date", monthEnd)
        .order("id")
        .range(from, to),
    ),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });

  // --- Field leads per van (Live Daily Action semantics; PR #278) ---
  const fieldLeadsQuery = useQuery({
    queryKey: ["god_mode", "field_leads", monthStart],
    queryFn: paged<{
      id: string;
      canvasser_id: string | null;
      team_id: string | null;
      log_date: string;
      office_location: string | null;
      leads_called_in: number | null;
      next_days: number | null;
      future_leads: number | null;
    }>((from, to) =>
      supabase
        .from("daily_logs")
        .select(
          "id, canvasser_id, team_id, log_date, office_location, leads_called_in, next_days, future_leads",
        )
        .gte("log_date", monthStart)
        .lte("log_date", monthEnd)
        .order("id")
        .range(from, to),
    ),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
  const vans = useDispatchVans();
  const [fieldWindowRaw, setFieldWindowRaw] = useState<"today" | "month" | null>(null);
  const fieldWindow: "today" | "month" = isCurrentMonth ? (fieldWindowRaw ?? "today") : "month";
  const fieldLeads = useMemo(() => {
    type VanRow = {
      key: string;
      name: string;
      color: string | null;
      leads: number;
      nextDay: number;
      future: number;
    };
    const rows = (fieldLeadsQuery.data ?? []).filter(
      (r) =>
        (office === "All" || (r.office_location ?? DEFAULT_OFFICE) === office) &&
        (fieldWindow === "month" || r.log_date === todayISO),
    );
    const vanById = new Map((vans.data ?? []).map((v) => [v.id, v]));
    const byVan = new Map<string, VanRow>();
    const totals = { leads: 0, nextDay: 0, future: 0 };
    for (const r of rows) {
      const leads = r.leads_called_in ?? 0;
      const nextDay = r.next_days ?? 0;
      const future = r.future_leads ?? 0;
      if (leads === 0 && nextDay === 0 && future === 0) continue;
      const key = r.team_id ?? "none";
      const van = r.team_id ? vanById.get(r.team_id) : undefined;
      const slot =
        byVan.get(key) ??
        ({
          key,
          name: van?.name ?? "No van",
          color: van?.color ?? null,
          leads: 0,
          nextDay: 0,
          future: 0,
        } as VanRow);
      slot.leads += leads;
      slot.nextDay += nextDay;
      slot.future += future;
      byVan.set(key, slot);
      totals.leads += leads;
      totals.nextDay += nextDay;
      totals.future += future;
    }
    return {
      totals,
      vans: [...byVan.values()].sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name)),
    };
  }, [fieldLeadsQuery.data, vans.data, office, fieldWindow, todayISO]);

  const [heatMetric, setHeatMetric] = useState<"cash" | "sold" | "doors">("cash");
  const [receiptsDay, setReceiptsDay] = useState<string | null>(null);
  const heatDays: HeatDay[] = useMemo(() => {
    const rows = (collectionsQuery.data ?? []).filter(
      (r) => officeOrAll === undefined || r.office === officeOrAll,
    );
    const byDay = new Map<string, number>();
    const dueByDay = new Set<string>();
    const count = (iso: string | null, v: number, m: Map<string, number>) => {
      if (iso !== null && v > 0) m.set(iso, (m.get(iso) ?? 0) + v);
    };
    if (heatMetric === "cash") {
      for (const r of rows) {
        count(r.collected_date, r.actual_amount, byDay);
        if (
          r.anticipated_date !== null &&
          r.anticipated_date >= todayISO &&
          r.planned_amount - r.actual_amount > 0
        ) {
          dueByDay.add(r.anticipated_date);
        }
      }
    } else if (heatMetric === "sold") {
      for (const c of cardsQuery.data ?? []) {
        if (!matches(c.office_location)) continue;
        if (c.card_date === null || c.card_date < monthStart || c.card_date > monthEnd) continue;
        if (cardOutcome(c) !== "sold") continue;
        count(c.card_date, c.sale_price ?? 0, byDay);
      }
    } else {
      for (const l of doorsQuery.data ?? []) {
        if (office !== "All" && (l.office_location ?? DEFAULT_OFFICE) !== office) continue;
        count(l.log_date, l.doors_knocked ?? 0, byDay);
      }
    }
    return curve.days.map((iso) => ({
      iso,
      value: byDay.get(iso) ?? 0,
      untracked: heatMetric === "doors" && iso < DOORS_TRACKED_SINCE,
      dueHint: heatMetric === "cash" && dueByDay.has(iso),
    }));
  }, [
    heatMetric,
    collectionsQuery.data,
    cardsQuery.data,
    doorsQuery.data,
    curve.days,
    matches,
    office,
    officeOrAll,
    monthStart,
    monthEnd,
    todayISO,
  ]);

  // --- This-week + momentum inputs: one slim 28-day daily_logs window ---
  const recentStart = addDaysISO(todayISO, -27);
  const recentLogsQuery = useQuery({
    queryKey: ["god_mode", "recent_logs", todayISO],
    enabled: isCurrentMonth,
    queryFn: paged<{
      id: string;
      canvasser_id: string | null;
      team_id: string | null;
      log_date: string;
      office_location: string | null;
      leads_called_in: number | null;
      doors_knocked: number | null;
      demos_sits: number | null;
      sales: number | null;
    }>((from, to) =>
      supabase
        .from("daily_logs")
        .select(
          "id, canvasser_id, team_id, log_date, office_location, leads_called_in, doors_knocked, demos_sits, sales",
        )
        .gte("log_date", recentStart)
        .lte("log_date", todayISO)
        .order("id")
        .range(from, to),
    ),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
  const recentCancelsQuery = useQuery({
    queryKey: ["god_mode", "recent_cancels", todayISO],
    enabled: isCurrentMonth,
    queryFn: paged<{ id: string; sale_amount: number | null; sale_cancelled_at: string }>(
      (from, to) =>
        supabase
          .from("leads")
          .select("id, sale_amount, sale_cancelled_at")
          .not("sale_cancelled_at", "is", null)
          .gte("sale_cancelled_at", laMidnightUtcISO(recentStart))
          .order("id")
          .range(from, to),
    ),
    staleTime: 5 * 60_000,
  });

  // This-week strip: Mon–Sun week, every tile vs the SAME ELAPSED SPAN of
  // last week (Mon-through-same-weekday — never full-vs-partial week).
  const week = useMemo(() => {
    if (!isCurrentMonth) return null;
    const wkStart = weekStartOfISO(todayISO);
    const spans = {
      cur: { start: wkStart, end: todayISO },
      prev: { start: addDaysISO(wkStart, -7), end: addDaysISO(todayISO, -7) },
    };
    const inSpan = (d: string | null, s: { start: string; end: string }) =>
      d !== null && d >= s.start && d <= s.end;
    const logs = (recentLogsQuery.data ?? []).filter(
      (r) => office === "All" || (r.office_location ?? DEFAULT_OFFICE) === office,
    );
    const logSum = (s: { start: string; end: string }, f: (r: (typeof logs)[number]) => number) =>
      logs.filter((r) => inSpan(r.log_date, s)).reduce((acc, r) => acc + f(r), 0);
    // Collected by the day it landed, across the loaded boards (a week can
    // straddle two months' boards — trend holds ≤ this month, next covers it).
    const colRows = [
      ...trendOffice,
      ...(nextMonthQuery.data ?? []).filter(
        (r) => officeOrAll === undefined || r.office === officeOrAll,
      ),
    ];
    const colSum = (s: { start: string; end: string }) =>
      colRows.filter((r) => inSpan(r.collected_date, s)).reduce((a, r) => a + r.actual_amount, 0);
    // Sold by Date Sold on the book, plus just-sold pending at Block price.
    const bookRows = (reportQuery.data ?? []).filter(
      (r) => officeOrAll === undefined || r.office === null || r.office === officeOrAll,
    );
    const soldSum = (s: { start: string; end: string }) =>
      bookRows.filter((r) => inSpan(r.date_sold, s)).reduce((a, r) => a + r.sale_amt, 0) +
      aggregateCloseKombat(
        officeCards,
        { start: s.start, end: s.end },
        { pendingReport: pendingCheck },
      ).totals.pendingRevenue;
    // Cancels by the moment WCC killed them (leads axis — exact timing).
    const cancelRows = recentCancelsQuery.data ?? [];
    const cancelSum = (s: { start: string; end: string }) =>
      cancelRows
        .filter((r) => inSpan(laDateISO(new Date(r.sale_cancelled_at)), s))
        .reduce((a, r) => a + (r.sale_amount ?? 0), 0);
    const tile = (cur: number, prev: number) => ({ cur, prev });
    return {
      collected: tile(colSum(spans.cur), colSum(spans.prev)),
      sold: tile(soldSum(spans.cur), soldSum(spans.prev)),
      leads: tile(
        logSum(spans.cur, (r) => r.leads_called_in ?? 0),
        logSum(spans.prev, (r) => r.leads_called_in ?? 0),
      ),
      doors: tile(
        logSum(spans.cur, (r) => r.doors_knocked ?? 0),
        logSum(spans.prev, (r) => r.doors_knocked ?? 0),
      ),
      sits: tile(
        logSum(spans.cur, (r) => r.demos_sits ?? 0),
        logSum(spans.prev, (r) => r.demos_sits ?? 0),
      ),
      cancels: tile(cancelSum(spans.cur), cancelSum(spans.prev)),
    };
  }, [
    isCurrentMonth,
    todayISO,
    recentLogsQuery.data,
    recentCancelsQuery.data,
    trendOffice,
    nextMonthQuery.data,
    reportQuery.data,
    officeCards,
    pendingCheck,
    office,
    officeOrAll,
  ]);

  // Momentum: SLOPE, not standings — trailing 14d vs the prior 14d.
  const momentum = useMemo(() => {
    if (!isCurrentMonth) return null;
    const winA = { start: addDaysISO(todayISO, -13), end: todayISO };
    const winB = { start: addDaysISO(todayISO, -27), end: addDaysISO(todayISO, -14) };
    const repsOf = (w: { start: string; end: string }) =>
      new Map(aggregateCloseKombat(officeCards, w).reps.map((r) => [r.rep, r]));
    const a = repsOf(winA);
    const b = repsOf(winB);
    type RepMove = { name: string; from: number; to: number; sitsA: number };
    const repMoves: RepMove[] = [];
    for (const [name, ra] of a) {
      const rb = b.get(name);
      if (!rb) continue;
      const sitsA = ra.pm + ra.sold;
      const sitsB = rb.pm + rb.sold;
      // Min 6 resulted sits in EACH window or the rate is a coin flip.
      if (sitsA < 6 || sitsB < 6) continue;
      repMoves.push({ name, from: rb.sold / sitsB, to: ra.sold / sitsA, sitsA });
    }
    repMoves.sort((x, y) => y.to - y.from - (x.to - x.from));
    const logs = (recentLogsQuery.data ?? []).filter(
      (r) => office === "All" || (r.office_location ?? DEFAULT_OFFICE) === office,
    );
    const vanById = new Map((vans.data ?? []).map((v) => [v.id, v]));
    type VanAgg = { leads: number; days: Set<string> };
    const vanWin = (w: { start: string; end: string }) => {
      const m = new Map<string, VanAgg>();
      for (const r of logs) {
        if (!r.team_id || r.log_date < w.start || r.log_date > w.end) continue;
        const active = (r.leads_called_in ?? 0) + (r.doors_knocked ?? 0) + (r.demos_sits ?? 0) > 0;
        if (!active) continue;
        const slot = m.get(r.team_id) ?? { leads: 0, days: new Set<string>() };
        slot.leads += r.leads_called_in ?? 0;
        slot.days.add(r.log_date);
        m.set(r.team_id, slot);
      }
      return m;
    };
    const va = vanWin(winA);
    const vb = vanWin(winB);
    type VanMove = { name: string; color: string | null; from: number; to: number };
    const vanMoves: VanMove[] = [];
    for (const [id, cur] of va) {
      const prev = vb.get(id);
      // Min 5 active days per window — a dark week isn't a slope.
      if (!prev || cur.days.size < 5 || prev.days.size < 5) continue;
      vanMoves.push({
        name: vanById.get(id)?.name ?? "Van",
        color: vanById.get(id)?.color ?? null,
        from: prev.leads / prev.days.size,
        to: cur.leads / cur.days.size,
      });
    }
    vanMoves.sort((x, y) => y.to / Math.max(y.from, 0.1) - x.to / Math.max(x.from, 0.1));
    return { repMoves, vanMoves };
  }, [isCurrentMonth, todayISO, officeCards, recentLogsQuery.data, vans.data, office]);

  // --- Risk: fires-later sensors (all from data already on the page) ---
  const mix = useMemo(
    () =>
      financingMix(
        (collectionsQuery.data ?? []).filter(
          (r) => officeOrAll === undefined || r.office === officeOrAll,
        ),
      ),
    [collectionsQuery.data, officeOrAll],
  );
  const threeMonths = useMemo(() => {
    const m1 = prevMonthStart;
    const m2 = monthStartISO(addDaysISO(m1, -1));
    return new Set([monthStart, m1, m2]);
  }, [monthStart, prevMonthStart]);
  const closerShare = useMemo(() => {
    const rows = (reportQuery.data ?? []).filter(
      (r) =>
        threeMonths.has(r.report_month) &&
        (officeOrAll === undefined || r.office === null || r.office === officeOrAll),
    );
    const agg = aggregateReportYear(rows);
    return topShare(
      agg.reps.map((r) => ({ name: r.rep, amount: r.revenue })),
      agg.totals.revenue,
      2,
    );
  }, [reportQuery.data, threeMonths, officeOrAll]);
  const vanShare = useMemo(() => {
    const total = [...factory.confirmedByVan.values()].reduce((s, n) => s + n, 0);
    let topName = null as string | null;
    let top = 0;
    const vanById = new Map((vans.data ?? []).map((v) => [v.id, v]));
    for (const [id, n] of factory.confirmedByVan) {
      if (n > top) {
        top = n;
        topName = vanById.get(id)?.name ?? "Van";
      }
    }
    return { share: total > 0 ? top / total : 0, name: topName };
  }, [factory.confirmedByVan, vans.data]);

  // --- Crew + alerts ---
  const clockQuery = useQuery({
    queryKey: ["god_mode", "clock", todayISO],
    queryFn: () => getClockPresence({ data: { dates: [todayISO] } }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const flaggedQuery = useQuery({
    queryKey: ["god_mode", "flagged_punches"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const [cnt, oldest] = await Promise.all([
        supabase
          .from("time_entries")
          .select("id", { count: "exact", head: true })
          .eq("needs_correction", true)
          .is("voided_at", null),
        supabase
          .from("time_entries")
          .select("log_date")
          .eq("needs_correction", true)
          .is("voided_at", null)
          .order("log_date", { ascending: true })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cnt.error) throw cnt.error;
      return { count: cnt.count ?? 0, oldest: oldest.data?.log_date ?? null };
    },
  });
  const pendingLeadsQuery = useQuery({
    queryKey: ["god_mode", "pending_leads_count"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending");
      if (error) throw error;
      return count ?? 0;
    },
  });
  // Last COMPLETED Mon–Sun week — the run that should exist and be approved
  // by now (PayrollLedger's own default week; identical key + fetch).
  const payrollWeek = addDaysISO(weekStartOfISO(todayISO), -7);
  const payrollRunQuery = useQuery({
    queryKey: ["payroll-run", payrollWeek],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_runs")
        .select("id, week_start, status, created_at, approved_at")
        .eq("week_start", payrollWeek)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
  });
  const clawbackQuery = useQuery({
    queryKey: ["payroll-clawback-outstanding"],
    queryFn: async () => {
      const { data, error } = await supabase.from("commission_clawback_outstanding").select("*");
      if (error) throw error;
      return data ?? [];
    },
  });
  const dojoPending = usePendingDojoCount();

  // What Changed — one deviation engine, two outlets (the 6:45am push
  // digest is the other; both read the same server computation).
  const whatChangedQuery = useQuery({
    queryKey: ["god_mode", "what_changed"],
    enabled: isCurrentMonth,
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
    queryFn: () => getWhatChanged(),
  });

  const activeIds = useMemo(
    () =>
      (roster.data?.profiles ?? [])
        .filter(
          (p) => p.is_active !== false && !p.is_placeholder && !isLeadSourceName(p.display_name),
        )
        .map((p) => p.id)
        .sort(),
    [roster.data],
  );
  const laborQuery = useQuery({
    queryKey: ["god_mode", "labor", monthStart, activeIds.length],
    enabled: activeIds.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const results = await fetchMonthlyPaychecksChunked(monthStart, activeIds);
      let total = 0;
      let paid = 0;
      for (const r of results) {
        if (r.paycheck && r.paycheck.total_pay > 0) {
          total += r.paycheck.total_pay;
          paid += 1;
        }
      }
      return { total: Math.round(total * 100) / 100, paid };
    },
  });

  // --- Costs (hand-entered) → honest contribution; fail soft pre-migration ---
  const costsQuery = useQuery({
    queryKey: ["company_costs", monthStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("company_costs")
        .select("*")
        .eq("month", monthStart);
      if (error) return null; // table not applied yet
      return data ?? [];
    },
    staleTime: 60_000,
  });
  const contribution = useMemo(() => {
    const rows = costsQuery.data;
    if (!rows || rows.length === 0) return null;
    const lanes = rows
      .filter((c) => officeOrAll === undefined || c.office === officeOrAll)
      .map((c) => {
        const lane = vault.byOffice.find((o) => o.office === c.office);
        const collected = lane?.collected ?? 0;
        const contrib = collected * (1 - (c.cogs_pct ?? 0)) - (c.office_payroll ?? 0);
        return { office: c.office, collected, contrib: Math.round(contrib) };
      });
    const collected = lanes.reduce((s, l) => s + l.collected, 0);
    const contrib = lanes.reduce((s, l) => s + l.contrib, 0);
    return { lanes, collected, contrib, margin: collected > 0 ? contrib / collected : null };
  }, [costsQuery.data, vault.byOffice, officeOrAll]);
  const [costsOpen, setCostsOpen] = useState(false);
  const saveCosts = useMutation({
    mutationFn: async (input: { office: string; cogs_pct: number; office_payroll: number }) => {
      const { error } = await supabase
        .from("company_costs")
        .upsert({ month: monthStart, ...input }, { onConflict: "month,office" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Costs saved");
      qc.invalidateQueries({ queryKey: ["company_costs"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save costs"),
  });

  // --- Path to the goal: lever sensitivities from live rates ---
  const baselineQuery = useQuery({
    queryKey: ["funnel", "baseline"],
    staleTime: 15 * 60_000,
    queryFn: () => getFunnelBaseline(),
  });
  const levers = useMemo(() => {
    const b = baselineQuery.data;
    if (!b) return null;
    const { eraDoors, eraConfirmed, confirmed, sits, sales } = b.split;
    if (eraDoors <= 0 || confirmed <= 0 || sits <= 0 || sales <= 0) return null;
    const leadPerDoor = eraConfirmed / eraDoors;
    const sitRate = sits / confirmed;
    const closeRate = sales / sits;
    const threeMoRows = (reportQuery.data ?? []).filter((r) => threeMonths.has(r.report_month));
    const agg = aggregateReportYear(threeMoRows);
    const gross3 = agg.totals.revenue + agg.totals.cancelAmt;
    if (agg.totals.sold <= 0 || gross3 <= 0) return null;
    const grossTicket = gross3 / agg.totals.sold;
    const cancelRate = agg.totals.cancelAmt / gross3;
    const annualSold = agg.totals.sold * 4;
    // Doors/day from the trailing 28 days, era-scoped and active-day based.
    const logs = (recentLogsQuery.data ?? []).filter((r) => r.log_date >= DOORS_TRACKED_SINCE);
    const doorDays = new Set(logs.filter((r) => (r.doors_knocked ?? 0) > 0).map((r) => r.log_date));
    const doors = logs.reduce((s, r) => s + (r.doors_knocked ?? 0), 0);
    const doorsPerDay = doorDays.size > 0 ? doors / doorDays.size : 0;
    const medianVan = median([...factory.confirmedByVan.values()]) ?? 0;
    const result = leverSensitivities({
      annualGoal,
      doorsPerDay,
      workingDaysPerYear: 300,
      leadPerDoor,
      sitRate,
      closeRate,
      grossTicket,
      cancelRate,
      medianVanLeadsPerMonth: medianVan,
      annualSits: annualSold / closeRate,
      annualSold,
      annualGrossBook: gross3 * 4,
    });
    return {
      ...result,
      inputs: { leadPerDoor, sitRate, closeRate, grossTicket, cancelRate, doorsPerDay },
    };
  }, [
    baselineQuery.data,
    reportQuery.data,
    threeMonths,
    recentLogsQuery.data,
    factory.confirmedByVan,
    annualGoal,
  ]);

  // --- Freshness + sync ---
  const collectionsSyncInfo = useQuery({
    queryKey: ["collections_sync_info"],
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: () => getCollectionsSyncInfo(),
  });
  const kombatSyncInfo = useQuery({
    queryKey: ["kombat_sync_info"],
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: () => getKombatSyncInfo(),
  });
  const syncStale = useMemo(() => {
    const ages = [
      collectionsSyncInfo.data?.lastSyncedAt ?? null,
      kombatSyncInfo.data?.lastSyncedAt ?? null,
    ].map((iso) => (iso ? Date.now() - Date.parse(iso) : Infinity));
    return Math.min(...ages) > 60 * 60_000;
  }, [collectionsSyncInfo.data, kombatSyncInfo.data]);
  const invalidateAfterSync = () => {
    qc.invalidateQueries({ queryKey: ["report_collections"] });
    qc.invalidateQueries({ queryKey: ["block_cards"] });
    qc.invalidateQueries({ queryKey: ["report_sales"] });
    qc.invalidateQueries({ queryKey: ["kombat_sync_info"] });
    qc.invalidateQueries({ queryKey: ["collections_sync_info"] });
    qc.invalidateQueries({ queryKey: ["god_mode"] });
    qc.invalidateQueries({ queryKey: ["fleet_dispatch"] });
  };
  const sync = useMutation({
    mutationFn: async () => {
      const [col, blocks] = await Promise.allSettled([
        syncCollections({ data: { scope: "active" } }),
        syncBlockCards({ data: { scope: "active" } }),
      ]);
      return { col, blocks };
    },
    onSuccess: ({ col, blocks }) => {
      if (col.status === "fulfilled") {
        const fetched = col.value.results.reduce((s, r) => s + r.fetched, 0);
        toast.success(`Collections: ${col.value.results.length} board(s) · ${fetched} payments`);
      } else {
        toast.error(
          `Collections sync failed: ${col.reason instanceof Error ? col.reason.message : String(col.reason)}`,
        );
      }
      if (blocks.status === "fulfilled") {
        const fetched = blocks.value.results.reduce((s, r) => s + r.fetched, 0);
        toast.success(`Kombat: ${blocks.value.results.length} board(s) · ${fetched} cards`);
      } else {
        toast.error(
          `Kombat sync failed: ${blocks.reason instanceof Error ? blocks.reason.message : String(blocks.reason)}`,
        );
      }
      invalidateAfterSync();
    },
  });
  const backfill = useMutation({
    mutationFn: () => syncCollections({ data: { scope: "all" } }),
    onSuccess: (res) => {
      const fetched = res.results.reduce((s, r) => s + r.fetched, 0);
      toast.success(`Backfilled ${res.results.length} Collections board(s) · ${fetched} payments`);
      invalidateAfterSync();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Backfill failed"),
  });

  useRealtimeInvalidate({
    channel: "god-mode-live",
    tables: ["report_collections", "block_cards", "report_sales", "daily_metrics", "leads"],
    invalidateKeys: [["report_collections"], ["block_cards"], ["report_sales"], ["god_mode"]],
  });

  // --- VAULT SEALED: once per LA month, current month only ---
  const [sealedFx, setSealedFx] = useState(false);
  const sealed =
    collectionsQuery.isSuccess &&
    !collectionsQuery.isPlaceholderData &&
    vault.anticipated > 0 &&
    vault.collected >= vault.anticipated;
  useEffect(() => {
    if (!sealed || !isCurrentMonth || !user?.id) return;
    const key = `ti_godmode_vault_sealed:v1:${user.id}:${monthStart.slice(0, 7)}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch {
      return; // private mode: skip the ceremony rather than repeat it forever
    }
    rewardToast(`🔒 VAULT SEALED — ${monthLabel} collected in full`);
    if (!reduced) {
      setSealedFx(true);
      const t = setTimeout(() => setSealedFx(false), 3_000);
      return () => clearTimeout(t);
    }
  }, [sealed, isCurrentMonth, user?.id, monthStart, monthLabel, reduced]);

  // --- Map reveal (lazy; separate tiny pins query, NOT the shared cards key) ---
  const [mapOpen, setMapOpen] = useState(false);
  const pinsQuery = useQuery({
    queryKey: ["god_mode", "sold_pins", monthStart],
    enabled: mapOpen,
    queryFn: paged<{
      monday_item_id: string;
      office_location: string | null;
      card_date: string | null;
      sale: string | null;
      bo: string | null;
      ol: string | null;
      rs: string | null;
      pm: string | null;
      wcc: string | null;
      lat: number | null;
      lng: number | null;
    }>((from, to) =>
      supabase
        .from("block_cards")
        .select("monday_item_id, office_location, card_date, sale, bo, ol, rs, pm, wcc, lat, lng")
        .gte("card_date", monthStart)
        .lte("card_date", monthEnd)
        .not("lat", "is", null)
        .order("monday_item_id")
        .range(from, to),
    ),
    staleTime: 5 * 60_000,
  });
  const soldPins = useMemo(
    () =>
      (pinsQuery.data ?? [])
        .filter(
          (c) =>
            matches(c.office_location) &&
            cardOutcome(c) === "sold" &&
            c.lat !== null &&
            c.lng !== null,
        )
        .map((c) => ({
          monday_item_id: c.monday_item_id,
          lat: c.lat as number,
          lng: c.lng as number,
          office_location: c.office_location,
        })),
    [pinsQuery.data, matches],
  );

  // Count-up money (gated on isSuccess so mount animates 0 → value).
  const heroMoney = useCountUp(collectionsQuery.isSuccess ? vault.collected : 0, reduced);
  const bookMoney = useCountUp(reportQuery.isSuccess ? kombat.bookRevenue : 0, reduced);
  const groundMoney = useCountUp(dispatchQuery.isSuccess ? (ground?.volume ?? 0) : 0, reduced);

  const [heroRef, heroInView] = useInView<HTMLDivElement>();
  const [editTarget, setEditTarget] = useState(false);
  const [targetDraft, setTargetDraft] = useState("");
  const [glossaryOpen, setGlossaryOpen] = useState(false);

  if (realRole && realRole !== "owner") {
    return (
      <div className="p-4">
        <ArcadeCard>
          <div className="text-sm text-muted-foreground">God Mode is owners-only.</div>
        </ArcadeCard>
      </div>
    );
  }

  // --- Alert rail: every fire-now item, aged, escalated, worst first ---
  const flaggedOldestDays =
    flaggedQuery.data?.oldest != null ? daysBetween(flaggedQuery.data.oldest, todayISO) : null;
  const payrollDaysLate = Math.max(0, daysBetween(addDaysISO(payrollWeek, 7), todayISO));
  const alerts: Array<{
    key: string;
    label: string;
    sub?: string;
    to?: string;
    tone: "destructive" | "warning";
  }> = [];
  if (vault.overdueCount > 0) {
    alerts.push({
      key: "overdue",
      label: `${vault.overdueCount} payment${vault.overdueCount === 1 ? "" : "s"} overdue`,
      sub: `${fmtMoney(vault.overdueAmount)} past its date — receipts below`,
      tone: "destructive",
    });
  }
  if ((flaggedQuery.data?.count ?? 0) > 0) {
    alerts.push({
      key: "punches",
      label: `${flaggedQuery.data!.count} flagged punch${flaggedQuery.data!.count === 1 ? "" : "es"}${
        flaggedOldestDays !== null && flaggedOldestDays > 0 ? ` · oldest ${flaggedOldestDays}d` : ""
      }`,
      sub: "Time clock review queue",
      to: "/dashboard?tab=timesheets",
      // Escalation ladder: 3+ days unworked turns the queue red.
      tone: flaggedOldestDays !== null && flaggedOldestDays >= 3 ? "destructive" : "warning",
    });
  }
  if (payrollRunQuery.isSuccess && (payrollRunQuery.data?.status ?? "none") !== "approved") {
    alerts.push({
      key: "payroll",
      label:
        payrollRunQuery.data == null ? "Last week's payroll: no run" : "Last week's payroll: draft",
      sub: `Due Monday${payrollDaysLate > 0 ? ` — ${payrollDaysLate}d late` : ""}`,
      to: "/dashboard?tab=payroll",
      tone: payrollDaysLate >= 2 ? "destructive" : "warning",
    });
  }
  // Fires-later sensors promoted to fires-now when they cross the line.
  if (mix.topLenderShare > 0.5 && mix.topLenderLabel) {
    alerts.push({
      key: "lender",
      label: `${mix.topLenderLabel} carries ${fmtPct(mix.topLenderShare)} of collections`,
      sub: "One lender's credit box is your month",
      tone: "destructive",
    });
  }
  if (
    kombat.cancelPctOfBook !== null &&
    cancelPrev3 !== null &&
    kombat.cancelPctOfBook - cancelPrev3 >= 0.05
  ) {
    alerts.push({
      key: "cancelspike",
      label: `Cancels ${(kombat.cancelPctOfBook * 100).toFixed(1)}% of book vs ${(cancelPrev3 * 100).toFixed(1)}% avg`,
      sub: `${fmtMoney(kombat.cancelAmt)} walking — see the book panel`,
      tone: "destructive",
    });
  }
  if (coverage !== null && coverage.pct < 0.5) {
    alerts.push({
      key: "coverage",
      label: `Next month booked at ${fmtPctFloor(coverage.pct)} of target`,
      sub: `${fmtShort(coverage.booked)} on the board — a floor, but a low one`,
      tone: "warning",
    });
  }
  if ((clawbackQuery.data?.length ?? 0) > 0) {
    alerts.push({
      key: "clawbacks",
      label: `${clawbackQuery.data!.length} clawback${clawbackQuery.data!.length === 1 ? "" : "s"} open`,
      sub: fmtMoney(
        clawbackQuery.data!.reduce(
          (s: number, r: { outstanding: number | null }) => s + Math.abs(r.outstanding ?? 0),
          0,
        ),
      ),
      to: "/dashboard?tab=payroll",
      tone: "warning",
    });
  }
  if ((pendingLeadsQuery.data ?? 0) > 0) {
    alerts.push({
      key: "desk",
      label: `${pendingLeadsQuery.data} lead${pendingLeadsQuery.data === 1 ? "" : "s"} at the desk`,
      sub: "Waiting on confirmation",
      to: "/confirmation-desk",
      tone: "warning",
    });
  }
  if (dojoPending > 0) {
    alerts.push({
      key: "dojo",
      label: `${dojoPending} dojo review${dojoPending === 1 ? "" : "s"}`,
      to: "/confirmation-desk",
      tone: "warning",
    });
  }
  alerts.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "destructive" ? -1 : 1));

  const vaultDim = collectionsQuery.isPlaceholderData;
  const bookDim = reportQuery.isPlaceholderData || cardsQuery.isPlaceholderData;
  const funnelStages = [
    { label: "Generated", value: factory.generated },
    { label: "Confirmed", value: factory.confirmed },
    { label: "Sits", value: ground?.sits ?? 0 },
    { label: "Sales", value: ground?.sales ?? 0 },
  ];

  // Panel status rules (the header protocol): every dot is EARNED.
  const heroStatus: PanelStatus =
    vault.overdueAmount > 0 ? "alert" : curve.delta < 0 ? "warn" : "good";
  const kombatStatus: PanelStatus =
    kombat.cancelPctOfBook !== null && cancelPrev3 !== null
      ? kombat.cancelPctOfBook - cancelPrev3 >= 0.05
        ? "alert"
        : kombat.cancelPctOfBook > cancelPrev3
          ? "warn"
          : "good"
      : "good";
  const groundStatus: PanelStatus =
    factory.killed > factory.confirmed
      ? "warn"
      : ground &&
          ground.volume > 0 &&
          ground.cancelledVol / (ground.volume + ground.cancelledVol) > 0.1
        ? "warn"
        : "good";
  const fieldStatus: PanelStatus =
    fieldWindow === "today" &&
    (clockQuery.data?.openNow.length ?? 0) > 0 &&
    fieldLeads.totals.leads === 0
      ? "alert"
      : fieldWindow === "today" && fieldLeads.totals.leads > 0 && fieldLeads.totals.nextDay === 0
        ? "warn"
        : "good";
  const receiptsStatus: PanelStatus =
    vault.overdueCount > 0
      ? "alert"
      : vault.byStatus.some((s) => s.status.toLowerCase() === "partial collected")
        ? "warn"
        : "good";

  const infoBtn = (
    <button
      type="button"
      aria-label="What these numbers mean"
      onClick={() => setGlossaryOpen(true)}
      className="text-muted-foreground/60 hover:text-neon transition-colors"
    >
      <CircleHelp className="h-3.5 w-3.5" />
    </button>
  );

  return (
    <div className="p-4 pb-20 space-y-3 max-w-6xl mx-auto">
      {/* ── Header: identity + sync (one row) ── */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 flex items-center gap-2 font-display text-base md:text-2xl uppercase tracking-widest text-neon">
          <Eye className="w-5 h-5 shrink-0" />
          God Mode
        </h1>
        {isCurrentMonth && (
          <span className="inline-flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest text-victory [text-shadow:none]">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-victory opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-victory" />
            </span>
            Live
          </span>
        )}
        <div className="ml-auto relative">
          <NeonButton
            tone="turf-cyan"
            disabled={sync.isPending || backfill.isPending}
            onClick={() => sync.mutate()}
            title={`Collections synced ${relTime(collectionsSyncInfo.data?.lastSyncedAt ?? null)} · Kombat synced ${relTime(kombatSyncInfo.data?.lastSyncedAt ?? null)} — re-pulls prev/current/next Collections boards + active Block boards`}
          >
            <RefreshCw className={cn("w-3.5 h-3.5", sync.isPending && "animate-spin")} />
            <span className="hidden sm:inline">Sync boards</span>
            <span className="sm:hidden">Sync</span>
          </NeonButton>
          {syncStale && (
            <span
              aria-label="Data over an hour old"
              className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-warning"
            />
          )}
        </div>
      </div>

      {/* ── Month stepper + office filter ── */}
      <div className="flex flex-wrap items-center gap-2">
        <NeonButton onClick={() => shiftMonth(-1)} aria-label="Previous month" className="px-2.5">
          <ChevronLeft className="w-4 h-4" />
        </NeonButton>
        <RangeChip>{monthLabel}</RangeChip>
        <NeonButton
          onClick={() => shiftMonth(1)}
          aria-label="Next month"
          className="px-2.5"
          disabled={isCurrentMonth}
        >
          <ChevronRight className="w-4 h-4" />
        </NeonButton>
        {!isCurrentMonth && (
          <NeonButton onClick={() => setMonthParam(laMonthStartISO())}>Jump to now</NeonButton>
        )}
        <OfficeFilterToggle className="ml-auto" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        {/* ── 1 · VAULT HERO ─────────────────────────────────────── */}
        <Reveal
          ready={!collectionsQuery.isPending}
          i={0}
          className="lg:col-span-8"
          skeleton={
            <div className="arcade-card p-5 md:p-7 space-y-4">
              <ArcadeSkeleton className="h-3 w-44" />
              <ArcadeSkeleton className="h-12 w-72 max-w-full" />
              <ArcadeSkeleton className="h-4 w-full" />
              <ArcadeSkeleton className="h-36 w-full" />
            </div>
          }
        >
          {collectionsQuery.isError ? (
            <QueryStateCard
              pending={false}
              what="collections"
              onRetry={() => collectionsQuery.refetch()}
            />
          ) : (collectionsQuery.data?.length ?? 0) === 0 ? (
            <ArcadeCard className="p-5 space-y-3">
              <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                The Vault · {monthLabel}
              </div>
              <p className="text-sm text-muted-foreground">
                No collections rows for {monthLabel} yet — run a sync, or backfill every month once.
              </p>
              <div className="flex flex-wrap gap-2">
                <NeonButton
                  tone="turf-cyan"
                  disabled={sync.isPending || backfill.isPending}
                  onClick={() => sync.mutate()}
                >
                  Sync this month
                </NeonButton>
                <NeonButton
                  disabled={sync.isPending || backfill.isPending}
                  onClick={() => backfill.mutate()}
                >
                  <RefreshCw className={cn("w-3.5 h-3.5", backfill.isPending && "animate-spin")} />
                  Backfill all months
                </NeonButton>
              </div>
            </ArcadeCard>
          ) : (
            <div
              ref={heroRef}
              className={cn(
                "relative overflow-hidden rounded-xl border border-victory/30 p-5 md:p-7 vault-hero transition-opacity",
                sealedFx && "vault-sealed",
                vaultDim && "opacity-50",
              )}
            >
              <div className="absolute inset-0 scanlines opacity-[0.06] pointer-events-none" />
              <div className="relative">
                <div className="flex items-center gap-2 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{
                      background:
                        heroStatus === "alert"
                          ? "var(--destructive)"
                          : heroStatus === "warn"
                            ? "var(--warning)"
                            : "var(--victory)",
                    }}
                  />
                  Cash · collected {monthLabel}
                  {infoBtn}
                </div>
                <div
                  className={cn(
                    "mt-2 font-display tabular-nums text-victory break-words leading-none text-[clamp(1.9rem,7vw,4rem)] transition-transform",
                    heroMoney.bump && !reduced && "scale-[1.02]",
                  )}
                >
                  {fmtMoney(heroMoney.display)}
                </div>

                {/* VERDICT LINE — the judgment, one glance (v3 audit §1) */}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm tabular-nums">
                  <span
                    className={cn(
                      "font-medium",
                      curve.delta >= 0 ? "text-victory [text-shadow:none]" : "text-destructive",
                    )}
                  >
                    {curve.delta >= 0 ? "▲" : "▼"} {fmtShort(Math.abs(curve.delta))}{" "}
                    {curve.delta >= 0 ? "ahead of" : "behind"} plan
                  </span>
                  {editTarget ? (
                    <form
                      className="inline-flex items-center gap-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const v = Number(targetDraft.replace(/[^0-9.]/g, ""));
                        if (Number.isFinite(v) && v > 0) saveTarget.mutate(v);
                        setEditTarget(false);
                      }}
                    >
                      <input
                        autoFocus
                        inputMode="numeric"
                        value={targetDraft}
                        onChange={(e) => setTargetDraft(e.target.value)}
                        placeholder={String(target ?? 2000000)}
                        className="w-28 rounded border border-neon/40 bg-background px-2 py-1 text-base md:text-xs tabular-nums"
                        aria-label={`Monthly target (${office})`}
                      />
                      <NeonButton type="submit" className="min-h-9 px-2">
                        Set
                      </NeonButton>
                    </form>
                  ) : pace.pctOfTarget !== null ? (
                    <button
                      type="button"
                      title="Tap to edit the target"
                      onClick={() => {
                        setTargetDraft(String(target ?? ""));
                        setEditTarget(true);
                      }}
                      className={cn(
                        "min-h-11 md:min-h-0 font-display text-[10px] uppercase tracking-widest underline decoration-dotted underline-offset-4 decoration-neon/60",
                        pace.pctOfTarget >= 1
                          ? "text-victory [text-shadow:none]"
                          : "text-foreground",
                      )}
                    >
                      {fmtPctFloor(pace.pctOfTarget)} of {fmtShort(target ?? 0)} target
                    </button>
                  ) : targetQuery.isSuccess && targetQuery.data === null ? (
                    <span className="text-[10px] text-muted-foreground">
                      target table not applied yet
                    </span>
                  ) : null}
                  <DeltaChip now={vault.collected} base={prevMonthSpan} label="MoM" />
                  <DeltaChip now={vault.collected} base={yoySpan} label="YoY" />
                  <span className="text-[11px] text-muted-foreground">
                    pace {fmtShort(pace.projected)}
                    {pace.curveBased ? "" : "*"} → {fmtShort(pace.annualized)}/yr
                  </span>
                </div>

                <NeonBar
                  pct={heroInView ? (vault.pct ?? 0) : 0}
                  accent="var(--victory)"
                  tall
                  sheen
                />
                <div className="mt-1.5 text-xs text-muted-foreground tabular-nums">
                  of {fmtMoney(vault.anticipated)} anticipated ·{" "}
                  <span className="text-foreground">{fmtMoney(vault.outstanding)} still out</span>
                  {vault.overdueCount > 0 && (
                    <>
                      {" · "}
                      <span className="text-destructive">
                        {fmtMoney(vault.overdueAmount)} overdue
                      </span>
                    </>
                  )}
                </div>

                {/* SPEED OF CASH + COVERAGE (v3: velocity is the growth cap) */}
                <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                  {slipNow.medianDays !== null && (
                    <>
                      Median slip <span className="text-foreground">{slipNow.medianDays}d</span>
                      {slipPrev.medianDays !== null && (
                        <span
                          className={cn(
                            "ml-1 font-display text-[10px] uppercase tracking-widest",
                            slipNow.medianDays <= slipPrev.medianDays
                              ? "text-victory [text-shadow:none]"
                              : "text-warning",
                          )}
                        >
                          {slipNow.medianDays <= slipPrev.medianDays ? "▼" : "▲"} vs{" "}
                          {slipPrev.medianDays}d
                        </span>
                      )}
                      {" · "}
                    </>
                  )}
                  aging <span className="text-foreground">{fmtShort(aging.b0_30)}</span> 0-30 /{" "}
                  <span className={aging.b31_60 > 0 ? "text-warning" : "text-foreground"}>
                    {fmtShort(aging.b31_60)}
                  </span>{" "}
                  31-60 /{" "}
                  <span className={aging.b61 > 0 ? "text-destructive" : "text-foreground"}>
                    {fmtShort(aging.b61)}
                  </span>{" "}
                  61+
                </div>
                {coverage !== null && (
                  <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                    Next month booked{" "}
                    <span className="text-foreground">{fmtShort(coverage.booked)}</span> ={" "}
                    <span
                      className={cn(
                        coverage.pct >= 0.8
                          ? "text-victory [text-shadow:none]"
                          : coverage.pct >= 0.5
                            ? "text-foreground"
                            : "text-warning",
                      )}
                    >
                      {fmtPctFloor(coverage.pct)} of target
                    </span>{" "}
                    <span className="text-muted-foreground/70">(floor — board still filling)</span>
                  </div>
                )}

                <div className="mt-4">
                  <CashCurve curve={curve} dimmed={vaultDim} showDelta={false} />
                </div>

                {/* 12-month strip — tap a bar to time-travel */}
                <div className="mt-4">
                  <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                    Last 12 months
                  </div>
                  <Sparkbars
                    className="mt-1"
                    height={36}
                    accent="var(--victory)"
                    points={sparkMonths.map((m) => trendByMonth.get(m)?.collected ?? 0)}
                    track={sparkMonths.map((m) => trendByMonth.get(m)?.anticipated ?? 0)}
                    labels={sparkMonths}
                    onPick={(i) => setMonthParam(sparkMonths[i])}
                  />
                </div>
              </div>
            </div>
          )}
        </Reveal>

        {/* ── 2 · ALERT RAIL + RISK ──────────────────────────────── */}
        <Reveal
          ready={!collectionsQuery.isPending}
          i={1}
          className="lg:col-span-4"
          skeleton={<PanelSkeleton rows={3} />}
        >
          <div className="space-y-2">
            {isCurrentMonth && (whatChangedQuery.data?.items.length ?? 0) > 0 && (
              <>
                <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground px-1">
                  What changed
                </div>
                {whatChangedQuery.data!.items.map((d) => (
                  <Link
                    key={d.key}
                    to={d.to.split("?")[0]}
                    search={searchOf(d.to)}
                    className="block w-full rounded-lg border border-neon/30 bg-neon/5 p-3 text-left hover:border-neon/60 transition-colors"
                  >
                    <div className="text-xs text-foreground/90">{d.line}</div>
                    {d.sub && (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">{d.sub}</div>
                    )}
                  </Link>
                ))}
              </>
            )}
            <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground px-1">
              Needs you{alerts.length > 0 ? ` · ${alerts.length}` : ""}
            </div>
            {alerts.length === 0 ? (
              <ArcadeCard className="flex items-center gap-3 p-4">
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-victory opacity-50 [animation-duration:3s]" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-victory" />
                </span>
                <div>
                  <div className="font-display text-[10px] uppercase tracking-widest text-victory [text-shadow:none]">
                    All clear
                  </div>
                  <div className="text-xs text-muted-foreground">Nothing needs you right now.</div>
                </div>
              </ArcadeCard>
            ) : (
              alerts.map((a, i) => {
                const body = (
                  <>
                    <div
                      className={cn(
                        "font-display text-[10px] uppercase tracking-widest",
                        a.tone === "destructive" ? "text-destructive" : "text-warning",
                      )}
                    >
                      {a.label}
                    </div>
                    {a.sub && <div className="mt-0.5 text-xs text-muted-foreground">{a.sub}</div>}
                  </>
                );
                const cls = cn(
                  "block w-full rounded-lg border p-3 text-left transition-colors",
                  a.tone === "destructive"
                    ? "border-destructive/50 bg-destructive/5"
                    : "border-warning/40 bg-warning/5",
                  i === 0 &&
                    a.tone === "destructive" &&
                    !reduced &&
                    "animate-[suspend-pulse_2.6s_ease-in-out_infinite]",
                  a.to && "hover:border-neon/50",
                );
                return a.to ? (
                  <Link key={a.key} to={a.to.split("?")[0]} search={searchOf(a.to)} className={cls}>
                    {body}
                  </Link>
                ) : (
                  <div key={a.key} className={cls}>
                    {body}
                  </div>
                );
              })
            )}

            {/* RISK — fires later. Its one job is to stay boring. */}
            <div className="pt-1 text-[10px] font-display uppercase tracking-widest text-muted-foreground px-1">
              Risk · fires later
            </div>
            <ArcadeCard className="p-3 space-y-2">
              <RiskRow
                label={
                  mix.topLenderLabel
                    ? `${mix.topLenderLabel} share of collections`
                    : "Lender concentration"
                }
                pct={mix.topLenderShare}
                amber={0.4}
                red={0.55}
              />
              <RiskRow
                label={`Top 2 closers share of book (3-mo)${closerShare.names.length ? ` · ${closerShare.names.join(" + ")}` : ""}`}
                pct={closerShare.share}
                amber={0.4}
                red={0.55}
              />
              <RiskRow
                label={`Top van share of confirmed leads${vanShare.name ? ` · ${vanShare.name}` : ""}`}
                pct={vanShare.share}
                amber={0.35}
                red={0.5}
              />
            </ArcadeCard>
          </div>
        </Reveal>

        {/* ── 3 · THIS WEEK (matched spans, current month only) ──── */}
        {isCurrentMonth && (
          <Reveal
            ready={!recentLogsQuery.isPending}
            i={2}
            className="lg:col-span-12"
            skeleton={<ArcadeSkeleton className="h-20 w-full" />}
          >
            {week && (
              <div className="grid grid-cols-2 md:grid-cols-6 gap-px rounded-lg overflow-hidden border border-border/40 bg-border/40">
                <WeekCell
                  label="Collected WTD"
                  cur={week.collected.cur}
                  prev={week.collected.prev}
                  money
                />
                <WeekCell label="Sold $ WTD" cur={week.sold.cur} prev={week.sold.prev} money />
                <WeekCell label="Leads WTD" cur={week.leads.cur} prev={week.leads.prev} />
                <WeekCell label="Doors WTD" cur={week.doors.cur} prev={week.doors.prev} />
                <WeekCell label="Sits WTD" cur={week.sits.cur} prev={week.sits.prev} />
                <WeekCell
                  label="Cancelled $ WTD"
                  cur={week.cancels.cur}
                  prev={week.cancels.prev}
                  money
                  badIsUp
                />
              </div>
            )}
          </Reveal>
        )}

        {/* ── 4 · PATH TO THE GOAL (the lever price list) ────────── */}
        <Reveal
          ready={!baselineQuery.isPending && !reportQuery.isPending}
          i={3}
          className="lg:col-span-12"
          skeleton={<PanelSkeleton rows={3} />}
        >
          <PathToGoal
            levers={levers}
            annualGoal={annualGoal}
            contributionMargin={contribution?.margin ?? null}
          />
        </Reveal>

        {/* ── 5 · CLOSE KOMBAT · THE OFFICIAL BOOK ───────────────── */}
        <Reveal
          ready={!reportQuery.isPending && !cardsQuery.isPending}
          i={4}
          className="lg:col-span-7"
          skeleton={<PanelSkeleton rows={4} />}
        >
          <ArcadePanel
            faction="kombat"
            title="Close Kombat · The Book"
            status={kombatStatus}
            info={infoBtn}
            headline={
              kombat.cancelPctOfBook !== null && cancelPrev3 !== null ? (
                <span
                  className={cn(
                    "tabular-nums text-[10px] font-display uppercase tracking-widest",
                    kombat.cancelPctOfBook <= cancelPrev3 ? "text-kombat-gold" : "text-kombat-red",
                  )}
                >
                  cancels {(kombat.cancelPctOfBook * 100).toFixed(1)}%{" "}
                  {kombat.cancelPctOfBook <= cancelPrev3 ? "▼" : "▲"}
                </span>
              ) : undefined
            }
            action={
              <NeonButton tone="kombat-gold" asChild className="min-h-9">
                <Link to="/close-kombat" search={{ tab: "stats" }}>
                  Open Kombat
                </Link>
              </NeonButton>
            }
          >
            {reportQuery.isError || cardsQuery.isError ? (
              <QueryStateCard
                pending={false}
                what="the sales book"
                onRetry={() => {
                  reportQuery.refetch();
                  cardsQuery.refetch();
                }}
              />
            ) : (
              <div className={cn("space-y-3 transition-opacity", bookDim && "opacity-50")}>
                <div>
                  <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                    Book volume{kombat.totals.pendingDeals > 0 ? " · incl pending" : ""}
                  </div>
                  <div className="mt-1 font-display text-2xl md:text-3xl tabular-nums text-kombat-gold">
                    {fmtMoney(bookMoney.display)}
                  </div>
                  {kombat.totals.pendingDeals > 0 && (
                    <div className="text-[11px] text-muted-foreground tabular-nums">
                      incl {fmtMoney(kombat.totals.pendingRevenue)} from{" "}
                      {kombat.totals.pendingDeals} just-sold deal
                      {kombat.totals.pendingDeals === 1 ? "" : "s"} awaiting a report row
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-px rounded-lg overflow-hidden border border-kombat-red/30 bg-kombat-red/20">
                  <ArcadeStatTile
                    flat
                    mono
                    label="Sold"
                    value={fmtCount(kombat.totals.sold)}
                    accent="neon"
                    sub={{
                      label: "Close %",
                      value: fmtPct(kombat.totals.closePct),
                      accent: "muted",
                    }}
                  />
                  <ArcadeStatTile
                    flat
                    mono
                    label="Appts"
                    value={fmtCount(kombat.totals.appts)}
                    accent="muted"
                    sub={{ label: "Sit %", value: fmtPct(kombat.totals.sitPct), accent: "muted" }}
                  />
                  <ArcadeStatTile
                    flat
                    mono
                    label="$/sit"
                    value={
                      kombat.totals.pm + kombat.totals.sold > 0
                        ? fmtShort(kombat.bookRevenue / (kombat.totals.pm + kombat.totals.sold))
                        : "—"
                    }
                    accent="muted"
                  />
                  <ArcadeStatTile
                    flat
                    mono
                    label="Resets"
                    value={`${fmtCount(kombat.totals.reset)}`}
                    accent="muted"
                    sub={{
                      label: "of appts",
                      value: fmtPct(kombat.totals.resetPct),
                      accent: "muted",
                    }}
                  />
                  <ArcadeStatTile
                    flat
                    mono
                    label="No-shows"
                    value={fmtCount(kombat.totals.noShow)}
                    accent="muted"
                    sub={{
                      label: "Office appts",
                      value: fmtCount(kombat.totals.officeAppts),
                      accent: "muted",
                    }}
                  />
                </div>
                {/* Cancels: the bleed — full-width, loud, with its shape */}
                <div className="rounded-lg border border-kombat-red/50 bg-kombat-red/10 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                        Cancelled $
                      </div>
                      <div className="mt-0.5 font-display text-xl md:text-2xl tabular-nums text-kombat-red">
                        {fmtMoney(kombat.cancelAmt)}
                      </div>
                    </div>
                    <div className="text-right text-xs tabular-nums text-muted-foreground">
                      <div>
                        {kombat.cancelPctOfBook !== null
                          ? `${(kombat.cancelPctOfBook * 100).toFixed(1)}% of book`
                          : "—"}
                        {cancelPrev3 !== null && kombat.cancelPctOfBook !== null && (
                          <span
                            className={cn(
                              "ml-2 font-display text-[10px] uppercase tracking-widest",
                              kombat.cancelPctOfBook <= cancelPrev3
                                ? "text-victory [text-shadow:none]"
                                : "text-kombat-red",
                            )}
                          >
                            {kombat.cancelPctOfBook <= cancelPrev3 ? "▼" : "▲"} vs{" "}
                            {(cancelPrev3 * 100).toFixed(1)}% 3-mo avg
                          </span>
                        )}
                      </div>
                      <div>{fmtCount(kombat.totals.cancels)} cancels on cards</div>
                    </div>
                  </div>
                  {cancelPctSeries.length > 1 && (
                    <Sparkbars
                      className="mt-2"
                      height={16}
                      accent="var(--kombat-red)"
                      points={cancelPctSeries}
                      labels={bookTrend.map((b) => b.month)}
                    />
                  )}
                </div>
                {/* Book by month strip */}
                {bookTrend.length > 1 && (
                  <div>
                    <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                      Book by month · {bookYear}
                    </div>
                    <Sparkbars
                      className="mt-1"
                      height={28}
                      accent="var(--kombat-gold)"
                      points={bookTrend.map((b) =>
                        b.month === monthStart
                          ? b.revenue + kombat.totals.pendingRevenue
                          : b.revenue,
                      )}
                      labels={bookTrend.map((b) => b.month)}
                      onPick={(i) => setMonthParam(bookTrend[i].month)}
                    />
                  </div>
                )}
                {kombatRace && (
                  <OfficeLanes lanes={kombatRace} fmt={fmtMoney} gold reduced={reduced} />
                )}
                {kombat.officeBlind && (
                  <p className="text-[10px] text-muted-foreground">
                    This month's book records no offices — money shows combined.
                  </p>
                )}
                {/* Map reveal */}
                <div>
                  <button
                    type="button"
                    onClick={() => setMapOpen((v) => !v)}
                    className="min-h-11 w-full rounded-lg border border-border px-3 text-left text-[10px] font-display uppercase tracking-widest text-neon hover:border-neon/50 transition-colors"
                  >
                    ⬢ Map this month's {fmtCount(kombat.totals.sold)} sales{" "}
                    {mapOpen ? "· hide" : "· show"}
                  </button>
                  {mapOpen && (
                    <div className="mt-2">
                      {pinsQuery.isPending ? (
                        <ArcadeSkeleton className="h-[220px] w-full" />
                      ) : pinsQuery.isError ? (
                        <QueryStateCard
                          pending={false}
                          what="the map"
                          onRetry={() => pinsQuery.refetch()}
                        />
                      ) : (
                        <Suspense fallback={<ArcadeSkeleton className="h-[220px] w-full" />}>
                          <MiniSalesMap pins={soldPins} />
                        </Suspense>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </ArcadePanel>
        </Reveal>

        {/* ── 6 · MOMENTUM (slope, not standings) ────────────────── */}
        <Reveal
          ready={!cardsQuery.isPending && (!isCurrentMonth || !recentLogsQuery.isPending)}
          i={5}
          className="lg:col-span-5"
          skeleton={<PanelSkeleton rows={4} />}
        >
          <MomentumPanel momentum={momentum} />
        </Reveal>

        {/* ── 7 · RHYTHM (calendar heatmap) ──────────────────────── */}
        <Reveal
          ready={!collectionsQuery.isPending}
          i={6}
          className="lg:col-span-5"
          skeleton={<PanelSkeleton rows={5} />}
        >
          <ArcadePanel
            title="Rhythm"
            action={
              <div className="flex gap-1">
                {(
                  [
                    ["cash", "$ In"],
                    ["sold", "Sold"],
                    ["doors", "Doors"],
                  ] as const
                ).map(([k, label]) => (
                  <ArcadePill
                    key={k}
                    size="sm"
                    active={heatMetric === k}
                    onClick={() => setHeatMetric(k)}
                  >
                    {label}
                  </ArcadePill>
                ))}
              </div>
            }
          >
            <CalendarHeatmap
              days={heatDays}
              todayISO={todayISO}
              accent={
                heatMetric === "cash"
                  ? "var(--victory)"
                  : heatMetric === "sold"
                    ? "var(--kombat-gold)"
                    : "var(--turf-cyan)"
              }
              onPick={(d) => {
                if (heatMetric === "cash") setReceiptsDay(d?.iso ?? null);
              }}
              renderReadout={(d) => {
                if (!d) {
                  return heatMetric === "doors" ? (
                    <span>Doors tracked since {DOORS_TRACKED_SINCE}.</span>
                  ) : (
                    <span>Tap a day.</span>
                  );
                }
                if (heatMetric === "cash") {
                  const n = (collectionsQuery.data ?? []).filter(
                    (r) =>
                      r.collected_date === d.iso &&
                      (officeOrAll === undefined || r.office === officeOrAll),
                  ).length;
                  return (
                    <span>
                      {d.iso} · <span className="text-foreground">{fmtMoney(d.value)}</span> banked
                      · {n} payment{n === 1 ? "" : "s"} — receipts below
                    </span>
                  );
                }
                if (heatMetric === "sold") {
                  return (
                    <span>
                      {d.iso} · <span className="text-foreground">{fmtMoney(d.value)}</span> sold
                    </span>
                  );
                }
                return (
                  <span>
                    {d.iso} · <span className="text-foreground">{d.value}</span> doors
                  </span>
                );
              }}
            />
          </ArcadePanel>
        </Reveal>

        {/* ── 8 · GROUND GAME (field funnel + production, one panel) ── */}
        <Reveal
          ready={!dispatchQuery.isPending && !leadMetricsQuery.isPending}
          i={7}
          className="lg:col-span-7"
          skeleton={<PanelSkeleton rows={4} />}
        >
          <ArcadePanel
            title="Ground Game"
            status={groundStatus}
            info={infoBtn}
            action={
              <div className="flex items-center gap-2">
                <NeonButton asChild className="min-h-9">
                  <Link to="/confirmation-desk">
                    Desk{(pendingLeadsQuery.data ?? 0) > 0 ? ` · ${pendingLeadsQuery.data}` : ""}
                  </Link>
                </NeonButton>
                <NeonButton asChild className="min-h-9">
                  <Link to="/dashboard" search={{ tab: "dispatch" }}>
                    Dispatch
                  </Link>
                </NeonButton>
              </div>
            }
          >
            {dispatchQuery.isError ? (
              <QueryStateCard
                pending={false}
                what="field production"
                onRetry={() => dispatchQuery.refetch()}
              />
            ) : ground ? (
              <div
                className={cn(
                  "space-y-3 transition-opacity",
                  dispatchQuery.isPlaceholderData && "opacity-50",
                )}
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FunnelLadder
                    stages={funnelStages}
                    extra={{ future: factory.future, killed: factory.killed }}
                  />
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div>
                        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                          Field volume · net of cancels
                        </div>
                        <div className="mt-1 font-display text-xl md:text-2xl tabular-nums text-foreground">
                          {fmtMoney(groundMoney.display)}
                        </div>
                      </div>
                      {ground.cancels > 0 && (
                        <div className="text-right text-xs tabular-nums text-muted-foreground">
                          <span className="text-destructive">−{fmtMoney(ground.cancelledVol)}</span>{" "}
                          · {ground.cancels} cancel{ground.cancels === 1 ? "" : "s"}
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-px rounded-lg overflow-hidden border border-border/40 bg-border/40">
                      <ArcadeStatTile
                        flat
                        mono
                        label="Doors"
                        value={ground.doors}
                        accent="muted"
                        sub={{
                          label: "$/door*",
                          value: ground.doors > 0 ? fmtShort(ground.volume / ground.doors) : "—",
                          accent: "muted",
                        }}
                      />
                      <ArcadeStatTile flat mono label="Talks" value={ground.talks} accent="muted" />
                      <ArcadeStatTile
                        flat
                        mono
                        label="Leads"
                        value={ground.leads}
                        accent="muted"
                        sub={{
                          label: "$/lead",
                          value: ground.leads > 0 ? fmtShort(ground.volume / ground.leads) : "—",
                          accent: "muted",
                        }}
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground/60">
                      *doors since {DOORS_TRACKED_SINCE.slice(5).replace("-", "/")}
                    </p>
                  </div>
                </div>
              </div>
            ) : null}
          </ArcadePanel>
        </Reveal>

        {/* ── 9 · FIELD LEADS — per van (PR #278) ────────────────── */}
        <Reveal
          ready={!fieldLeadsQuery.isPending}
          i={8}
          className="lg:col-span-5"
          skeleton={<PanelSkeleton rows={4} />}
        >
          <ArcadePanel
            title="Field Leads"
            status={fieldStatus}
            info={infoBtn}
            action={
              <div className="flex items-center gap-1">
                {isCurrentMonth && (
                  <>
                    <ArcadePill
                      size="sm"
                      active={fieldWindow === "today"}
                      onClick={() => setFieldWindowRaw("today")}
                    >
                      Today
                    </ArcadePill>
                    <ArcadePill
                      size="sm"
                      active={fieldWindow === "month"}
                      onClick={() => setFieldWindowRaw("month")}
                    >
                      Month
                    </ArcadePill>
                  </>
                )}
                <NeonButton asChild className="min-h-9">
                  <Link to="/teams">Vans</Link>
                </NeonButton>
              </div>
            }
          >
            {fieldLeadsQuery.isError ? (
              <QueryStateCard
                pending={false}
                what="field leads"
                onRetry={() => fieldLeadsQuery.refetch()}
              />
            ) : (
              <div
                className={cn(
                  "space-y-3 transition-opacity",
                  fieldLeadsQuery.isPlaceholderData && "opacity-50",
                )}
              >
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <div>
                    <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                      Leads {fieldWindow === "today" ? "today" : monthLabel}
                    </div>
                    <div className="mt-0.5 font-mono text-xl tabular-nums text-foreground">
                      {fieldLeads.totals.leads}
                    </div>
                  </div>
                  <div className="text-xs tabular-nums text-muted-foreground">
                    <span className="text-foreground">{fieldLeads.totals.nextDay}</span> next day ·{" "}
                    <span className="text-foreground">{fieldLeads.totals.future}</span> future
                  </div>
                </div>
                {fieldLeads.vans.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No field leads {fieldWindow === "today" ? "yet today" : "this month"}.
                  </p>
                ) : (
                  <div className="min-w-0">
                    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-3 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                      <span>Van</span>
                      <span className="text-right">Leads</span>
                      <span className="text-right">Next day</span>
                      <span className="text-right">Future</span>
                    </div>
                    <div className="mt-1 space-y-1">
                      {fieldLeads.vans.map((v) => (
                        <div
                          key={v.key}
                          className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-x-3 border-t border-border/40 py-1.5"
                        >
                          <span className="min-w-0 truncate text-xs">
                            <span
                              className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                              style={{ background: v.color ?? "var(--muted-foreground)" }}
                            />
                            {v.name}
                          </span>
                          <span className="text-right font-mono text-sm tabular-nums">
                            {v.leads}
                          </span>
                          <span
                            className={cn(
                              "text-right font-mono text-sm tabular-nums",
                              v.nextDay > 0 ? "text-foreground" : "text-muted-foreground/40",
                            )}
                          >
                            {v.nextDay}
                          </span>
                          <span
                            className={cn(
                              "text-right font-mono text-sm tabular-nums",
                              v.future > 0 ? "text-foreground" : "text-muted-foreground/40",
                            )}
                          >
                            {v.future}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </ArcadePanel>
        </Reveal>

        {/* ── 10 · CREW (roster facts + honest money) ────────────── */}
        <Reveal
          ready={roster.isSuccess}
          i={9}
          className="lg:col-span-7"
          skeleton={<PanelSkeleton rows={1} />}
        >
          <ArcadePanel
            title="Crew"
            info={infoBtn}
            action={
              <button
                type="button"
                onClick={() => setCostsOpen((v) => !v)}
                className="min-h-9 text-[10px] font-display uppercase tracking-widest text-neon hover:underline"
              >
                {contribution ? "Edit costs" : "Enter costs"}
              </button>
            }
          >
            <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden border border-border/40 bg-border/40">
              <CrewCell
                to="/crew-map"
                label="On the clock"
                value={clockQuery.data ? String(clockQuery.data.openNow.length) : "…"}
                sub={
                  clockQuery.data
                    ? `${(clockQuery.data.byDate[todayISO] ?? []).length} punched today`
                    : undefined
                }
              />
              <CrewCell
                to="/users"
                label="Active players"
                value={String(activeIds.length)}
                sub={laborQuery.data ? `${laborQuery.data.paid} earned this month` : undefined}
              />
              <CrewCell
                to="/dashboard?tab=payroll"
                label="Canvasser pay"
                value={
                  laborQuery.isSuccess
                    ? fmtMoney(laborQuery.data.total)
                    : laborQuery.isError
                      ? "—"
                      : "…"
                }
                sub={
                  laborQuery.isSuccess && vault.collected > 0
                    ? `${((laborQuery.data.total / vault.collected) * 100).toFixed(1)}% of collected`
                    : "pay engine"
                }
              />
              <CrewCell
                to="/dashboard?tab=payroll"
                label="Field cost / sale"
                value={
                  laborQuery.isSuccess && ground && ground.sales > 0
                    ? fmtMoney(laborQuery.data.total / ground.sales)
                    : "—"
                }
                sub={ground ? `${ground.sales} field sales` : undefined}
              />
            </div>

            {/* Honest margin: typed inputs or an explicit hole — never derived. */}
            <div className="mt-3 text-xs tabular-nums">
              {contribution ? (
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                    Contribution
                  </span>
                  {contribution.lanes.map((l) => (
                    <span key={l.office} className="text-foreground">
                      {l.office === "San Diego" ? "SD" : "OC"}{" "}
                      <span
                        className={cn(
                          l.contrib >= 0 ? "text-victory [text-shadow:none]" : "text-destructive",
                        )}
                      >
                        {fmtShort(l.contrib)}
                      </span>
                    </span>
                  ))}
                  {contribution.margin !== null && (
                    <span className="text-muted-foreground">
                      {Math.round(contribution.margin * 100)}% of collected · before field pay
                    </span>
                  )}
                </div>
              ) : costsQuery.data !== null ? (
                <span className="text-muted-foreground">
                  Margin: not shown — enter {monthLabel}'s job-cost % and office payroll.
                </span>
              ) : null}
            </div>

            {costsOpen && (
              <CostsEditor
                monthLabel={monthLabel}
                existing={costsQuery.data ?? []}
                onSave={(v) => saveCosts.mutate(v)}
                saving={saveCosts.isPending}
              />
            )}
          </ArcadePanel>
        </Reveal>

        {/* ── 11 · RECEIPTS DRAWER ───────────────────────────────── */}
        <Reveal
          ready={!collectionsQuery.isPending}
          i={10}
          className="lg:col-span-12"
          skeleton={<ArcadeSkeleton className="h-12 w-full" />}
        >
          <ReceiptsDrawer
            rows={collectionsQuery.data ?? []}
            office={officeOrAll}
            todayISO={todayISO}
            dayFilter={receiptsDay}
            clearDayFilter={() => setReceiptsDay(null)}
            status={receiptsStatus}
            forward={forward}
          />
        </Reveal>
      </div>

      <GlossarySheet
        open={glossaryOpen}
        onOpenChange={setGlossaryOpen}
        sections={GOD_GLOSSARY}
        title="What God Mode's numbers mean"
      />
    </div>
  );
}

function searchOf(to: string): Record<string, string> | undefined {
  const q = to.split("?")[1];
  return q ? Object.fromEntries(new URLSearchParams(q).entries()) : undefined;
}

/** One this-week cell: value + ▲/▼ vs the same elapsed span last week. */
function WeekCell({
  label,
  cur,
  prev,
  money = false,
  badIsUp = false,
}: {
  label: string;
  cur: number;
  prev: number;
  money?: boolean;
  badIsUp?: boolean;
}) {
  const delta = prev > 0 ? (cur - prev) / prev : null;
  const up = delta !== null && delta >= 0;
  const good = delta === null ? null : badIsUp ? !up : up;
  return (
    <div className="min-w-0 bg-surface px-3 py-2">
      <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground truncate">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-base md:text-lg tabular-nums text-foreground">
        {money ? fmtShort(cur) : cur}
      </div>
      <div
        className={cn(
          "text-[10px] font-display uppercase tracking-widest tabular-nums",
          delta === null
            ? "text-muted-foreground/50"
            : good
              ? "text-victory [text-shadow:none]"
              : "text-destructive",
        )}
      >
        {delta === null
          ? "no basis"
          : `${up ? "▲" : "▼"} ${Math.abs(Math.round(delta * 100))}% vs last wk`}
      </div>
    </div>
  );
}

/** The lever price list: what one unit of each input is worth per year.
 *  Levers multiply — they never add; the drawer says so out loud. */
function PathToGoal({
  levers,
  annualGoal,
  contributionMargin,
}: {
  levers:
    | (ReturnType<typeof leverSensitivities> & {
        inputs: {
          leadPerDoor: number;
          sitRate: number;
          closeRate: number;
          grossTicket: number;
          cancelRate: number;
          doorsPerDay: number;
        };
      })
    | null;
  annualGoal: number;
  contributionMargin: number | null;
}) {
  const [showAssumptions, setShowAssumptions] = useState(false);
  if (!levers) {
    return (
      <ArcadePanel title={`Path to ${fmtShort(annualGoal)}`}>
        <p className="text-xs text-muted-foreground">
          Not enough live data yet to price the levers (needs the 60-day funnel baseline and a
          3-month book).
        </p>
      </ArcadePanel>
    );
  }
  const i = levers.inputs;
  const row = (k: string) => levers.rows.find((r) => r.key === k)!;
  const LEVERS: Array<{ key: string; title: string; detail: string }> = [
    {
      key: "cancel",
      title: `Cancels back to 10% (now ${(i.cancelRate * 100).toFixed(1)}%)`,
      detail: "found money — no new doors, no new hires",
    },
    {
      key: "close",
      title: `Close rate +1pt (now ${(i.closeRate * 100).toFixed(1)}%)`,
      detail: "training, pitch, leadership at the table",
    },
    {
      key: "ticket",
      title: `Average ticket +$1K (now ${fmtShort(i.grossTicket)})`,
      detail: "scope, financing, premium product mix",
    },
    {
      key: "van",
      title: "One more van (at the MEDIAN van's production)",
      detail: "a new van is not your best van",
    },
    {
      key: "doors",
      title: `Doors for ${fmtShort(annualGoal)}: ${Math.round(row("doors").figure)}/day (now ~${Math.round(i.doorsPerDay)})`,
      detail: "the brute-force lever — everything else multiplies it",
    },
  ];
  return (
    <ArcadePanel
      title={`Path to ${fmtShort(annualGoal)}`}
      headline={
        <span className="tabular-nums text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          model {fmtShort(levers.modeledNetPerYear)}/yr
        </span>
      }
      action={
        <button
          type="button"
          onClick={() => setShowAssumptions((v) => !v)}
          className="min-h-9 text-[10px] font-display uppercase tracking-widest text-neon hover:underline"
        >
          {showAssumptions ? "Hide assumptions" : "Assumptions"}
        </button>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-px rounded-lg overflow-hidden border border-border/40 bg-border/40">
        {LEVERS.map((l) => {
          const r = row(l.key);
          const dollars = l.key === "doors" ? r.dollars : r.dollars;
          return (
            <div key={l.key} className="min-w-0 bg-surface px-3 py-2.5">
              <div
                className={cn(
                  "font-display text-lg tabular-nums [text-shadow:none]",
                  l.key === "doors"
                    ? dollars > 0
                      ? "text-warning"
                      : "text-victory"
                    : dollars > 0
                      ? "text-victory"
                      : "text-muted-foreground/50",
                )}
              >
                {l.key === "doors"
                  ? dollars > 0
                    ? `${fmtShort(dollars)} gap`
                    : "goal met"
                  : dollars > 0
                    ? `+${fmtShort(dollars)}/yr`
                    : "—"}
              </div>
              <div className="mt-1 text-xs text-foreground/90">{l.title}</div>
              <div className="text-[10px] text-muted-foreground">{l.detail}</div>
              {contributionMargin !== null && l.key !== "doors" && dollars > 0 && (
                <div className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">
                  ≈ {fmtShort(dollars * contributionMargin)}/yr contribution
                </div>
              )}
            </div>
          );
        })}
      </div>
      {showAssumptions && (
        <div className="mt-3 space-y-1 text-[11px] text-muted-foreground tabular-nums">
          <p>
            Model: doors/day × lead-per-door × sit rate × close rate × gross ticket × (1 − cancel
            rate) × 300 working days. Levers are priced one at a time — they MULTIPLY, they don't
            add.
          </p>
          <p>
            Live inputs: {i.doorsPerDay.toFixed(0)} doors/day (28d, tracked since{" "}
            {DOORS_TRACKED_SINCE}) · {(i.leadPerDoor * 100).toFixed(1)}% lead/door (60d
            pair-matched) · {(i.sitRate * 100).toFixed(0)}% sit · {(i.closeRate * 100).toFixed(0)}%
            close · {fmtShort(i.grossTicket)} gross ticket (3-mo book) ·{" "}
            {(i.cancelRate * 100).toFixed(1)}% cancels.
          </p>
          <p>
            Dollars are NET REVENUE, not profit
            {contributionMargin !== null
              ? ` — contribution lines use your typed ${Math.round(contributionMargin * 100)}% margin`
              : " — enter monthly costs (Crew panel) to see contribution"}
            . Goal is editable on the hero target.
          </p>
        </div>
      )}
    </ArcadePanel>
  );
}

function RiskRow({
  label,
  pct,
  amber,
  red,
}: {
  label: string;
  pct: number;
  amber: number;
  red: number;
}) {
  const tone =
    pct >= red
      ? "text-destructive"
      : pct >= amber
        ? "text-warning"
        : "text-victory [text-shadow:none]";
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="min-w-0 truncate text-muted-foreground">{label}</span>
      <span className={cn("shrink-0 font-mono tabular-nums", tone)}>{fmtPct(pct)}</span>
    </div>
  );
}

function MomentumPanel({
  momentum,
}: {
  momentum: {
    repMoves: Array<{ name: string; from: number; to: number; sitsA: number }>;
    vanMoves: Array<{ name: string; color: string | null; from: number; to: number }>;
  } | null;
}) {
  if (!momentum) {
    return (
      <ArcadePanel title="Momentum">
        <p className="text-xs text-muted-foreground">
          Momentum reads the trailing 14 days — jump to the current month to see it.
        </p>
      </ArcadePanel>
    );
  }
  const reps = momentum.repMoves;
  const vans = momentum.vanMoves;
  const repRows = [...reps.slice(0, 3), ...reps.slice(-3)].filter(
    (r, idx, arr) => arr.findIndex((x) => x.name === r.name) === idx,
  );
  const vanRows = [...vans.slice(0, 2), ...vans.slice(-2)].filter(
    (r, idx, arr) => arr.findIndex((x) => x.name === r.name) === idx,
  );
  return (
    <ArcadePanel
      title="Momentum"
      headline={
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          14d vs prior 14d
        </span>
      }
    >
      <div className="space-y-3">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Closers · close rate
          </div>
          {repRows.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              No rep has 6+ resulted sits in both windows yet.
            </p>
          ) : (
            <div className="mt-1 space-y-1">
              {repRows.map((r) => {
                const up = r.to >= r.from;
                return (
                  <Link
                    key={r.name}
                    to="/close-kombat"
                    search={{ tab: "stats" }}
                    className="flex items-baseline justify-between gap-2 text-xs hover:text-neon transition-colors"
                  >
                    <span className="min-w-0 truncate">
                      <span className={up ? "text-victory [text-shadow:none]" : "text-destructive"}>
                        {up ? "▲" : "▼"}
                      </span>{" "}
                      {r.name}
                    </span>
                    <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                      {Math.round(r.from * 100)}%→
                      <span className="text-foreground">{Math.round(r.to * 100)}%</span> ({r.sitsA}{" "}
                      sits)
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Vans · leads per active day
          </div>
          {vanRows.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              No van has 5+ active days in both windows yet.
            </p>
          ) : (
            <div className="mt-1 space-y-1">
              {vanRows.map((v) => {
                const up = v.to >= v.from;
                return (
                  <Link
                    key={v.name}
                    to="/teams"
                    className="flex items-baseline justify-between gap-2 text-xs hover:text-neon transition-colors"
                  >
                    <span className="min-w-0 truncate">
                      <span
                        className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                        style={{ background: v.color ?? "var(--muted-foreground)" }}
                      />
                      <span className={up ? "text-victory [text-shadow:none]" : "text-destructive"}>
                        {up ? "▲" : "▼"}
                      </span>{" "}
                      {v.name}
                    </span>
                    <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                      {v.from.toFixed(1)}→<span className="text-foreground">{v.to.toFixed(1)}</span>
                      /day
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </ArcadePanel>
  );
}

/** SD vs OC lanes — Office War recipe; crown pulses on the leader only. */
function OfficeLanes({
  lanes,
  fmt,
  gold = false,
  reduced = false,
}: {
  lanes: Array<{ office: string; amount: number }>;
  fmt: (n: number) => string;
  gold?: boolean;
  reduced?: boolean;
}) {
  const visible = lanes.filter((l) => l.office !== "Unassigned" || l.amount > 0);
  const max = Math.max(1, ...visible.map((l) => l.amount));
  const top = Math.max(...visible.map((l) => l.amount));
  const [ref, inView] = useInView<HTMLDivElement>();
  return (
    <div ref={ref} className="space-y-3">
      {visible.map((l) => {
        const leads = l.amount === top && l.amount > 0;
        const lit = gold ? "text-kombat-gold" : "text-foreground";
        return (
          <div key={l.office} className="min-w-0">
            <div className="flex items-baseline justify-between gap-2 text-[10px] font-display uppercase tracking-widest">
              <span
                className={cn(
                  "inline-flex items-center gap-1",
                  leads ? lit : "text-muted-foreground",
                )}
              >
                {l.office}
                {leads && (
                  <Crown
                    className={cn(
                      "h-3 w-3",
                      !reduced && "animate-[pulse-glow_2.8s_ease-in-out_infinite]",
                    )}
                  />
                )}
              </span>
              <span className={cn("tabular-nums", leads ? lit : "text-muted-foreground")}>
                {fmt(l.amount)}
              </span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-surface-elevated overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-700 ease-out"
                style={{
                  width: inView
                    ? `max(${Math.round((l.amount / max) * 100)}%, ${l.amount > 0 ? "6px" : "0px"})`
                    : "0%",
                  background: leads
                    ? gold
                      ? "var(--kombat-gold)"
                      : "var(--victory)"
                    : gold
                      ? "var(--kombat-red)"
                      : "color-mix(in oklab, var(--foreground) 25%, transparent)",
                  boxShadow: leads
                    ? gold
                      ? "0 0 10px var(--kombat-gold)"
                      : "0 0 10px var(--victory)"
                    : undefined,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Funnel with the conversion ladder between stages — the rates ARE the
 *  funnel; the bars are the magnitude backdrop. */
function FunnelLadder({
  stages,
  extra,
}: {
  stages: Array<{ label: string; value: number }>;
  extra?: { future: number; killed: number };
}) {
  const max = Math.max(1, ...stages.map((s) => s.value));
  const [ref, inView] = useInView<HTMLDivElement>();
  const first = stages[0]?.value ?? 0;
  const last = stages[stages.length - 1]?.value ?? 0;
  return (
    <div ref={ref} className="space-y-1">
      {stages.map((s, i) => (
        <div key={s.label} className="min-w-0">
          {i > 0 && (
            <div className="flex justify-end pr-1 text-[10px] text-muted-foreground tabular-nums">
              ↳{" "}
              <span className="ml-1 text-foreground">
                {stages[i - 1].value > 0
                  ? `${Math.round((s.value / stages[i - 1].value) * 100)}%`
                  : "—"}
              </span>
              <span className="ml-1">of {stages[i - 1].label.toLowerCase()}</span>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-2 text-[10px] font-display uppercase tracking-widest">
            <span className="text-muted-foreground">{s.label}</span>
            <span
              className={cn(
                "font-mono text-xs tabular-nums",
                s.value > 0 ? "text-foreground" : "text-muted-foreground/40",
              )}
            >
              {s.value}
            </span>
          </div>
          <div className="mt-0.5 h-2 rounded-full bg-surface-elevated overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700 ease-out"
              style={{
                width: inView
                  ? s.value > 0
                    ? `max(${Math.round((s.value / max) * 100)}%, 3px)`
                    : "0%"
                  : "0%",
                background:
                  i === stages.length - 1
                    ? "var(--victory)"
                    : "color-mix(in oklab, var(--foreground) 25%, transparent)",
                boxShadow: i === stages.length - 1 ? "0 0 8px var(--victory)" : undefined,
              }}
            />
          </div>
        </div>
      ))}
      <div className="pt-1 flex flex-wrap items-baseline gap-x-3 font-display text-[10px] uppercase tracking-widest text-muted-foreground tabular-nums">
        <span>
          {first} generated → {last} sales{" "}
          {last > 0 && <span className="text-foreground">· 1 in {Math.round(first / last)}</span>}
        </span>
        {extra && (
          <span>
            future <span className="text-foreground">{extra.future}</span> · blown out{" "}
            <span className={extra.killed > 0 ? "text-destructive" : "text-foreground"}>
              {extra.killed}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

function CrewCell({
  to,
  label,
  value,
  sub,
}: {
  to: string;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Link
      to={to.split("?")[0]}
      search={searchOf(to)}
      className="block min-w-0 bg-surface px-3 py-2 hover:bg-surface-elevated transition-colors"
    >
      <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-mono text-lg tabular-nums text-foreground break-words">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </Link>
  );
}

/** Two numbers per office per month — the whole cost input. */
function CostsEditor({
  monthLabel,
  existing,
  onSave,
  saving,
}: {
  monthLabel: string;
  existing: Array<{ office: string; cogs_pct: number | null; office_payroll: number | null }>;
  onSave: (v: { office: string; cogs_pct: number; office_payroll: number }) => void;
  saving: boolean;
}) {
  return (
    <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
      {OFFICE_LOCATIONS.map((office) => {
        const row = existing.find((e) => e.office === office);
        return (
          <CostsForm
            key={office}
            office={office}
            monthLabel={monthLabel}
            initialCogs={row?.cogs_pct ?? null}
            initialPayroll={row?.office_payroll ?? null}
            onSave={onSave}
            saving={saving}
          />
        );
      })}
    </div>
  );
}

function CostsForm({
  office,
  monthLabel,
  initialCogs,
  initialPayroll,
  onSave,
  saving,
}: {
  office: string;
  monthLabel: string;
  initialCogs: number | null;
  initialPayroll: number | null;
  onSave: (v: { office: string; cogs_pct: number; office_payroll: number }) => void;
  saving: boolean;
}) {
  const [cogs, setCogs] = useState(
    initialCogs !== null ? String(Math.round(initialCogs * 100)) : "",
  );
  const [payroll, setPayroll] = useState(initialPayroll !== null ? String(initialPayroll) : "");
  return (
    <form
      className="rounded-lg border border-border/40 p-3 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        const c = Number(cogs.replace(/[^0-9.]/g, ""));
        const p = Number(payroll.replace(/[^0-9.]/g, ""));
        if (!Number.isFinite(c) || c <= 0 || c >= 100) {
          toast.error("Job-cost % must be between 0 and 100");
          return;
        }
        if (!Number.isFinite(p) || p < 0) {
          toast.error("Office payroll must be a dollar amount");
          return;
        }
        onSave({ office, cogs_pct: c / 100, office_payroll: p });
      }}
    >
      <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        {office} · {monthLabel}
      </div>
      <label className="block text-[11px] text-muted-foreground">
        Job-cost % of collected
        <input
          inputMode="decimal"
          value={cogs}
          onChange={(e) => setCogs(e.target.value)}
          placeholder="55"
          className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1.5 text-base md:text-xs tabular-nums"
        />
      </label>
      <label className="block text-[11px] text-muted-foreground">
        Office payroll + overhead $
        <input
          inputMode="numeric"
          value={payroll}
          onChange={(e) => setPayroll(e.target.value)}
          placeholder="85000"
          className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1.5 text-base md:text-xs tabular-nums"
        />
      </label>
      <NeonButton type="submit" disabled={saving} className="w-full">
        Save {office === "San Diego" ? "SD" : "OC"}
      </NeonButton>
    </form>
  );
}

// ── Receipts drawer: exceptions first, resolved rows behind a toggle ──────

const stateBadge: Record<ReturnType<typeof rowCollectionState>, { label: string; cls: string }> = {
  collected: { label: "Collected", cls: "text-muted-foreground" },
  partial: { label: "Partial", cls: "text-warning" },
  overdue: { label: "Overdue", cls: "text-destructive" },
  pending: { label: "Pending", cls: "text-muted-foreground" },
};

function StateDot({ state }: { state: ReturnType<typeof rowCollectionState> }) {
  const color =
    state === "overdue"
      ? "var(--destructive)"
      : state === "partial"
        ? "var(--warning)"
        : state === "collected"
          ? "var(--victory)"
          : "var(--muted-foreground)";
  return <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />;
}

function ReceiptsDrawer({
  rows,
  office,
  todayISO,
  dayFilter,
  clearDayFilter,
  status,
  forward,
}: {
  rows: CollectionRow[];
  office: string | undefined;
  todayISO: string;
  dayFilter: string | null;
  clearDayFilter: () => void;
  status: PanelStatus;
  forward: { next7: number; next30: number; overdueBacklog: number } | null;
}) {
  const [open, setOpen] = useState(false);
  const [showCollected, setShowCollected] = useState(false);

  const prepared = useMemo(() => {
    const mine = rows
      .filter((r) => office === undefined || r.office === office)
      .filter((r) => dayFilter === null || r.collected_date === dayFilter)
      .map((r) => ({
        r,
        state: rowCollectionState(r, todayISO),
        daysLate:
          r.anticipated_date !== null && r.anticipated_date < todayISO
            ? daysBetween(r.anticipated_date, todayISO)
            : 0,
      }));
    const rank: Record<string, number> = { overdue: 0, partial: 1, pending: 2, collected: 3 };
    mine.sort(
      (a, b) =>
        (rank[a.state] ?? 9) - (rank[b.state] ?? 9) ||
        (a.r.anticipated_date ?? "9999").localeCompare(b.r.anticipated_date ?? "9999") ||
        (a.r.customer_name ?? "").localeCompare(b.r.customer_name ?? ""),
    );
    const exceptions = mine.filter((x) => x.state !== "collected");
    const resolved = mine.filter((x) => x.state === "collected");
    return { exceptions, resolved };
  }, [rows, office, todayISO, dayFilter]);

  const visible =
    showCollected || dayFilter !== null
      ? [...prepared.exceptions, ...prepared.resolved]
      : prepared.exceptions;
  const total = prepared.exceptions.length + prepared.resolved.length;

  // A day tap from the heatmap pops the drawer open.
  useEffect(() => {
    if (dayFilter !== null) setOpen(true);
  }, [dayFilter]);

  return (
    <ArcadePanel
      title={`Receipts · ${total}`}
      status={status}
      headline={
        forward ? (
          <span className="tabular-nums text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            next cash {fmtShort(forward.next7)}/7d · {fmtShort(forward.next30)}/30d
          </span>
        ) : undefined
      }
      action={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="min-h-11 md:min-h-0 text-[10px] font-display uppercase tracking-widest text-neon hover:underline"
        >
          {open ? "Collapse" : "Open"}
        </button>
      }
    >
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full min-h-11 text-left text-xs text-muted-foreground"
        >
          {prepared.exceptions.length === 0
            ? "Every payment resolved — tap to browse the month's receipts."
            : `${prepared.exceptions.length} payment${prepared.exceptions.length === 1 ? "" : "s"} not yet banked — tap to itemize.`}
        </button>
      ) : (
        <div className="space-y-2">
          {dayFilter !== null && (
            <button
              type="button"
              onClick={clearDayFilter}
              className="rounded-full border border-neon/40 px-3 py-1.5 text-[10px] font-display uppercase tracking-widest text-neon"
            >
              Day {dayFilter} ✕
            </button>
          )}

          {/* Desktop */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  <th className="py-2 pr-2">Customer</th>
                  <th className="py-2 pr-2">Milestone</th>
                  <th className="py-2 pr-2">Type</th>
                  <th className="py-2 pr-2">Office</th>
                  <th className="py-2 pr-2">Due</th>
                  <th className="py-2 pr-2 text-right">Late</th>
                  <th className="py-2 pr-2 text-right">Planned</th>
                  <th className="py-2 pr-2 text-right">Collected</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {visible.map(({ r, state, daysLate }) => (
                  <tr
                    key={r.monday_item_id}
                    className={cn(
                      "border-t border-border/40",
                      state === "overdue" && "bg-destructive/5",
                    )}
                  >
                    <td className="py-2 pr-2 max-w-48 truncate font-sans">
                      {r.customer_name ?? "—"}
                    </td>
                    <td className="py-2 pr-2 text-muted-foreground font-sans">
                      {r.milestone ?? "—"}
                    </td>
                    <td className="py-2 pr-2 text-muted-foreground font-sans">
                      {r.payment_type ?? "—"}
                    </td>
                    <td className="py-2 pr-2 text-muted-foreground">
                      {r.office === "San Diego" ? "SD" : r.office === "Orange County" ? "OC" : "—"}
                    </td>
                    <td
                      className={cn(
                        "py-2 pr-2 tabular-nums",
                        state === "overdue" && "text-destructive",
                      )}
                    >
                      {r.anticipated_date ?? "—"}
                    </td>
                    <td
                      className={cn(
                        "py-2 pr-2 text-right tabular-nums",
                        state === "overdue" ? "text-destructive" : "text-muted-foreground/40",
                      )}
                    >
                      {state !== "collected" && daysLate > 0 ? `${daysLate}d` : ""}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums">
                      {fmtMoney(r.planned_amount)}
                    </td>
                    <td
                      className={cn(
                        "py-2 pr-2 text-right tabular-nums",
                        r.actual_amount > 0
                          ? "text-victory [text-shadow:none]"
                          : "text-muted-foreground/40",
                      )}
                    >
                      {fmtMoney(r.actual_amount)}
                    </td>
                    <td className="py-2 font-sans">
                      <span className="inline-flex items-center gap-1.5 text-[11px]">
                        <StateDot state={state} />
                        <span className={stateBadge[state].cls}>
                          {r.status ?? stateBadge[state].label}
                        </span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile */}
          <MobileCardList>
            {visible.map(({ r, state, daysLate }) => (
              <MobileCard
                key={r.monday_item_id}
                className={cn(state === "overdue" && "border-destructive/50")}
              >
                <MobileCardHeader
                  left={r.customer_name ?? "—"}
                  right={
                    <span className="text-victory [text-shadow:none]">
                      {fmtMoney(r.planned_amount)}
                    </span>
                  }
                />
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="inline-flex items-center gap-1.5">
                    <StateDot state={state} />
                    <span className={stateBadge[state].cls}>
                      {r.status ?? stateBadge[state].label}
                    </span>
                  </span>
                  {state !== "collected" && daysLate > 0 && (
                    <span className="text-destructive">{daysLate}d late</span>
                  )}
                  {r.office && (
                    <span className="text-muted-foreground">
                      {r.office === "San Diego" ? "SD" : "OC"}
                    </span>
                  )}
                </div>
                <MobileStatGrid cols={3}>
                  <MobileStat label="Due" value={r.anticipated_date ?? "—"} />
                  <MobileStat
                    label="Collected"
                    value={fmtMoney(r.actual_amount)}
                    lit="text-victory"
                  />
                  <MobileStat label="Milestone" value={r.milestone ?? "—"} />
                </MobileStatGrid>
              </MobileCard>
            ))}
          </MobileCardList>

          {visible.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Nothing outstanding{dayFilter ? " that day" : ""}.
            </p>
          )}

          {dayFilter === null && prepared.resolved.length > 0 && (
            <button
              type="button"
              onClick={() => setShowCollected((v) => !v)}
              className="min-h-11 md:min-h-0 text-[10px] font-display uppercase tracking-widest text-neon hover:underline"
            >
              {showCollected ? "Hide collected" : `Show ${prepared.resolved.length} collected`}
            </button>
          )}
        </div>
      )}
    </ArcadePanel>
  );
}
