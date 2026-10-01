import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Eye, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";
import {
  addDaysISO,
  dateFromISO,
  laMidnightUtcISO,
  laMonthStartISO,
  laTodayISO,
  laWeekStartISO,
  monthStartISO,
  nextMonthStartISO,
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
  ArcadeStatTile,
  MobileCard,
  MobileCardHeader,
  MobileCardList,
  MobileStat,
  MobileStatGrid,
  NeonBar,
  NeonButton,
  RangeChip,
  type StatTileAccent,
} from "@/components/arcade";
import { QueryStateCard } from "@/components/QueryStateCard";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { useDispatchRoster } from "@/hooks/useFleetRoster";
import { usePendingDojoCount } from "@/hooks/usePendingDojoCount";
import { isLeadSourceName } from "@/lib/lead-sources";
import {
  aggregateCloseKombat,
  aggregateReportYear,
  buildPendingReportCheck,
  filterReportRows,
  type BlockCard,
  type ReportSaleRow,
} from "@/lib/close-kombat";
import { getKombatSyncInfo, syncBlockCards } from "@/lib/close-kombat.functions";
import { getCollectionsSyncInfo, syncCollections } from "@/lib/collections.functions";
import { aggregateCollections, rowCollectionState } from "@/lib/collections";
import {
  getClockPresence,
  getDispatchProduction,
  type DispatchResults,
} from "@/lib/dispatch.functions";
import { fetchMonthlyPaychecksChunked } from "@/lib/paychecks";

/**
 * God Mode — the owner-only whole-business dashboard (owner directive
 * 2026-09-30): one month, every axis. Leads with the Collections board's
 * anticipated-vs-collected money, then the Close Kombat book, the lead
 * factory, the ground game, and crew status — each tile labeled with WHICH
 * money axis it shows (collections vs sales book vs canvasser volume: three
 * numbers that will never match) and linked to the page where the owner
 * digs deeper. Every figure traces to underlying rows (the payments table
 * itemizes the headline).
 */
