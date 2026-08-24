import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { CalendarIcon, Download, Lock, FileCheck2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { fetchWeeklyPaychecksChunked, fetchMonthlyPaychecksChunked } from "@/lib/paychecks";
import { sitBonusPerForRank } from "@/lib/pay";
import {
  ArcadePanel,
  TeamBadge,
  MobileCardList,
  MobileCard,
  MobileCardHeader,
  MobileStatGrid,
  MobileStat,
  ArcadeCard,
} from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RankPill } from "@/components/RankPill";
import { useOfficeFilter } from "@/components/OfficeFilterContext";
import { cn } from "@/lib/utils";
import { addDaysISO, laMidnightUtcISO, monthStartISO, nextMonthStartISO } from "@/lib/dates";
import { useWeekSelector } from "@/hooks/useWeekSelector";

type LogRow = {
  canvasser_id: string;
  team_id: string | null;
  no_demo: number;
  one_legs: number;
  future_leads: number;
  demos_sits: number;
  sales: number;
};

// Weeks are anchored to America/Los_Angeles (midnight PT Monday reset).

type Agg = {
  bo: number;
  ol: number;
  rs: number;
  pm: number;
  sales: number;
  total: number;
  sits: number; // PM + Sale
  points: number;
  sale_amount: number;
};

function emptyAgg(): Agg {
  return { bo: 0, ol: 0, rs: 0, pm: 0, sales: 0, total: 0, sits: 0, points: 0, sale_amount: 0 };
}

/** Pay Lock states → badge copy. Anything that is neither "active" nor
 *  "reverted" reads as the softer warning (matches the original ternary). */
const PAY_LOCK_META = {
  reverted: {
    label: "Lock reverted",
    className: "text-destructive",
    title:
      "Starting Pay Lock reverted — paid on weekly point tiers until 3 consecutive 7+ sit weeks",
  },
  warning: {
    label: "Lock warning",
    className: "text-warning",
    title: "Pay Lock warning — 4-week sit average below 5",
  },
} as const;

/** Shared by the mobile card and the desktop Rank cell — renders null while
 *  the lock is active so off-state rows carry no extra DOM. */
function PayLockBadge({ status, className }: { status: string; className?: string }) {
  if (status === "active") return null;
  const meta = status === "reverted" ? PAY_LOCK_META.reverted : PAY_LOCK_META.warning;
  return (
    <div
      className={cn(
        "text-[9px] font-display uppercase tracking-widest",
        meta.className,
        className,
      )}
      title={meta.title}
    >
      {meta.label}
    </div>
  );
}

/** Hourly tier → accent (35 = top tier, 30 = mid, everything else muted). */
const RATE_TIER_TEXT: Record<number, string> = { 35: "text-victory", 30: "text-neon" };
const rateTierClass = (rate: number) => RATE_TIER_TEXT[rate] ?? "text-muted-foreground";

/** The colored "X BO, X OL, X RS, X Sit, X Sale" line — mobile and desktop
 *  render the identical markup (the CSV export keeps its plain-text twin). */
function ResultsBreakdown({ r }: { r: Agg }) {
  return (
    <>
      {r.bo} BO, {r.ol} OL, {r.rs} RS, <span className="text-neon">{r.pm} Sit</span>,{" "}
      <span className="text-victory">{r.sales} Sale</span>
    </>
  );
}

/** Total-pay cell: the engine's number, or the ERROR marker the grand-total
 *  warning refers to — one component so the two tables can't disagree. */
function PayAmount({ error, amount }: { error: string | null | undefined; amount: number }) {
  if (error) {
    return (
      <span className="text-destructive text-xs" title={error}>
        ERROR
      </span>
    );
  }
  return <>${amount.toFixed(2)}</>;
}

type RunRow = {
  id: string;
  week_start: string;
  status: string;
  created_at: string;
  approved_at: string | null;
};

