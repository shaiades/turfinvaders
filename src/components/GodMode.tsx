import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Crown, Eye, Pencil, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";
import {
  addDaysISO,
  dateFromISO,
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
  MobileCard,
  MobileCardHeader,
  MobileCardList,
  MobileStat,
  MobileStatGrid,
  NeonBar,
  NeonButton,
  RangeChip,
  Sparkbars,
} from "@/components/arcade";
import { QueryStateCard } from "@/components/QueryStateCard";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { useDispatchRoster } from "@/hooks/useFleetRoster";
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
import {
  aggregateCollections,
  buildCashCurve,
  buildForwardOutlook,
  monthlyCollectionsTrend,
  rowCollectionState,
} from "@/lib/collections";
import { DOORS_TRACKED_SINCE } from "@/lib/funnel";
import {
  getClockPresence,
  getDispatchProduction,
  type DispatchResults,
} from "@/lib/dispatch.functions";
import { fetchMonthlyPaychecksChunked } from "@/lib/paychecks";
import { CashCurve } from "@/components/godmode/CashCurve";
import { CalendarHeatmap, type HeatDay } from "@/components/godmode/CalendarHeatmap";

const MiniSalesMap = lazy(() => import("@/components/godmode/MiniSalesMap"));

/**
 * God Mode v2 — the Command Bridge (owner directive 2026-10-01). One month,
 * every axis, with judgment: pace vs the editable target, forward cash from
 * anticipated dates, trends from 40 months of collections history. Three
 * money axes stay separate and labeled (collections vs book vs canvasser
 * volume); the receipts drawer itemizes the headline. Color roles are
 * strict: victory = money, red/amber = fires, neon pink = touchable,
 * everything else neutral.
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
  n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
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

/** ▲/▼ delta chip vs a baseline; null baseline renders nothing. */
function DeltaChip({ now, base, label }: { now: number; base: number | null; label: string }) {
  if (base === null || base <= 0) return null;
  const pct = (now - base) / base;
  const up = pct >= 0;
  return (
    <span
      className={cn(
        "tabular-nums text-[10px] font-display uppercase tracking-widest",
        up ? "text-victory [text-shadow:none]" : "text-destructive",
      )}
    >
      {up ? "▲" : "▼"} {Math.abs(Math.round(pct * 100))}% {label}
    </span>
  );
}

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