export function GodMode({
  monthParam,
  setMonthParam,
}: {
  /** ?month=YYYY-MM-01 from the route; null = current LA month. */
  monthParam: string | null;
  setMonthParam: (m: string) => void;
}) {
  return (
    // Sticky per device, same rationale as Close Kombat's pill (R-13).
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

/** Link context on each side of the month (CloseKombat's SAVE_LINK_PAD_DAYS,
 *  duplicated like FleetDispatch does so this bundle never drags
 *  CloseKombat.tsx in): saves can land up to six weeks from their sale. */
const SAVE_LINK_PAD_DAYS = 42;

// BYTE-IDENTICAL to CloseKombat.tsx's CARD_COLUMNS — this page shares the
// ["block_cards", start, end] key family, and a divergent select on a shared
// key poisons whichever page reads the cache next. Change BOTH together.
const CARD_COLUMNS =
  "monday_item_id, board_id, office_location, card_date, group_title, lead_name, reps, " +
  "iss, bo, ol, rs, pm, sale, sale_price, products, canvass_stats, wcc, comments, phone, " +
  "report_reps, missing_from_report";

/** The collections columns the page consumes (in_bank/notes stay server-side
 *  until a drill-down needs them). */
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

const STATUS_ACCENT = (status: string): StatTileAccent => {
  const s = status.trim().toLowerCase();
  if (s === "collected" || s === "processed" || s === "funded") return "victory";
  if (s === "late" || s === "urgent") return "destructive";
  if (s === "partial collected") return "warning";
  if (s === "no status") return "muted";
  return "neon"; // Run Card / On Time / future lanes
};

function GodModeInner({
  monthParam,
  setMonthParam,
}: {
  monthParam: string | null;
  setMonthParam: (m: string) => void;
}) {
  const { realRole } = useAuth();
  const qc = useQueryClient();
  const { office, matches } = useOfficeFilter();
  const officeOrAll = office === "All" ? undefined : office;

  // --- Month engine (LA calendar, URL-backed via the route) ---
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

  // --- Collections: the month's payment rows (RLS: owner/office_staff) ---
  const collectionsQuery = useQuery({
    queryKey: ["report_collections", monthStart],
    queryFn: async ({ signal }) => {
      const PAGE = 1000;
      const all: CollectionRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("report_collections")
          .select(COLLECTION_COLUMNS)
          .eq("collection_month", monthStart)
          .order("monday_item_id")
          .range(from, from + PAGE - 1)
          .abortSignal(signal);
        if (error) throw error;
        all.push(...((data ?? []) as unknown as CollectionRow[]));
        if (!data || data.length < PAGE) break;
      }
      return all;
    },
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
  const vault = useMemo(
    () =>
      aggregateCollections(collectionsQuery.data ?? [], {
        office: officeOrAll,
        todayISO,
      }),
    [collectionsQuery.data, officeOrAll, todayISO],
  );

  // --- Close Kombat month book (the Shark Tank Month-tab hybrid) ---
  const fetchStart = addDaysISO(monthStart, -SAVE_LINK_PAD_DAYS);
  const fetchEnd = addDaysISO(monthEnd, SAVE_LINK_PAD_DAYS);
  const cardsQuery = useQuery({
    queryKey: ["block_cards", fetchStart, fetchEnd],
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
    placeholderData: (prev) => prev,
  });
  const bookYear = Number(monthStart.slice(0, 4));
  const reportQuery = useQuery({
    queryKey: ["report_sales", bookYear],
    queryFn: async ({ signal }) => {
      const PAGE = 1000;
      const all: ReportSaleRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("report_sales")
          .select(
            "monday_item_id, office, report_month, date_sold, sale_amt, cancel_amt, wcc, sales_count, reps, customer_name, phone",
          )
          .gte("report_month", `${bookYear}-01-01`)
          .lte("report_month", `${bookYear}-12-31`)
          .order("monday_item_id")
          .range(from, from + PAGE - 1)
          .abortSignal(signal);
        if (error) throw error;
        all.push(...((data ?? []) as unknown as ReportSaleRow[]));
        if (!data || data.length < PAGE) break;
      }
      return all;
    },
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
    const { agg, officeBlind } = (() => {
      const f = filterReportRows(reportQuery.data ?? [], {
        month: monthStart,
        office: officeOrAll,
      });
      return { agg: aggregateReportYear(f.rows), officeBlind: f.officeBlind };
    })();
    return {
      totals,
      bookRevenue: Math.round((agg.totals.revenue + totals.pendingRevenue) * 100) / 100,
      cancelAmt: agg.totals.cancelAmt,
      officeBlind,
    };
  }, [cardsQuery.data, reportQuery.data, matches, monthStart, monthEnd, officeOrAll, pendingCheck]);
  // SD vs OC book race, filter-independent (the officeRaceMonth recipe).
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

  // --- Ground game: the dispatch/pay axis for the month ---
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
      points: sumMap(points),
      volume: sumMap(volume),
      cancels: sumMap(cancels),
      cancelledVol: sumMap(cancelledVol),
    };
  }, [dispatchQuery.data, office]);

  // --- Lead factory: daily_metrics month rollup + channel split ---
  const leadMetricsQuery = useQuery({
    queryKey: ["god_mode", "lead_metrics", monthStart],
    queryFn: async ({ signal }) => {
      const PAGE = 1000;
      type Row = {
        id: string;
        canvasser_id: string;
        office_location: string;
        leads_generated: number;
        leads_submitted: number;
        leads_confirmed: number;
        future: number;
        killed: number;
      };
      const all: Row[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("daily_metrics")
          .select(
            "id, canvasser_id, office_location, leads_generated, leads_submitted, leads_confirmed, future, killed",
          )
          .gte("metric_date", monthStart)
          .lte("metric_date", monthEnd)
          .order("id")
          .range(from, from + PAGE - 1)
          .abortSignal(signal);
        if (error) throw error;
        all.push(...((data ?? []) as unknown as Row[]));
        if (!data || data.length < PAGE) break;
      }
      return all;
    },
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
    let channelGen = 0;
    for (const r of rows) {
      const name = nameById.get(r.canvasser_id);
      if (name !== undefined && isLeadSourceName(name) && r.leads_generated > 0) {
        channels.set(name, (channels.get(name) ?? 0) + r.leads_generated);
        channelGen += r.leads_generated;
      }
    }
    const generated = sum((r) => r.leads_generated);
    return {
      generated,
      submitted: sum((r) => r.leads_submitted),
      confirmed: sum((r) => r.leads_confirmed),
      future: sum((r) => r.future),
      killed: sum((r) => r.killed),
      channels: [
        { name: "Field (door-knocked)", count: Math.max(generated - channelGen, 0) },
        ...[...channels.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
      ],
    };
  }, [leadMetricsQuery.data, roster.data, office]);

  // --- Crew status + alert strip inputs ---
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
  // Last COMPLETED week's run — the one that should exist and be approved by
  // now (PayrollLedger's own default week). Same key+fetch as the ledger.
  const lastWeekStart = addDaysISO(laWeekStartISO(), -7);
  const payrollRunQuery = useQuery({
    queryKey: ["payroll-run", lastWeekStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_runs")
        .select("id, week_start, status, created_at, approved_at")
        .eq("week_start", lastWeekStart)
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

  const headcount = useMemo(() => {
    const profiles = roster.data?.profiles ?? [];
    const real = profiles.filter(
      (p) => p.is_active !== false && !p.is_placeholder && !isLeadSourceName(p.display_name),
    );
    return real.length;
  }, [roster.data]);

  // --- Labor cost (pay-engine truth, never re-derived): the month's
  // calc_monthly_paycheck across the active roster, summed. Its own query so
  // the rest of the page never waits on ~40 pay-engine RPCs.
  const laborIds = useMemo(
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
    queryKey: ["god_mode", "labor", monthStart, laborIds.length],
    enabled: laborIds.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const results = await fetchMonthlyPaychecksChunked(monthStart, laborIds);
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
  // Both engines in parallel, isolated: a collections failure must never
  // read as a Kombat failure (or vice versa) — allSettled, per-arm toasts.
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
        if (col.value.skipped.length > 0) {
          toast.warning(`Collections: ${col.value.skipped.length} board(s) skipped — see logs`);
        }
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
  // One-time backfill: every Collections board back to 2023 (~40 boards).
  const backfill = useMutation({
    mutationFn: () => syncCollections({ data: { scope: "all" } }),
    onSuccess: (res) => {
      const fetched = res.results.reduce((s, r) => s + r.fetched, 0);
      toast.success(`Backfilled ${res.results.length} Collections board(s) · ${fetched} payments`);
      if (res.skipped.length > 0) {
        toast.warning(`${res.skipped.length} board(s) skipped — see webhook logs`);
      }
      invalidateAfterSync();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Backfill failed"),
  });

  useRealtimeInvalidate({
    channel: "god-mode-live",
    tables: ["report_collections", "block_cards", "report_sales", "daily_metrics", "leads"],
    invalidateKeys: [["report_collections"], ["block_cards"], ["report_sales"], ["god_mode"]],
  });

  // Component-level gate on the REAL role: View As must never hide the page
  // from the owner, and a transiently failed-open guard must never show
  // collections money to a non-owner (RLS already blanks it server-side).
  if (realRole && realRole !== "owner") {
    return (
      <div className="p-4">
        <ArcadeCard>
          <div className="text-sm text-muted-foreground">God Mode is owners-only.</div>
        </ArcadeCard>
      </div>
    );
  }

  const alerts: Array<{ key: string; label: string; to: string; tone: "destructive" | "warning" }> =
    [];
  if (vault.overdueCount > 0) {
    alerts.push({
      key: "overdue",
      label: `${vault.overdueCount} payment${vault.overdueCount === 1 ? "" : "s"} overdue · ${fmtMoney(vault.overdueAmount)}`,
      to: "/god-mode",
      tone: "destructive",
    });
  }
  if ((flaggedQuery.data ?? 0) > 0) {
    alerts.push({
      key: "punches",
      label: `${flaggedQuery.data} flagged punch${flaggedQuery.data === 1 ? "" : "es"}`,
      to: "/dashboard?tab=timesheets",
      tone: "warning",
    });
  }
  if (payrollRunQuery.isSuccess && (payrollRunQuery.data?.status ?? "none") !== "approved") {
    alerts.push({
      key: "payroll",
      label:
        payrollRunQuery.data == null
          ? "Last week's payroll: no run yet"
          : "Last week's payroll: draft unapproved",
      to: "/dashboard?tab=payroll",
      tone: "warning",
    });
  }
  if ((pendingLeadsQuery.data ?? 0) > 0) {
    alerts.push({
      key: "desk",
      label: `${pendingLeadsQuery.data} lead${pendingLeadsQuery.data === 1 ? "" : "s"} waiting at the desk`,
      to: "/confirmation-desk",
      tone: "warning",
    });
  }
  if (dojoPending > 0) {
    alerts.push({
      key: "dojo",
      label: `${dojoPending} dojo review${dojoPending === 1 ? "" : "s"} pending`,
      to: "/confirmation-desk",
      tone: "warning",
    });
  }

  const vaultDim = collectionsQuery.isPlaceholderData;
  const bookDim = reportQuery.isPlaceholderData || cardsQuery.isPlaceholderData;

  return (
    <div className="p-4 space-y-4 max-w-5xl mx-auto">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 flex items-center gap-2 font-display text-base md:text-2xl uppercase tracking-widest text-neon">
          <Eye className="w-5 h-5 shrink-0" />
          God Mode
        </h1>
        {isCurrentMonth && (
          <span className="text-[10px] font-display uppercase tracking-widest text-victory animate-pulse">
            Live
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <NeonButton
            tone="turf-cyan"
            disabled={sync.isPending || backfill.isPending}
            onClick={() => sync.mutate()}
            title="Re-pull this + last month's Collections boards and the active Block boards"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", sync.isPending && "animate-spin")} />
            <span className="hidden sm:inline">Sync boards</span>
            <span className="sm:hidden">Sync</span>
          </NeonButton>
        </div>
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        The whole business for {monthLabel} — money in, deals down, doors knocked.
      </p>

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

      {/* ── Alert strip: everything needing an owner's eyes, one glance ── */}
      {alerts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {alerts.map((a) =>
            a.to === "/god-mode" ? (
              <span
                key={a.key}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-[10px] font-display uppercase tracking-widest",
                  a.tone === "destructive"
                    ? "border-destructive/60 bg-destructive/10 text-destructive"
                    : "border-warning/60 bg-warning/10 text-warning",
                )}
              >
                {a.label}
              </span>
            ) : (
              <Link
                key={a.key}
                to={a.to}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-[10px] font-display uppercase tracking-widest",
                  a.tone === "destructive"
                    ? "border-destructive/60 bg-destructive/10 text-destructive"
                    : "border-warning/60 bg-warning/10 text-warning",
                )}
              >
                {a.label}
              </Link>
            ),
          )}
        </div>
      )}

      {/* ── 1 · THE VAULT ───────────────────────────────────────────── */}
      <ArcadePanel
        title={`The Vault · Anticipated vs Collected`}
        action={
          vaultDim ? (
            <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground animate-pulse">
              Counting…
            </span>
          ) : undefined
        }
      >
        {collectionsQuery.isPending || collectionsQuery.isError ? (
          <QueryStateCard
            pending={collectionsQuery.isPending}
            what="collections"
            onRetry={() => collectionsQuery.refetch()}
          />
        ) : (collectionsQuery.data?.length ?? 0) === 0 ? (
          <div className="space-y-3">
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
          </div>
        ) : (
          <div className={cn("space-y-4 transition-opacity", vaultDim && "opacity-50")}>
            {/* Hero */}
            <ArcadeCard glow>
              <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                Collected this month
              </div>
              <div className="mt-1 font-display text-3xl md:text-4xl text-victory tabular-nums break-words">
                {fmtMoney(vault.collected)}
              </div>
              <div className="text-xs text-muted-foreground">
                of {fmtMoney(vault.anticipated)} anticipated
              </div>
              <NeonBar pct={vault.pct ?? 0} accent="var(--victory)" tall />
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="text-muted-foreground">
                  {fmtPct(vault.pct)} banked · {fmtMoney(vault.outstanding)} still out
                </span>
                {vault.overdueCount > 0 && (
                  <span className="text-destructive font-display text-[10px] uppercase tracking-widest">
                    {vault.overdueCount} overdue · {fmtMoney(vault.overdueAmount)}
                  </span>
                )}
              </div>
            </ArcadeCard>

            {/* Status tiles */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {vault.byStatus.map((s) => (
                <ArcadeStatTile
                  key={s.status}
                  label={s.status}
                  value={fmtMoney(s.actual > 0 ? s.actual : s.planned)}
                  accent={STATUS_ACCENT(s.status)}
                  sub={{ label: "", value: `×${s.count}`, accent: "muted" }}
                />
              ))}
            </div>

            {/* SD vs OC lanes */}
            <OfficeLanes
              lanes={vault.byOffice.map((o) => ({ office: o.office, amount: o.collected }))}
              fmt={fmtMoney}
            />

            <PaymentsTable
              rows={collectionsQuery.data ?? []}
              office={officeOrAll}
              todayISO={todayISO}
            />

            <p className="text-[10px] text-muted-foreground">
              Collections-board dollars — anticipated vs banked. This is NOT the sales book below
              and will not match it.
            </p>
          </div>
        )}
      </ArcadePanel>

      {/* ── 2 · CLOSE KOMBAT · THE OFFICIAL BOOK ───────────────────── */}
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
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <ArcadeStatTile
                faction="kombat"
                label="Book volume"
                value={fmtMoney(kombat.bookRevenue)}
                accent="victory"
                sub={
                  kombat.totals.pendingDeals > 0
                    ? {
                        label: "pending",
                        value: fmtMoney(kombat.totals.pendingRevenue),
                        accent: "warning",
                      }
                    : undefined
                }
              />
              <ArcadeStatTile
                faction="kombat"
                label="Sold"
                value={fmtCount(kombat.totals.sold)}
                accent="victory"
                sub={{ label: "Close %", value: fmtPct(kombat.totals.closePct), accent: "neon" }}
              />
              <ArcadeStatTile
                faction="kombat"
                label="Appts"
                value={fmtCount(kombat.totals.appts)}
                accent="neon"
                sub={{ label: "Sit %", value: fmtPct(kombat.totals.sitPct), accent: "accent" }}
              />
              <ArcadeStatTile
                faction="kombat"
                label="Cancelled $"
                value={fmtMoney(kombat.cancelAmt)}
                accent="destructive"
                sub={{
                  label: "Cancels",
                  value: fmtCount(kombat.totals.cancels),
                  accent: "destructive",
                }}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <ArcadeStatTile
                faction="kombat"
                label="Resets"
                value={fmtCount(kombat.totals.reset)}
                accent="accent"
              />
              <ArcadeStatTile
                faction="kombat"
                label="No-shows"
                value={fmtCount(kombat.totals.noShow)}
                accent="destructive"
              />
              <ArcadeStatTile
                faction="kombat"
                label="Office appts"
                value={fmtCount(kombat.totals.officeAppts)}
                accent="muted"
              />
            </div>
            {kombatRace && <OfficeLanes lanes={kombatRace} fmt={fmtMoney} gold />}
            {kombat.officeBlind && (
              <p className="text-[10px] text-muted-foreground">
                This month's book records no offices — money shows combined.
              </p>
            )}
            <p className="text-[10px] text-muted-foreground">
              The official book (Shark Tank parity) plus just-sold cards awaiting a report row — not
              Collections, not canvasser volume.
            </p>
          </div>
        )}
      </ArcadePanel>

      {/* ── 3 · LEAD FACTORY ───────────────────────────────────────── */}
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
        {leadMetricsQuery.isPending || leadMetricsQuery.isError ? (
          <QueryStateCard
            pending={leadMetricsQuery.isPending}
            what="lead metrics"
            onRetry={() => leadMetricsQuery.refetch()}
          />
        ) : (
          <div
            className={cn(
              "space-y-4 transition-opacity",
              leadMetricsQuery.isPlaceholderData && "opacity-50",
            )}
          >
            <FunnelBars
              stages={[
                { label: "Generated", value: factory.generated },
                { label: "Confirmed", value: factory.confirmed },
                { label: "Sits", value: ground?.sits ?? 0 },
                { label: "Sales", value: ground?.sales ?? 0 },
              ]}
            />
            <div className="grid grid-cols-2 gap-2">
              <ArcadeStatTile label="Future" value={factory.future} accent="accent" />
              <ArcadeStatTile label="Blown out" value={factory.killed} accent="destructive" />
            </div>
            <div>
              <div className="mb-2 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                Where leads came from
              </div>
              <ChannelBars channels={factory.channels} />
              <p className="mt-2 text-[10px] text-muted-foreground">
                QR &amp; internet leads aren't mirrored into the app yet — they live on the Monday
                leads board.
              </p>
            </div>
          </div>
        )}
      </ArcadePanel>

      {/* ── 4 · GROUND GAME ────────────────────────────────────────── */}
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
        {dispatchQuery.isPending || dispatchQuery.isError ? (
          <QueryStateCard
            pending={dispatchQuery.isPending}
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
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
              <ArcadeStatTile label="Doors" value={ground.doors} accent="neon" />
              <ArcadeStatTile label="Talks" value={ground.talks} accent="neon" />
              <ArcadeStatTile label="Leads" value={ground.leads} accent="accent" />
              <ArcadeStatTile
                label="Sits"
                value={ground.sits}
                accent="accent"
                sub={{ label: "Sales", value: ground.sales, accent: "victory" }}
              />
              <ArcadeStatTile label="Points" value={ground.points} accent="neon" />
              <ArcadeStatTile
                label="Volume"
                value={fmtMoney(ground.volume)}
                accent="victory"
                sub={
                  ground.cancels > 0
                    ? {
                        label: "cancels",
                        value: `−${fmtMoney(ground.cancelledVol)}`,
                        accent: "destructive",
                      }
                    : undefined
                }
              />
            </div>
            <p className="text-[10px] text-muted-foreground">
              Confirmed-lead dollars net of WCC cancels — the canvasser pay axis; a third money
              number that matches neither board above.
            </p>
          </div>
        ) : null}
      </ArcadePanel>

      {/* ── 5 · CREW STATUS ────────────────────────────────────────── */}
      <ArcadePanel title="Crew Status">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <CrewLink
            to="/crew-map"
            label="On the clock"
            value={clockQuery.data ? String(clockQuery.data.openNow.length) : "…"}
            sub={
              clockQuery.data
                ? `${(clockQuery.data.byDate[todayISO] ?? []).length} punched today`
                : undefined
            }
            accent="victory"
          />
          <CrewLink
            to="/dashboard?tab=timesheets"
            label="Flagged punches"
            value={flaggedQuery.data != null ? String(flaggedQuery.data) : "…"}
            accent={(flaggedQuery.data ?? 0) > 0 ? "destructive" : "muted"}
          />
          <CrewLink
            to="/dashboard?tab=payroll"
            label="Payroll (last wk)"
            value={
              payrollRunQuery.isSuccess
                ? payrollRunQuery.data == null
                  ? "No run"
                  : payrollRunQuery.data.status === "approved"
                    ? "Approved"
                    : "Draft"
                : "…"
            }
            accent={
              payrollRunQuery.data?.status === "approved"
                ? "victory"
                : payrollRunQuery.data == null
                  ? "warning"
                  : "warning"
            }
          />
          <CrewLink
            to="/dashboard?tab=payroll"
            label="Clawbacks open"
            value={clawbackQuery.data ? String(clawbackQuery.data.length) : "…"}
            sub={
              clawbackQuery.data && clawbackQuery.data.length > 0
                ? fmtMoney(
                    clawbackQuery.data.reduce(
                      (s: number, r: { outstanding: number | null }) =>
                        s + Math.abs(r.outstanding ?? 0),
                      0,
                    ),
                  )
                : undefined
            }
            accent={(clawbackQuery.data?.length ?? 0) > 0 ? "warning" : "muted"}
          />
          <CrewLink
            to="/confirmation-desk"
            label="Desk queue"
            value={pendingLeadsQuery.data != null ? String(pendingLeadsQuery.data) : "…"}
            accent={(pendingLeadsQuery.data ?? 0) > 0 ? "warning" : "muted"}
          />
          <CrewLink
            to="/confirmation-desk"
            label="Dojo reviews"
            value={String(dojoPending)}
            accent={dojoPending > 0 ? "warning" : "muted"}
          />
          <CrewLink
            to="/users"
            label="Active players"
            value={roster.data ? String(headcount) : "…"}
            accent="neon"
          />
          <CrewLink
            to="/dashboard?tab=payroll"
            label="Labor (month)"
            value={
              laborQuery.isSuccess
                ? fmtMoney(laborQuery.data.total)
                : laborQuery.isError
                  ? "—"
                  : "…"
            }
            sub={laborQuery.data ? `${laborQuery.data.paid} earners` : "pay engine"}
            accent="warning"
          />
        </div>
        <p className="mt-3 text-[10px] text-muted-foreground">
          Labor = the pay engine's month total (weekly pay + volume bonus) across the active roster.
        </p>
      </ArcadePanel>
    </div>
  );
}

/** SD vs OC lanes — the Office War bar recipe, shared by Vault + Kombat. */
function OfficeLanes({
  lanes,
  fmt,
  gold = false,
}: {
  lanes: Array<{ office: string; amount: number }>;
  fmt: (n: number) => string;
  gold?: boolean;
}) {
  const visible = lanes.filter((l) => l.office !== "Unassigned" || l.amount > 0);
  const max = Math.max(1, ...visible.map((l) => l.amount));
  const top = Math.max(...visible.map((l) => l.amount));
  return (
    <div className="space-y-3">
      {visible.map((l) => {
        const leads = l.amount === top && l.amount > 0;
        return (
          <div key={l.office} className="min-w-0">
            <div className="flex items-baseline justify-between gap-2 text-[10px] font-display uppercase tracking-widest">
              <span
                className={
                  leads ? (gold ? "text-kombat-gold" : "text-neon") : "text-muted-foreground"
                }
              >
                {l.office}
                {leads ? " 👑" : ""}
              </span>
              <span
                className={cn(
                  "tabular-nums",
                  leads ? (gold ? "text-kombat-gold" : "text-neon") : "text-muted-foreground",
                )}
              >
                {fmt(l.amount)}
              </span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-surface-elevated overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.round((l.amount / max) * 100)}%`,
                  background: leads
                    ? gold
                      ? "var(--kombat-gold)"
                      : "var(--neon)"
                    : gold
                      ? "var(--kombat-red)"
                      : "var(--muted)",
                  boxShadow: leads
                    ? gold
                      ? "0 0 10px var(--kombat-gold)"
                      : "0 0 10px var(--neon)"
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

/** Simple top-anchored funnel bars (FunnelStageBars' visual language). */
function FunnelBars({ stages }: { stages: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className="space-y-2">
      {stages.map((s) => (
        <div key={s.label} className="min-w-0">
          <div className="flex items-baseline justify-between gap-2 text-[10px] font-display uppercase tracking-widest">
            <span className="text-muted-foreground">{s.label}</span>
            <span
              className={cn(
                "tabular-nums",
                s.value > 0 ? "text-foreground" : "text-muted-foreground/40",
              )}
            >
              {s.value}
            </span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-surface-elevated overflow-hidden">
            <div
              className="h-full rounded-full bg-neon/80 transition-all"
              style={{ width: `${Math.round((s.value / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function ChannelBars({ channels }: { channels: Array<{ name: string; count: number }> }) {
  const total = channels.reduce((s, c) => s + c.count, 0);
  const max = Math.max(1, ...channels.map((c) => c.count));
  return (
    <div className="space-y-2">
      {channels
        .filter((c) => c.count > 0 || c.name.startsWith("Field"))
        .map((c) => (
          <div key={c.name} className="min-w-0">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-foreground/90">{c.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {c.count}
                {total > 0 ? ` · ${Math.round((c.count / total) * 100)}%` : ""}
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-surface-elevated overflow-hidden">
              <div
                className="h-full rounded-full bg-accent/80"
                style={{ width: `${Math.round((c.count / max) * 100)}%` }}
              />
            </div>
          </div>
        ))}
    </div>
  );
}

const PAYMENTS_CAP = 15;

const stateBadge: Record<ReturnType<typeof rowCollectionState>, { label: string; cls: string }> = {
  collected: { label: "Collected", cls: "border-victory/50 text-victory" },
  partial: { label: "Partial", cls: "border-warning/50 text-warning" },
  overdue: { label: "Overdue", cls: "border-destructive/60 text-destructive" },
  pending: { label: "Pending", cls: "border-border text-muted-foreground" },
};

/** The itemized payments list — "how did you get this" = these rows. Desktop
 *  table + MobileCardList siblings from the same precomputed rows. */
function PaymentsTable({
  rows,
  office,
  todayISO,
}: {
  rows: CollectionRow[];
  office: string | undefined;
  todayISO: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(() => {
    const mine = office === undefined ? rows : rows.filter((r) => r.office === office);
    const stateRank: Record<string, number> = { overdue: 0, partial: 1, pending: 2, collected: 3 };
    return mine
      .map((r) => ({ r, state: rowCollectionState(r, todayISO) }))
      .sort(
        (a, b) =>
          (stateRank[a.state] ?? 9) - (stateRank[b.state] ?? 9) ||
          (a.r.anticipated_date ?? "9999").localeCompare(b.r.anticipated_date ?? "9999") ||
          (a.r.customer_name ?? "").localeCompare(b.r.customer_name ?? ""),
      );
  }, [rows, office, todayISO]);
  const visible = showAll ? sorted : sorted.slice(0, PAYMENTS_CAP);

  return (
    <div className="space-y-2">
      <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        Payments · {sorted.length}
      </div>

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
          <tbody>
            {visible.map(({ r, state }) => (
              <tr
                key={r.monday_item_id}
                className={cn(
                  "border-t border-border/40",
                  state === "overdue" && "bg-destructive/5",
                )}
              >
                <td className="py-2 pr-2 max-w-48 truncate">{r.customer_name ?? "—"}</td>
                <td className="py-2 pr-2 text-muted-foreground">{r.milestone ?? "—"}</td>
                <td className="py-2 pr-2 text-muted-foreground">{r.payment_type ?? "—"}</td>
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
                <td className="py-2 pr-2 text-right tabular-nums">{fmtMoney(r.planned_amount)}</td>
                <td
                  className={cn(
                    "py-2 pr-2 text-right tabular-nums",
                    r.actual_amount > 0 ? "text-victory" : "text-muted-foreground/40",
                  )}
                >
                  {fmtMoney(r.actual_amount)}
                </td>
                <td className="py-2">
                  <span
                    className={cn(
                      "inline-block rounded-full border px-2 py-0.5 text-[10px] font-display uppercase tracking-widest",
                      stateBadge[state].cls,
                    )}
                  >
                    {r.status ?? stateBadge[state].label}
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
              right={<span className="text-victory">{fmtMoney(r.planned_amount)}</span>}
            />
            <div className="flex flex-wrap gap-1.5">
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-display uppercase tracking-widest",
                  stateBadge[state].cls,
                )}
              >
                {r.status ?? stateBadge[state].label}
              </span>
              {r.office && (
                <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  {r.office === "San Diego" ? "SD" : "OC"}
                </span>
              )}
            </div>
            <MobileStatGrid cols={3}>
              <MobileStat label="Due" value={r.anticipated_date ?? "—"} />
              <MobileStat label="Collected" value={fmtMoney(r.actual_amount)} lit="text-victory" />
              <MobileStat label="Milestone" value={r.milestone ?? "—"} />
            </MobileStatGrid>
          </MobileCard>
        ))}
      </MobileCardList>

      {sorted.length > PAYMENTS_CAP && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="min-h-11 md:min-h-0 text-[10px] font-display uppercase tracking-widest text-neon hover:underline"
        >
          {showAll ? "Show fewer" : `Show all ${sorted.length}`}
        </button>
      )}
    </div>
  );
}

function CrewLink({
  to,
  label,
  value,
  sub,
  accent,
}: {
  to: string;
  label: string;
  value: string;
  sub?: string;
  accent: StatTileAccent;
}) {
  const [pathname, search] = to.split("?");
  const searchObj = search ? Object.fromEntries(new URLSearchParams(search).entries()) : undefined;
  return (
    <ArcadeCard asChild className="hover:border-neon/50 transition-colors">
      <Link to={pathname} search={searchObj}>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          {label}
        </div>
        <div
          className={cn("mt-1 font-display text-xl break-words", {
            "text-neon": accent === "neon",
            "text-victory": accent === "victory",
            "text-accent": accent === "accent",
            "text-warning": accent === "warning",
            "text-destructive": accent === "destructive",
            "text-muted-foreground": accent === "muted",
          })}
        >
          {value}
        </div>
        {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
      </Link>
    </ArcadeCard>
  );
}