/** Per-agent exception chips from the engine's exceptions jsonb. */
function ExceptionChips({ ex }: { ex: Record<string, unknown> | null | undefined }) {
  if (!ex) return null;
  const chips: string[] = [];
  const n = (k: string) => Number(ex[k] ?? 0);
  if (n("sunday_hours") > 0) chips.push(`Sunday ${n("sunday_hours").toFixed(1)}h`);
  if (n("auto_closed_entries") > 0) chips.push(`${n("auto_closed_entries")} auto-closed`);
  if (n("needs_correction") > 0) chips.push(`${n("needs_correction")} needs review`);
  if (n("meal_pending") > 0) chips.push(`${n("meal_pending")} meal ?`);
  if (n("meal_unrecorded") > 0) chips.push(`${n("meal_unrecorded")} lunch times`);
  if (ex["below_min_wage"] === true) chips.push("below min wage");
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {chips.map((c) => (
        <span
          key={c}
          className="text-[9px] font-display uppercase tracking-widest text-warning border border-warning/40 rounded px-1"
        >
          {c}
        </span>
      ))}
    </div>
  );
}

export function PayrollLedger() {
  const { matches, office } = useOfficeFilter();
  const qc = useQueryClient();
  // Default to last week; Mon..Sun workweek (Sundays unscheduled but paid).
  const {
    weekStart,
    weekEnd,
    weekStartISO: startStr,
    weekEndISO: endStr,
    shiftWeek,
    goToWeek,
  } = useWeekSelector({ initialOffsetWeeks: -1 });
  const [pickerOpen, setPickerOpen] = useState(false);

  // The frozen-run state for this week drives the review → approve flow.
  const runQuery = useQuery({
    queryKey: ["payroll-run", startStr],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_runs")
        .select("id, week_start, status, created_at, approved_at")
        .eq("week_start", startStr)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as RunRow | null;
    },
  });
  const run = runQuery.data ?? null;

  const createRun = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("create_payroll_run", { _week_start: startStr });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Draft run created — review the lines, then approve to freeze");
      qc.invalidateQueries({ queryKey: ["payroll-run", startStr] });
    },
    onError: (e: Error) => toast.error("Couldn't create run", { description: e.message }),
  });

  const approveRun = useMutation({
    mutationFn: async () => {
      if (!run) throw new Error("Create a draft run first");
      const { error } = await supabase.rpc("approve_payroll_run", { _run_id: run.id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Payroll run approved and frozen");
      qc.invalidateQueries({ queryKey: ["payroll-run", startStr] });
    },
    onError: (e: Error) =>
      toast.error("Approval blocked", {
        description: e.message,
        duration: 9000,
      }),
  });

  const { data, isLoading, isError } = useQuery({
    queryKey: ["payroll-ledger", startStr, endStr],
    queryFn: async () => {
      // LA-midnight boundaries; exclusive upper bound (start of the next LA
      // day) so timestamps in the final second of the window are not missed.
      const windowStart = laMidnightUtcISO(startStr);
      const windowEnd = laMidnightUtcISO(addDaysISO(endStr, 1));
      const [logsRes, leadsRes, profilesRes, teamsRes, timeRes] = await Promise.all([
        supabase
          .from("daily_logs")
          .select("canvasser_id, team_id, no_demo, one_legs, future_leads, demos_sits, sales, log_date")
          .gte("log_date", startStr)
          .lte("log_date", endStr),
        // Only used to include sale-only canvassers in the roster; amounts come
        // from the pay engine. Windowed on both dates to match its
        // COALESCE(reviewed_at, created_at) week attribution.
        supabase
          .from("leads")
          .select("canvasser_id")
          .eq("status", "confirmed")
          .or(
            `and(created_at.gte.${windowStart},created_at.lt.${windowEnd}),and(reviewed_at.gte.${windowStart},reviewed_at.lt.${windowEnd})`,
          ),
        supabase.from("profiles").select("id, display_name, team_id, current_rank, office_location, pay_lock_status"),
        supabase.from("teams").select("id, name, color"),
        supabase
          .from("time_entries")
          .select("user_id, billable_hours, log_date, clock_out")
          .gte("log_date", startStr)
          .lte("log_date", endStr)
          .not("clock_out", "is", null),
      ]);
      if (logsRes.error) throw logsRes.error;
      if (leadsRes.error) throw leadsRes.error;
      if (profilesRes.error) throw profilesRes.error;
      if (teamsRes.error) throw teamsRes.error;
      if (timeRes.error) throw timeRes.error;

      const logs = (logsRes.data ?? []) as LogRow[];
      const timeEntries = (timeRes.data ?? []) as { user_id: string; billable_hours: number }[];
      const canvasserIds = Array.from(
        new Set([
          ...logs.map((r) => r.canvasser_id),
          ...(leadsRes.data ?? []).map((l) => l.canvasser_id),
          ...timeEntries.map((t) => t.user_id),
        ]),
      );

      // The authoritative pay engine — batched, chunked under the 300-id cap.
      const paychecks = await fetchWeeklyPaychecksChunked(startStr, canvasserIds);

      return {
        logs,
        paychecks,
        profiles: profilesRes.data ?? [],
        teams: teamsRes.data ?? [],
        timeEntries,
      };
    },
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const profileById = new Map(data.profiles.map((p) => [p.id, p]));
    const teamById = new Map(data.teams.map((t) => [t.id, t]));
    const aggByCanv = new Map<string, Agg>();

    // Outcome breakdown (BO/OL/RS/Sit/Sale) comes from daily_logs; all pay
    // figures come from the calc_weekly_paycheck engine below.
    for (const r of data.logs) {
      const a = aggByCanv.get(r.canvasser_id) ?? emptyAgg();
      const pmOnly = Math.max(0, (r.demos_sits ?? 0) - (r.sales ?? 0));
      a.bo += r.no_demo ?? 0;
      a.ol += r.one_legs ?? 0;
      a.rs += r.future_leads ?? 0;
      a.pm += pmOnly;
      a.sales += r.sales ?? 0;
      aggByCanv.set(r.canvasser_id, a);
    }

    const hoursByCanv = new Map<string, number>();
    for (const t of data.timeEntries) {
      hoursByCanv.set(t.user_id, (hoursByCanv.get(t.user_id) ?? 0) + Number(t.billable_hours ?? 0));
    }

    return data.paychecks
      .map((res) => {
        const cid = res.canvasser_id;
        const pc = res.paycheck;
        const a = aggByCanv.get(cid) ?? emptyAgg();
        a.total = a.bo + a.ol + a.rs + a.pm + a.sales;
        a.sits = Number(pc?.sits ?? 0);
        a.points = Number(pc?.points ?? 0);
        a.sale_amount = Number(pc?.sale_price_total ?? 0);
        const profile = profileById.get(cid);
        const team = profile?.team_id ? teamById.get(profile.team_id) : null;
        const rank = pc?.rank ?? (profile as { current_rank?: string | null } | undefined)?.current_rank ?? "Jr. Silver";
        const payLock = (profile as { pay_lock_status?: string | null } | undefined)?.pay_lock_status ?? "active";
        const clocked = hoursByCanv.get(cid) ?? 0;
        const hoursSource: "clocked" | "none" = clocked > 0 ? "clocked" : "none";
        const sitBonus = Number(pc?.sit_bonus ?? 0);
        const monster = Number(pc?.monster_bonus ?? 0);
        const otPremium = Number(pc?.ot_premium_pay ?? 0);
        const mealPremium = Number(pc?.meal_premium_pay ?? 0);
        return {
          id: cid,
          name: profile?.display_name ?? "Unknown",
          team,
          rank,
          ...a,
          hours: Number(pc?.hours ?? 0),
          regHours: Number(pc?.reg_hours ?? 0),
          otHours: Number(pc?.ot_hours ?? 0),
          dtHours: Number(pc?.dt_hours ?? 0),
          hoursSource,
          payLock,
          rate: Number(pc?.hourly_rate ?? 0),
          commRate: Number(pc?.commission_rate ?? 0),
          base: Number(pc?.base_pay ?? 0),
          otPremium,
          mealPremium,
          mealPremiumCount: Number(pc?.meal_premium_count ?? 0),
          premiums: otPremium + mealPremium,
          exceptions: (pc?.exceptions ?? null) as Record<string, unknown> | null,
          commission: Number(pc?.commission ?? 0),
          sitBonus,
          sitBonusPer: sitBonusPerForRank(rank),
          monster,
          bonuses: sitBonus + monster,
          totalPay: Number(pc?.total_pay ?? 0),
          payError: res.error,
        };
      })
      .filter((r) => r.total > 0 || r.sale_amount > 0 || r.hours > 0 || r.payError)
      .filter((r) => {
        const p = profileById.get(r.id) as { office_location?: string | null } | undefined;
        return matches(p?.office_location ?? null);
      })
      .sort((a, b) => b.totalPay - a.totalPay);
  }, [data, matches]);

  const { grandTotal, payErrorCount } = useMemo(
    () => ({
      grandTotal: rows.reduce((s, r) => s + r.totalPay, 0),
      payErrorCount: rows.filter((r) => r.payError).length,
    }),
    [rows],
  );

  function downloadCsv(lines: string[], frozen: boolean) {
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payroll-${startStr}-to-${endStr}${frozen ? "-approved" : "-DRAFT"}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const CSV_HEADERS = [
    "Agent Name",
    "Rank",
    "Van / Team",
    "Reg Hours",
    "OT Hours (1.5x)",
    "DT Hours (2x)",
    "Total Hours",
    "Hourly Rate",
    "Base Pay (straight time)",
    "OT Premium Pay",
    "Meal Premium Days",
    "Meal Premium Pay",
    "Total Sales Volume ($)",
    "Commission Rate",
    "Commission Earned ($)",
    "Sit Bonus",
    "Monster Bonus",
    "Total Pay ($)",
    "Exceptions",
  ];

  // The CSV exports the FROZEN run when this week is approved — the live
  // recompute can drift after edits, the approved snapshot cannot.
  async function exportCsv() {
    if (run?.status === "approved") {
      const { data, error } = await supabase
        .from("payroll_run_lines")
        .select("*")
        .eq("run_id", run.id)
        .order("total_pay", { ascending: false });
      if (error) {
        toast.error("Couldn't read the approved run", { description: error.message });
        return;
      }
      const lines = [CSV_HEADERS.join(",")];
      for (const l of data ?? []) {
        const ex = (l.exceptions ?? {}) as Record<string, unknown>;
        const cells = [
          l.display_name,
          l.rank ?? "",
          "", // team isn't snapshotted; the frozen pay figures are what matter
          Number(l.reg_hours).toFixed(2),
          Number(l.ot_hours).toFixed(2),
          Number(l.dt_hours).toFixed(2),
          Number(l.hours).toFixed(2),
          `$${l.hourly_rate}/hr`,
          Number(l.base_pay).toFixed(2),
          Number(l.ot_premium_pay).toFixed(2),
          l.meal_premium_count,
          Number(l.meal_premium_pay).toFixed(2),
          "",
          "",
          Number(l.commission).toFixed(2),
          Number(l.sit_bonus).toFixed(2),
          Number(l.monster_bonus).toFixed(2),
          Number(l.total_pay).toFixed(2),
          Object.keys(ex).filter((k) => Number(ex[k]) > 0 || ex[k] === true).join("; "),
        ];
        lines.push(cells.map(csvCell).join(","));
      }
      downloadCsv(lines, true);
      return;
    }

    const lines = [CSV_HEADERS.join(",")];
    for (const r of rows) {
      const ex = r.exceptions ?? {};
      const cells = [
        r.name,
        r.rank,
        r.team?.name ?? "Unassigned",
        r.regHours.toFixed(2),
        r.otHours.toFixed(2),
        r.dtHours.toFixed(2),
        r.hours.toFixed(2),
        `$${r.rate}/hr`,
        r.base.toFixed(2),
        r.otPremium.toFixed(2),
        r.mealPremiumCount,
        r.mealPremium.toFixed(2),
        r.sale_amount.toFixed(2),
        `${(r.commRate * 100).toFixed(0)}%`,
        r.commission.toFixed(2),
        r.sitBonus.toFixed(2),
        r.monster.toFixed(2),
        r.payError ? "ERROR" : r.totalPay.toFixed(2),
        Object.keys(ex).filter((k) => Number(ex[k]) > 0 || ex[k] === true).join("; "),
      ];
      lines.push(cells.map(csvCell).join(","));
    }
    downloadCsv(lines, false);
  }

  return (
    <div className="space-y-6">
      <ArcadeCard className="p-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Weekly Payroll Report
          </div>
          <h2 className="font-display text-lg text-neon mt-1">
            {format(weekStart, "MMM d")} → {format(weekEnd, "MMM d, yyyy")}
          </h2>
          <div className="text-xs text-muted-foreground mt-1">
            Official pay engine · Clocked time only (punched lunches deducted, Sundays paid when
            worked) · CA overtime: daily 8/12, weekly 40, 7th-day, on the blended regular rate ·
            Meal premiums auto-added · Hourly tier by points · Commission by Sale Price
          </div>
          {office !== "All" && (
            <div className="mt-3 text-[10px] font-display uppercase tracking-widest text-neon">
              Filtered · {office}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => shiftWeek(-1)}
            className="font-display text-[10px] uppercase tracking-widest"
          >
            ← Prev Week
          </Button>
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "w-full sm:w-[240px] justify-start text-left font-normal border-neon/40",
                )}
              >
                <CalendarIcon className="mr-2 h-4 w-4 text-neon" />
                Week of {format(weekStart, "PPP")}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={weekStart}
                onSelect={(d) => {
                  if (d) {
                    goToWeek(d);
                    setPickerOpen(false);
                  }
                }}
                initialFocus
                className={cn("p-3 pointer-events-auto")}
              />
            </PopoverContent>
          </Popover>
          <Button
            variant="outline"
            size="sm"
            onClick={() => shiftWeek(1)}
            className="font-display text-[10px] uppercase tracking-widest"
          >
            Next Week →
          </Button>
          <Button
            onClick={exportCsv}
            disabled={rows.length === 0}
            className="bg-victory text-background hover:bg-victory/90 font-display text-xs tracking-widest uppercase shadow-[0_0_24px_color-mix(in_oklab,var(--victory)_55%,transparent)] animate-pulse"
          >
            <Download className="w-4 h-4 mr-2" />
            Export to CSV
          </Button>
        </div>
      </ArcadeCard>

      {/* Run lifecycle: draft (review) → approved (frozen). The CSV exports
          the frozen lines once approved. */}
      <ArcadeCard className="p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs">
          {run?.status === "approved" ? (
            <>
              <Lock className="w-4 h-4 text-victory" />
              <span className="font-display uppercase tracking-widest text-victory">
                Run approved · frozen
              </span>
              <span className="text-muted-foreground">
                {run.approved_at ? format(new Date(run.approved_at), "MMM d, p") : ""} — corrections
                go on next week's run
              </span>
            </>
          ) : run?.status === "draft" ? (
            <>
              <FileCheck2 className="w-4 h-4 text-warning" />
              <span className="font-display uppercase tracking-widest text-warning">
                Draft run awaiting approval
              </span>
              <span className="text-muted-foreground">
                Resolve flagged entries, re-create if times changed, then approve to freeze.
              </span>
            </>
          ) : (
            <>
              <AlertTriangle className="w-4 h-4 text-muted-foreground" />
              <span className="text-muted-foreground">
                No payroll run yet for this week — the table below is a live estimate.
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {run?.status !== "approved" && (
            <Button
              size="sm"
              variant="outline"
              disabled={createRun.isPending}
              onClick={() => createRun.mutate()}
              className="font-display text-[10px] uppercase tracking-widest"
            >
              {run?.status === "draft" ? "Re-create draft" : "Create draft run"}
            </Button>
          )}
          {run?.status === "draft" && (
            <Button
              size="sm"
              disabled={approveRun.isPending}
              onClick={() => {
                if (confirm("Approve and freeze this week's payroll? This cannot be edited after."))
                  approveRun.mutate();
              }}
              className="bg-victory text-background hover:bg-victory/90 font-display text-[10px] uppercase tracking-widest"
            >
              Approve & freeze
            </Button>
          )}
        </div>
      </ArcadeCard>

      <ArcadePanel
        title={`Payroll Ledger · ${rows.length} agents`}
        action={
          <span className="font-display text-xs text-victory">
            GRAND TOTAL · ${grandTotal.toFixed(2)}
          </span>
        }
      >
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading payroll…</div>
        ) : isError ? (
          <div className="text-sm text-destructive">
            Couldn't load payroll for this week — check your connection and reload. Totals shown
            elsewhere may be incomplete.
          </div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-muted-foreground">No activity recorded for this week.</div>
        ) : (
          <>
            {payErrorCount > 0 && (
              <div className="mb-3 text-xs text-destructive">
                ⚠ Pay could not be computed for {payErrorCount} agent
                {payErrorCount === 1 ? "" : "s"} (marked ERROR below). The grand total and CSV
                export exclude them — retry or investigate before paying out.
              </div>
            )}
            <MobileCardList>
              {rows.map((r) => (
                <MobileCard key={r.id}>
                  <MobileCardHeader
                    left={r.name}
                    right={
                      <span className="text-victory">
                        <PayAmount error={r.payError} amount={r.totalPay} />
                      </span>
                    }
                  />
                  <div className="flex flex-wrap items-center gap-1.5">
                    <RankPill rank={r.rank} />
                    {r.team && <TeamBadge name={r.team.name} color={r.team.color} />}
                  </div>
                  <PayLockBadge status={r.payLock} />
                  <MobileStatGrid cols={3}>
                    <MobileStat label="Leads" value={r.total} className="text-victory" />
                    <MobileStat label="Sits" value={r.sits} />
                    <MobileStat label="Pts" value={r.points} className="font-display text-neon" />
                    <MobileStat
                      label="Rate"
                      value={`$${r.rate}`}
                      className={cn("font-display", rateTierClass(r.rate))}
                    />
                    <MobileStat
                      label="Hours"
                      value={
                        <>
                          {r.hours.toFixed(2)}h
                          <div className="text-[9px] text-muted-foreground">
                            {r.otHours + r.dtHours > 0
                              ? `${r.regHours.toFixed(1)} reg · ${r.otHours.toFixed(1)} OT${r.dtHours > 0 ? ` · ${r.dtHours.toFixed(1)} DT` : ""}`
                              : r.hoursSource === "clocked"
                                ? "clocked"
                                : "no time clocked"}
                          </div>
                        </>
                      }
                      className="font-display text-neon"
                    />
                    <MobileStat
                      label="Sales Vol"
                      value={`$${r.sale_amount.toFixed(2)}`}
                      className="font-display text-victory"
                    />
                    <MobileStat label="Commission" value={`$${r.commission.toFixed(2)}`} />
                    <MobileStat
                      label="Premiums"
                      value={`$${r.premiums.toFixed(2)}`}
                      className={cn(r.premiums > 0 && "text-warning")}
                    />
                    <MobileStat label="Bonuses" value={`$${r.bonuses.toFixed(2)}`} />
                  </MobileStatGrid>
                  <div className="text-xs text-muted-foreground">
                    <ResultsBreakdown r={r} />
                  </div>
                  <ExceptionChips ex={r.exceptions} />
                </MobileCard>
              ))}
              <MobileCard className="border-neon/40">
                <MobileCardHeader
                  left={
                    <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                      Grand Total · Estimated Pay
                    </span>
                  }
                  right={<span className="text-victory text-base">${grandTotal.toFixed(2)}</span>}
                />
              </MobileCard>
            </MobileCardList>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] font-display uppercase tracking-widest text-muted-foreground border-b border-border">
                    <th className="text-left py-2 pr-3">Agent</th>
                    <th className="text-left py-2 pr-3">Rank</th>
                    <th className="text-left py-2 pr-3">Van</th>
                    <th className="text-right py-2 pr-3">Leads</th>
                    <th className="text-left py-2 pr-3">Breakdown</th>
                    <th className="text-right py-2 pr-3">Sits</th>
                    <th className="text-right py-2 pr-3">Pts</th>
                    <th className="text-right py-2 pr-3">Rate</th>
                    <th className="text-right py-2 pr-3">Total Hours</th>
                    <th className="text-right py-2 pr-3">Total Sales Volume ($)</th>
                    <th className="text-right py-2 pr-3">Commission Earned ($)</th>
                    <th className="text-right py-2 pr-3">Premiums</th>
                    <th className="text-right py-2 pr-3">Bonuses</th>
                    <th className="text-right py-2 pr-1">Total Pay ($)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-border/40 transition-colors duration-200 hover:bg-surface-elevated"
                    >
                      <td className="py-2.5 pr-3 font-medium">
                        {r.name}
                        <ExceptionChips ex={r.exceptions} />
                      </td>
                      <td className="py-2.5 pr-3">
                        <RankPill rank={r.rank} />
                        <PayLockBadge status={r.payLock} className="mt-1" />
                      </td>
                      <td className="py-2.5 pr-3">
                        {r.team ? (
                          <TeamBadge name={r.team.name} color={r.team.color} />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-right text-victory">{r.total}</td>
                      <td className="py-2.5 pr-3 text-xs text-muted-foreground whitespace-nowrap">
                        <ResultsBreakdown r={r} />
                      </td>
                      <td className="py-2.5 pr-3 text-right">{r.sits}</td>
                      <td className="py-2.5 pr-3 text-right font-display text-neon">{r.points}</td>
                      <td className="py-2.5 pr-3 text-right font-display text-xs">
                        <span className={rateTierClass(r.rate)}>${r.rate}</span>
                      </td>
                      <td className="py-2.5 pr-3 text-right">
                        <div className="font-display text-neon">{r.hours.toFixed(2)}h</div>
                        <div className="text-[9px] text-muted-foreground whitespace-nowrap">
                          {r.otHours + r.dtHours > 0
                            ? `${r.regHours.toFixed(1)} reg · ${r.otHours.toFixed(1)} OT${r.dtHours > 0 ? ` · ${r.dtHours.toFixed(1)} DT` : ""}`
                            : r.hoursSource === "clocked"
                              ? "clocked"
                              : "no time clocked"}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 text-right font-display text-victory">
                        ${r.sale_amount.toFixed(2)}
                      </td>
                      <td className="py-2.5 pr-3 text-right">
                        <div>${r.commission.toFixed(2)}</div>
                        <div className="text-[9px] text-muted-foreground">
                          {(r.commRate * 100).toFixed(0)}% commission tier
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 text-right">
                        <div className={cn(r.premiums > 0 && "text-warning")}>
                          ${r.premiums.toFixed(2)}
                        </div>
                        {r.premiums > 0 && (
                          <div className="text-[9px] text-muted-foreground whitespace-nowrap">
                            {r.otPremium > 0 && `OT $${r.otPremium.toFixed(0)}`}
                            {r.otPremium > 0 && r.mealPremium > 0 && " · "}
                            {r.mealPremium > 0 && `meal ×${r.mealPremiumCount}`}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-right">
                        <div>${r.bonuses.toFixed(2)}</div>
                        {(r.sitBonus > 0 || r.monster > 0) && (
                          <div className="text-[9px] text-muted-foreground">
                            {r.sitBonus > 0 && `+$${r.sitBonus.toFixed(0)} sits`}
                            {r.sitBonus > 0 && r.monster > 0 && " · "}
                            {r.monster > 0 && `+$500 MONSTER`}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-1 text-right font-display text-victory">
                        <PayAmount error={r.payError} amount={r.totalPay} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-neon/40">
                    <td
                      colSpan={13}
                      className="py-3 text-right text-[10px] font-display uppercase tracking-widest text-muted-foreground"
                    >
                      Grand Total
                    </td>
                    <td className="py-3 pr-1 text-right font-display text-victory text-base">
                      ${grandTotal.toFixed(2)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </ArcadePanel>

      <MonthlyVolumeBonusPanel monthStart={monthStartISO(startStr)} />
    </div>
  );
}

/** "$1,500 Bonus — Every 100k In Sales for Month", per canvasser, from the
 *  calc_monthly_paycheck engine. Shows the month containing the selected week. */
function MonthlyVolumeBonusPanel({ monthStart }: { monthStart: string }) {
  const { matches } = useOfficeFilter();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["monthly-volume-bonus", monthStart],
    queryFn: async () => {
      // LA-midnight boundaries; exclusive upper bound (start of next month in
      // LA) so timestamps in the final second of the month are not missed.
      const windowStart = laMidnightUtcISO(monthStart);
      const windowEnd = laMidnightUtcISO(nextMonthStartISO(monthStart));
      const [leadsRes, profilesRes] = await Promise.all([
        supabase
          .from("leads")
          .select("canvasser_id")
          .eq("status", "confirmed")
          .or(
            `and(created_at.gte.${windowStart},created_at.lt.${windowEnd}),and(reviewed_at.gte.${windowStart},reviewed_at.lt.${windowEnd})`,
          ),
        supabase.from("profiles").select("id, display_name, office_location"),
      ]);
      if (leadsRes.error) throw leadsRes.error;
      if (profilesRes.error) throw profilesRes.error;

      const ids = Array.from(new Set((leadsRes.data ?? []).map((l) => l.canvasser_id)));
      const results = await fetchMonthlyPaychecksChunked(monthStart, ids);
      return { results, profiles: profilesRes.data ?? [] };
    },
  });

  // Memoized with a profile Map — the previous inline build re-ran a
  // profiles.find per result (O(results × profiles)) on every render.
  const { rows, totalBonus } = useMemo(() => {
    const profileById = new Map((data?.profiles ?? []).map((p) => [p.id, p]));
    const rows = (data?.results ?? [])
      .map((res) => {
        const profile = profileById.get(res.canvasser_id);
        return {
          id: res.canvasser_id,
          name: profile?.display_name ?? "Unknown",
          office:
            (profile as { office_location?: string | null } | undefined)?.office_location ?? null,
          volume: Number(res.paycheck?.sale_price_total ?? 0),
          bonus: Number(res.paycheck?.volume_bonus ?? 0),
          error: res.error,
        };
      })
      .filter((r) => (r.volume > 0 || r.error) && matches(r.office))
      .sort((a, b) => b.volume - a.volume);
    return { rows, totalBonus: rows.reduce((s, r) => s + r.bonus, 0) };
  }, [data, matches]);
  const monthLabel = format(new Date(`${monthStart}T00:00:00`), "MMMM yyyy");
  const [mYear, mMonth] = monthStart.split("-").map(Number);
  const payableLabel = format(new Date(mYear, mMonth, 1), "MMMM yyyy");

  return (
    <ArcadePanel
      title={`Monthly Volume Bonus · Earned ${monthLabel} — payable ${payableLabel}`}
      action={
        <span className="font-display text-xs text-victory">TOTAL · ${totalBonus.toFixed(2)}</span>
      }
    >
      <div className="text-xs text-muted-foreground mb-3">
        $1,500 per full $100k of confirmed sale volume in the calendar month, per agent. Bonuses are
        paid out the following month — this table is what goes on the {payableLabel} payroll.
      </div>
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading volume bonuses…</div>
      ) : isError ? (
        <div className="text-sm text-destructive">
          Couldn't load volume bonuses — check your connection and reload. Do not treat this as $0
          owed.
        </div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No confirmed sale volume this month.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-display uppercase tracking-widest text-muted-foreground border-b border-border">
                <th className="text-left py-2 pr-3">Agent</th>
                <th className="text-right py-2 pr-3">Month Volume ($)</th>
                <th className="text-right py-2 pr-3">Progress to Next $1,500</th>
                <th className="text-right py-2 pr-1">Volume Bonus ($)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-border/40 transition-colors duration-200 hover:bg-surface-elevated"
                >
                  <td className="py-2.5 pr-3 font-medium">{r.name}</td>
                  <td className="py-2.5 pr-3 text-right font-display text-victory">
                    {r.error ? "—" : `$${r.volume.toFixed(2)}`}
                  </td>
                  <td className="py-2.5 pr-3 text-right text-xs text-muted-foreground">
                    {r.error ? "—" : `$${(100000 - (r.volume % 100000)).toFixed(0)} to go`}
                  </td>
                  <td className="py-2.5 pr-1 text-right font-display">
                    {r.error ? (
                      <span className="text-destructive text-xs" title={r.error}>
                        ERROR
                      </span>
                    ) : r.bonus > 0 ? (
                      <span className="text-victory">${r.bonus.toFixed(2)}</span>
                    ) : (
                      <span className="text-muted-foreground">$0.00</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ArcadePanel>
  );
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