const TROUBLE_CHIP: Record<string, string> = {
  urgent: "border-destructive/60 text-destructive",
  late: "border-destructive/60 text-destructive",
  "partial collected": "border-warning/60 text-warning",
  "run card": "border-border text-muted-foreground",
};

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

  // Next month's board feeds the forward outlook (current month only).
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

  // 13 months of slim rows → MoM/YoY deltas + the Sparkbars strip.
  const trendStart = `${Number(monthStart.slice(0, 4)) - 1}-${monthStart.slice(5, 7)}-01`;
  const trendQuery = useQuery({
    queryKey: ["report_collections", "trend", monthStart],
    queryFn: paged<
      Pick<CollectionRow, "planned_amount" | "actual_amount" | "office"> & {
        collection_month: string;
      }
    >((from, to) =>
      supabase
        .from("report_collections")
        .select("collection_month, planned_amount, actual_amount, office")
        .gte("collection_month", trendStart)
        .lte("collection_month", monthStart)
        .order("monday_item_id")
        .range(from, to),
    ),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
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
  const prevMonthCollected =
    trendByMonth.get(monthStartISO(addDaysISO(monthStart, -1)))?.collected ?? null;
  const yoyCollected = trendByMonth.get(trendStart)?.collected ?? null;

  // --- Target (editable; table may predate the migration — fail soft) ---
  const targetQuery = useQuery({
    queryKey: ["company_targets"],
    queryFn: async () => {
      const { data, error } = await supabase.from("company_targets").select("*").maybeSingle();
      if (error) return null; // table not applied yet → pace shows without a plan
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

  // Pace: project the month from run-rate-to-date, annualize the projection.
  const pace = useMemo(() => {
    const daysInMonth = curve.days.length || 30;
    const elapsed = isCurrentMonth
      ? Math.max(1, Math.min(daysInMonth, Number(todayISO.slice(8, 10))))
      : daysInMonth;
    const projected = isCurrentMonth ? (vault.collected / elapsed) * daysInMonth : vault.collected;
    return {
      projected,
      annualized: projected * 12,
      pctOfTarget: target ? vault.collected / target : null,
    };
  }, [curve.days.length, isCurrentMonth, todayISO, vault.collected, target]);

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
  const kombat = useMemo(() => {
    const officeCards = (cardsQuery.data ?? []).filter((c) => matches(c.office_location));
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
  }, [cardsQuery.data, reportQuery.data, matches, monthStart, monthEnd, officeOrAll, pendingCheck]);
  // Book by month (whole loaded year) for the Kombat strip + cancel trend.
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

  // --- Ground game ---
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
    const points = office === "All" ? d.points : (d.officePoints[office] ?? {});
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
      points: sumMap(points),
      cancels: sumMap(cancels),
      cancelledVol: sumMap(cancelledVol),
    };
  }, [dispatchQuery.data, office]);

  // --- Lead factory ---
  const leadMetricsQuery = useQuery({
    queryKey: ["god_mode", "lead_metrics", monthStart],
    queryFn: paged<{
      id: string;
      canvasser_id: string;
      office_location: string;
      leads_generated: number;
      leads_confirmed: number;
      future: number;
      killed: number;
    }>((from, to) =>
      supabase
        .from("daily_metrics")
        .select(
          "id, canvasser_id, office_location, leads_generated, leads_confirmed, future, killed",
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
    const nameById = new Map(
      (roster.data?.profiles ?? []).map((p) => [p.id, p.display_name ?? ""]),
    );
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
    const channels = new Map<string, number>();
    for (const r of rows) {
      const name = nameById.get(r.canvasser_id);
      if (name !== undefined && isLeadSourceName(name) && r.leads_generated > 0) {
        channels.set(name, (channels.get(name) ?? 0) + r.leads_generated);
      }
    }
    return {
      generated: sum((r) => r.leads_generated),
      confirmed: sum((r) => r.leads_confirmed),
      future: sum((r) => r.future),
      killed: sum((r) => r.killed),
      channelCount: channels.size,
    };
  }, [leadMetricsQuery.data, roster.data, office]);

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

  // --- Crew + alerts ---
  const clockQuery = useQuery({
    queryKey: ["god_mode", "clock", todayISO],
    queryFn: () => getClockPresence({ data: { dates: [todayISO] } }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const flaggedQuery = useQuery({
    queryKey: ["god_mode", "flagged_punches_count"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("time_entries")
        .select("id", { count: "exact", head: true })
        .eq("needs_correction", true)
        .is("voided_at", null);
      if (error) throw error;
      return count ?? 0;
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

  if (realRole && realRole !== "owner") {
    return (
      <div className="p-4">
        <ArcadeCard>
          <div className="text-sm text-muted-foreground">God Mode is owners-only.</div>
        </ArcadeCard>
      </div>
    );
  }

  // --- Alert rail items (everything actionable lives here, nowhere else) ---
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
  if ((flaggedQuery.data ?? 0) > 0) {
    alerts.push({
      key: "punches",
      label: `${flaggedQuery.data} flagged punch${flaggedQuery.data === 1 ? "" : "es"}`,
      sub: "Time clock review queue",
      to: "/dashboard?tab=timesheets",
      tone: "warning",
    });
  }
  if (payrollRunQuery.isSuccess && (payrollRunQuery.data?.status ?? "none") !== "approved") {
    alerts.push({
      key: "payroll",
      label:
        payrollRunQuery.data == null ? "Last week's payroll: no run" : "Last week's payroll: draft",
      sub: "Draft and approve to freeze the week",
      to: "/dashboard?tab=payroll",
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

  const vaultDim = collectionsQuery.isPlaceholderData;
  const bookDim = reportQuery.isPlaceholderData || cardsQuery.isPlaceholderData;
  const troubleChips = vault.byStatus.filter(
    (s) => TROUBLE_CHIP[s.status.toLowerCase()] !== undefined,
  );
  const funnelStages = [
    { label: "Generated", value: factory.generated },
    { label: "Confirmed", value: factory.confirmed },
    { label: "Sits", value: ground?.sits ?? 0 },
    { label: "Sales", value: ground?.sales ?? 0 },
  ];

  return (
    <div className="p-4 pb-20 space-y-3 max-w-6xl mx-auto">
      {/* ── Header ── */}
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
        <div className="ml-auto">
          <NeonButton
            tone="turf-cyan"
            disabled={sync.isPending || backfill.isPending}
            onClick={() => sync.mutate()}
            title="Re-pull the Collections boards (prev/current/next month) and the active Block boards"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", sync.isPending && "animate-spin")} />
            <span className="hidden sm:inline">Sync boards</span>
            <span className="sm:hidden">Sync</span>
          </NeonButton>
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
      <div className="text-[10px] text-muted-foreground">
        Collections synced {relTime(collectionsSyncInfo.data?.lastSyncedAt ?? null)} · Kombat synced{" "}
        {relTime(kombatSyncInfo.data?.lastSyncedAt ?? null)}
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
                <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  Cash · collected {monthLabel}
                </div>
                <div
                  className={cn(
                    "mt-2 font-display tabular-nums text-victory break-words leading-none text-[clamp(1.9rem,7vw,4rem)] transition-transform",
                    heroMoney.bump && !reduced && "scale-[1.02]",
                  )}
                >
                  {fmtMoney(heroMoney.display)}
                </div>
                <div className="mt-2 text-sm text-muted-foreground tabular-nums">
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

                {/* PACE */}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
                  <span className="text-muted-foreground">
                    Pace {fmtShort(pace.projected)} → {fmtShort(pace.annualized)}/yr
                  </span>
                  {pace.pctOfTarget !== null ? (
                    <span
                      className={cn(
                        "font-display text-[10px] uppercase tracking-widest",
                        pace.pctOfTarget >= 1
                          ? "text-victory [text-shadow:none]"
                          : "text-foreground",
                      )}
                    >
                      {fmtPctFloor(pace.pctOfTarget)} of {fmtShort(target ?? 0)} target
                    </span>
                  ) : targetQuery.isSuccess && targetQuery.data === null ? (
                    <span className="text-[10px] text-muted-foreground">
                      target table not applied yet
                    </span>
                  ) : null}
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
                  ) : (
                    targetQuery.data !== null &&
                    targetQuery.isSuccess && (
                      <button
                        type="button"
                        onClick={() => {
                          setTargetDraft(String(target ?? ""));
                          setEditTarget(true);
                        }}
                        className="inline-flex min-h-11 md:min-h-0 items-center gap-1 text-[10px] font-display uppercase tracking-widest text-neon hover:underline"
                      >
                        <Pencil className="h-3 w-3" /> target
                      </button>
                    )
                  )}
                  <DeltaChip now={vault.collected} base={prevMonthCollected} label="MoM" />
                  <DeltaChip now={vault.collected} base={yoyCollected} label="YoY" />
                </div>

                {/* NEXT CASH */}
                {forward && (
                  <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                    Next cash · <span className="text-foreground">{fmtShort(forward.next7)}</span>{" "}
                    in 7d · <span className="text-foreground">{fmtShort(forward.next30)}</span> in
                    30d
                    {forward.overdueBacklog > 0 && (
                      <>
                        {" · "}
                        <span className="text-destructive">
                          {fmtShort(forward.overdueBacklog)} overdue backlog
                        </span>
                      </>
                    )}
                  </div>
                )}

                <NeonBar
                  pct={heroInView ? (vault.pct ?? 0) : 0}
                  accent="var(--victory)"
                  tall
                  sheen
                />

                <div className="mt-4">
                  <CashCurve curve={curve} dimmed={vaultDim} />
                </div>

                {/* Status strip: trouble only */}
                {troubleChips.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {troubleChips.map((s) => (
                      <span
                        key={s.status}
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-[10px] font-display uppercase tracking-widest tabular-nums",
                          TROUBLE_CHIP[s.status.toLowerCase()],
                        )}
                      >
                        {s.status} ×{s.count} ·{" "}
                        {fmtShort(s.planned - s.actual > 0 ? s.planned - s.actual : s.actual)}
                      </span>
                    ))}
                  </div>
                )}

                {/* 12-month strip — tap a bar to time-travel */}
                <div className="mt-4">
                  <div className="flex items-baseline justify-between text-[10px] text-muted-foreground">
                    <span className="font-display uppercase tracking-widest">Last 12 months</span>
                    <span>tap a month to travel</span>
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
                <p className="mt-3 text-[10px] text-muted-foreground/70">
                  Collections-board dollars — anticipated vs banked. Not the sales book, not
                  canvasser volume.
                </p>
              </div>
            </div>
          )}
        </Reveal>

        {/* ── 2 · ALERT RAIL ─────────────────────────────────────── */}
        <Reveal
          ready={!collectionsQuery.isPending}
          i={1}
          className="lg:col-span-4"
          skeleton={<PanelSkeleton rows={3} />}
        >
          <div className="space-y-2">
            <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground px-1">
              Needs you
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
          </div>
        </Reveal>

        {/* ── 3 · CLOSE KOMBAT · THE OFFICIAL BOOK ───────────────── */}
        <Reveal
          ready={!reportQuery.isPending && !cardsQuery.isPending}
          i={2}
          className="lg:col-span-7"
          skeleton={<PanelSkeleton rows={4} />}
        >
          <ArcadePanel
            faction="kombat"
            title="Close Kombat · The Official Book"
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
                <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden border border-kombat-red/30 bg-kombat-red/20">
                  <ArcadeStatTile
                    flat
                    mono
                    label="Sold"
                    value={fmtCount(kombat.totals.sold)}
                    accent="muted"
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
                {/* Cancels: the bleed — full-width, loud */}
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
                <p className="text-[10px] text-muted-foreground/70">
                  The official book (Shark Tank parity) plus just-sold cards — not Collections, not
                  canvasser volume.
                </p>
              </div>
            )}
          </ArcadePanel>
        </Reveal>

        {/* ── 4 · PIPELINE (funnel) ──────────────────────────────── */}
        <Reveal
          ready={!leadMetricsQuery.isPending}
          i={3}
          className="lg:col-span-5"
          skeleton={<PanelSkeleton rows={4} />}
        >
          <ArcadePanel
            title="Lead Factory"
            action={
              <NeonButton asChild className="min-h-9">
                <Link to="/confirmation-desk">
                  Desk{(pendingLeadsQuery.data ?? 0) > 0 ? ` · ${pendingLeadsQuery.data}` : ""}
                </Link>
              </NeonButton>
            }
          >
            {leadMetricsQuery.isError ? (
              <QueryStateCard
                pending={false}
                what="lead metrics"
                onRetry={() => leadMetricsQuery.refetch()}
              />
            ) : (
              <div
                className={cn(
                  "space-y-3 transition-opacity",
                  leadMetricsQuery.isPlaceholderData && "opacity-50",
                )}
              >
                <FunnelLadder stages={funnelStages} />
                <div className="grid grid-cols-2 gap-px rounded-lg overflow-hidden border border-border/40 bg-border/40">
                  <ArcadeStatTile flat mono label="Future" value={factory.future} accent="muted" />
                  <ArcadeStatTile
                    flat
                    mono
                    label="Blown out"
                    value={factory.killed}
                    accent={factory.killed > 0 ? "destructive" : "muted"}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground/70">
                  QR &amp; internet leads aren't mirrored into the app yet — they live on the Monday
                  leads board.
                </p>
              </div>
            )}
          </ArcadePanel>
        </Reveal>

        {/* ── 5 · RHYTHM (calendar heatmap) ──────────────────────── */}
        <Reveal
          ready={!collectionsQuery.isPending}
          i={4}
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

        {/* ── 6 · GROUND GAME ────────────────────────────────────── */}
        <Reveal
          ready={!dispatchQuery.isPending}
          i={5}
          className="lg:col-span-7"
          skeleton={<PanelSkeleton rows={3} />}
        >
          <ArcadePanel
            title="Ground Game"
            action={
              <NeonButton asChild className="min-h-9">
                <Link to="/dashboard" search={{ tab: "dispatch" }}>
                  Dispatch
                </Link>
              </NeonButton>
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
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                      Confirmed volume · net of cancels
                    </div>
                    <div className="mt-1 font-display text-2xl md:text-3xl tabular-nums text-victory [text-shadow:none]">
                      {fmtMoney(groundMoney.display)}
                    </div>
                  </div>
                  {ground.cancels > 0 && (
                    <div className="text-right text-xs tabular-nums text-muted-foreground">
                      <span className="text-destructive">−{fmtMoney(ground.cancelledVol)}</span> ·{" "}
                      {ground.cancels} cancel{ground.cancels === 1 ? "" : "s"}
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-3 md:grid-cols-5 gap-px rounded-lg overflow-hidden border border-border/40 bg-border/40">
                  <ArcadeStatTile
                    flat
                    mono
                    label="Doors"
                    value={ground.doors}
                    accent="muted"
                    sub={{
                      label: "$/door",
                      value: ground.doors > 0 ? fmtShort(ground.volume / ground.doors) : "—",
                      accent: "muted",
                    }}
                  />
                  <ArcadeStatTile flat mono label="Talks" value={ground.talks} accent="muted" />
                  <ArcadeStatTile flat mono label="Leads" value={ground.leads} accent="muted" />
                  <ArcadeStatTile
                    flat
                    mono
                    label="Sits"
                    value={ground.sits}
                    accent="muted"
                    sub={{ label: "Sales", value: ground.sales, accent: "muted" }}
                  />
                  <ArcadeStatTile
                    flat
                    mono
                    label="Points"
                    value={ground.points}
                    accent="muted"
                    sub={{
                      label: "$/lead",
                      value: ground.leads > 0 ? fmtShort(ground.volume / ground.leads) : "—",
                      accent: "muted",
                    }}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground/70">
                  Confirmed-lead dollars net of WCC cancels — the canvasser pay axis; a third money
                  number that matches neither board above.
                </p>
              </div>
            ) : null}
          </ArcadePanel>
        </Reveal>

        {/* ── 7 · CREW (roster facts only — fires live in the rail) ── */}
        <Reveal
          ready={roster.isSuccess}
          i={6}
          className="lg:col-span-12"
          skeleton={<PanelSkeleton rows={1} />}
        >
          <ArcadePanel title="Crew">
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
                label="Canvasser pay (month)"
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
                to="/daily-wrap"
                label="Daily wrap"
                value="Open"
                sub="Tonight's recap & winners"
              />
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground/70">
              Canvasser pay is the pay engine's month total (weekly pay + volume bonus) — not total
              company labor.
            </p>
          </ArcadePanel>
        </Reveal>

        {/* ── 8 · RECEIPTS DRAWER ────────────────────────────────── */}
        <Reveal
          ready={!collectionsQuery.isPending}
          i={7}
          className="lg:col-span-12"
          skeleton={<ArcadeSkeleton className="h-12 w-full" />}
        >
          <ReceiptsDrawer
            rows={collectionsQuery.data ?? []}
            office={officeOrAll}
            todayISO={todayISO}
            dayFilter={receiptsDay}
            clearDayFilter={() => setReceiptsDay(null)}
          />
        </Reveal>
      </div>
    </div>
  );
}

function searchOf(to: string): Record<string, string> | undefined {
  const q = to.split("?")[1];
  return q ? Object.fromEntries(new URLSearchParams(q).entries()) : undefined;
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
function FunnelLadder({ stages }: { stages: Array<{ label: string; value: number }> }) {
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
      <div className="pt-1 font-display text-[10px] uppercase tracking-widest text-muted-foreground tabular-nums">
        {first} generated → {last} sales{" "}
        {last > 0 && <span className="text-foreground">· 1 in {Math.round(first / last)}</span>}
      </div>
      <p className="text-[10px] text-muted-foreground/60">
        Generated/Confirmed count by submission day; Sits/Sales by block day.
      </p>
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
}: {
  rows: CollectionRow[];
  office: string | undefined;
  todayISO: string;
  dayFilter: string | null;
  clearDayFilter: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [showCollected, setShowCollected] = useState(false);

  const prepared = useMemo(() => {
    const mine = rows
      .filter((r) => office === undefined || r.office === office)
      .filter((r) => dayFilter === null || r.collected_date === dayFilter)
      .map((r) => ({ r, state: rowCollectionState(r, todayISO) }));
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
                  <th className="py-2 pr-2 text-right">Planned</th>
                  <th className="py-2 pr-2 text-right">Collected</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {visible.map(({ r, state }) => (
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
            {visible.map(({ r, state }) => (
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
