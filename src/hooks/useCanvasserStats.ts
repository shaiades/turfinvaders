import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  addDaysISO,
  laMidnightUtcISO,
  laMonthStartISO,
  laTodayISO,
  laWeekStartISO,
} from "@/lib/dates";
import {
  COMMISSION_BASE,
  commissionRateForPoints,
  payRateForPoints,
  weeklyPoints,
} from "@/lib/pay";
import { useFunnelRates } from "@/hooks/useFunnelRates";
import { useMyEarnings } from "@/hooks/useMyEarnings";
import { useCanvasserProfile } from "@/hooks/useCanvasserProfile";
import {
  sumLogCounters,
  useSixtyDayLogs,
  useTodayLogs,
  type DailyLogRow,
} from "@/hooks/useDailyLogs";

/**
 * Every number the canvasser Mission page shows, in one hook: aggregates
 * from the shared 60-day / today daily_logs caches, pay-engine earnings,
 * funnel rates, and the profile goals. All day/week/month buckets are
 * America/Los_Angeles (midnight PT resets).
 *
 * Paycheck engine notes (mirrors calc_weekly_paycheck via @/lib/pay):
 *   weekPoints = demos_sits + sales (pitch-miss sit = 1, sale = 2)
 *   < 3 pts → $18/hr + 1% · ≥ 3 pts → $30/hr + 1% · ≥ 7 pts → $35/hr + 2%
 */

/** Fallback monthly financial goal default (USD) until canvasser sets their own. */
export const DEFAULT_MONTHLY_GOAL = 10_000;
/** Fallback weekly income goal default (USD). */
export const DEFAULT_WEEKLY_GOAL = 2_000;
/** Last-resort avg commission so the funnel back-solve can never divide by 0. */
export const DEFAULT_AVG_COMMISSION = 200;

export type Totals = {
  doors_knocked: number;
  people_talked_to: number;
  leads_called_in: number;
  confirmed_leads: number;
  next_days: number;
  future_leads: number;
  demos_sits: number;
  sales: number;
  no_shows: number;
  days_worked: number;
};
const ZERO: Totals = {
  doors_knocked: 0,
  people_talked_to: 0,
  leads_called_in: 0,
  confirmed_leads: 0,
  next_days: 0,
  future_leads: 0,
  demos_sits: 0,
  sales: 0,
  no_shows: 0,
  days_worked: 0,
};

function aggregate(rows: readonly DailyLogRow[]): Totals {
  const t = { ...ZERO };
  const days = new Set<string>();
  for (const r of rows) {
    t.doors_knocked += r.doors_knocked ?? 0;
    t.people_talked_to += r.people_talked_to ?? 0;
    t.leads_called_in += r.leads_called_in ?? 0;
    t.confirmed_leads += r.confirmed_leads ?? 0;
    t.next_days += r.next_days ?? 0;
    t.future_leads += r.future_leads ?? 0;
    t.demos_sits += r.demos_sits ?? 0;
    t.sales += r.sales ?? 0;
    t.no_shows += r.no_shows ?? 0;
    const hadActivity =
      (r.doors_knocked ?? 0) + (r.leads_called_in ?? 0) + (r.confirmed_leads ?? 0) > 0;
    if (hadActivity && typeof r.log_date === "string") days.add(r.log_date);
  }
  t.days_worked = days.size;
  return t;
}

export function useCanvasserStats(userId: string) {
  const profile = useCanvasserProfile(userId);
  const funnelRates = useFunnelRates(userId);
  const earnings = useMyEarnings(userId);
  const logsQuery = useSixtyDayLogs(userId);
  const todayQuery = useTodayLogs(userId);

  const monthlyGoal = Number(profile.data?.monthly_goal ?? DEFAULT_MONTHLY_GOAL);
  const weeklyGoal = Number(profile.data?.weekly_income_goal ?? DEFAULT_WEEKLY_GOAL);
  // Income semantics (owner, 2026-07-29): required sales = goal ÷ avg
  // commission per sale. One fallback chain everywhere (2026-08-14): the
  // canvasser's own number wins, else the company 60d average, else $200 so
  // the back-solve can never divide by zero.
  const avgCommission =
    Number(profile.data?.avg_commission ?? 0) ||
    funnelRates.companyAvgCommission ||
    DEFAULT_AVG_COMMISSION;

  const salesQuery = useQuery({
    queryKey: ["my_confirmed_sales", "mtd", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leads")
        .select("sale_amount, created_at")
        .eq("canvasser_id", userId)
        .eq("status", "confirmed")
        .eq("is_sale", true)
        .gte("created_at", laMidnightUtcISO(laMonthStartISO()));
      if (error) throw error;
      return data ?? [];
    },
  });

  // Real clocked hours this week — base pay comes only from clocked time
  // (no activity-based estimates; no clock-in means no base pay).
  const clockedQuery = useQuery({
    queryKey: ["my_clocked_hours", "week", userId],
    queryFn: async () => {
      // Mon–Sat window, matching calc_weekly_paycheck exactly.
      const weekStart = laWeekStartISO();
      const { data, error } = await supabase
        .from("time_entries")
        .select("billable_hours")
        .eq("user_id", userId)
        .gte("log_date", weekStart)
        .lte("log_date", addDaysISO(weekStart, 5))
        .not("clock_out", "is", null);
      if (error) throw error;
      return (data ?? []).reduce((a, r) => a + Number(r.billable_hours ?? 0), 0);
    },
  });

  const derived = useMemo(() => {
    const allRows = logsQuery.data ?? [];
    const w = laWeekStartISO(),
      m = laMonthStartISO();
    const week = aggregate(allRows.filter((r) => r.log_date >= w));
    const month = aggregate(allRows.filter((r) => r.log_date >= m));

    const sales = salesQuery.data ?? [];
    const monthRevenue = sales.reduce((a, r) => a + Number(r.sale_amount ?? 0), 0);
    const wStartMs = Date.parse(laMidnightUtcISO(w));
    const weekRevenue = sales
      .filter((r) => Date.parse(r.created_at) >= wStartMs)
      .reduce((a, r) => a + Number(r.sale_amount ?? 0), 0);

    const weekPoints = weeklyPoints(week.demos_sits, week.sales);
    const weekHours = clockedQuery.data ?? 0;
    const hourlyRate = payRateForPoints(weekPoints);
    const weekBase = weekHours * hourlyRate;
    const weekCommission = weekRevenue * commissionRateForPoints(weekPoints);
    // Month-level projection uses the base rate — the real per-week rate comes from the RPC.
    const monthCommission = monthRevenue * COMMISSION_BASE;

    const personalAgg = aggregate(allRows);
    return {
      week,
      month,
      monthRevenue,
      weekRevenue,
      weekPoints,
      weekHours,
      hourlyRate,
      weekBase,
      weekCommission,
      monthCommission,
      personalTalkRatio:
        personalAgg.doors_knocked > 0
          ? personalAgg.people_talked_to / personalAgg.doors_knocked
          : null,
    };
  }, [logsQuery.data, salesQuery.data, clockedQuery.data]);

  // Talk-per-door: personal 60d history when it's driving the rates,
  // industry-typical ~27% otherwise (talks aren't in the company baseline).
  const talkDoorRate =
    funnelRates.source === "personal" && derived.personalTalkRatio != null
      ? derived.personalTalkRatio
      : 0.27;

  // Live whole-day totals across office rows — updates per pin drop.
  const today = sumLogCounters(todayQuery.data);

  // Pay-engine truth (base + commission + sit/monster bonuses, rank locks
  // honored); the client estimate only bridges the loading gap.
  const weeklyPay = earnings.weekPaycheck?.total_pay ?? derived.weekBase + derived.weekCommission;

  const lpd =
    derived.week.days_worked > 0 ? derived.week.confirmed_leads / derived.week.days_worked : 0;
  const goalProgress = monthlyGoal > 0 ? Math.min(1, earnings.monthEarned / monthlyGoal) : 0;

  return {
    ...derived,
    talkDoorRate,
    today,
    weeklyPay,
    lpd,
    monthlyGoal,
    weeklyGoal,
    avgCommission,
    goalProgress,
    profile,
    funnelRates,
    earnings,
  };
}

export type CanvasserStatsData = ReturnType<typeof useCanvasserStats>;
