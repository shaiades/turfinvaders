import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { laMonthStartISO, laTodayISO, laWeekStartISO } from "@/lib/dates";
import { getWeeklyPaychecks, getMonthlyPaychecks } from "@/lib/fleet.functions";
import type { PaycheckRow, MonthlyPaycheckRow } from "@/lib/fleet.functions";
import { HOURLY_BASE } from "@/lib/pay";

/**
 * The current canvasser's OWN pay-engine truth for the goal math (owner,
 * 2026-07-29: goals mean total take-home — base + commission + bonuses).
 *
 * - weekEarned  = this week's calc_weekly_paycheck total_pay.
 * - monthEarned = calc_monthly_paycheck total_pay (weekly totals + volume
 *   bonus). Straddling weeks count in full at both month edges — that is the
 *   engine's own monthly definition, and the same row TakeHomeWidget shows,
 *   so "earned so far" can never disagree with the take-home number beside it.
 * - avgDailyBase projects future hourly: MTD clocked hours ÷ distinct clocked
 *   days × the current week's tier rate (best forward-looking rate).
 */
export function useMyEarnings(userId: string): {
  weekEarned: number;
  monthEarned: number;
  weekPaycheck: PaycheckRow | null;
  monthPaycheck: MonthlyPaycheckRow | null;
  avgDailyBase: number;
  isLoading: boolean;
} {
  const weekStart = laWeekStartISO();
  const monthStart = laMonthStartISO();

  const weekQ = useQuery({
    queryKey: ["earnings", "week", userId, weekStart],
    queryFn: async () => {
      const { results } = await getWeeklyPaychecks({
        data: { week_start: weekStart, canvasser_ids: [userId] },
      });
      return results[0]?.paycheck ?? null;
    },
  });

  // Deliberately the same key TakeHomeWidget has always used — one fetch,
  // one cache entry, zero chance of two different month figures on the page.
  const monthQ = useQuery({
    queryKey: ["takehome_volume_bonus", userId, monthStart],
    queryFn: async () => {
      const { results } = await getMonthlyPaychecks({
        data: { month_start: monthStart, canvasser_ids: [userId] },
      });
      return results[0]?.paycheck ?? null;
    },
  });

  const clockQ = useQuery({
    queryKey: ["earnings", "clock-days", userId, monthStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_entries")
        .select("log_date, billable_hours")
        .eq("user_id", userId)
        .gte("log_date", monthStart)
        .lte("log_date", laTodayISO())
        .not("clock_out", "is", null);
      if (error) throw error;
      const rows = data ?? [];
      const mtdHours = rows.reduce((a, r) => a + Number(r.billable_hours ?? 0), 0);
      const clockDays = new Set(rows.map((r) => r.log_date)).size;
      return { mtdHours, clockDays };
    },
  });

  const mtdHours = clockQ.data?.mtdHours ?? 0;
  const clockDays = clockQ.data?.clockDays ?? 0;
  const forwardRate = weekQ.data?.hourly_rate ?? HOURLY_BASE;
  const avgDailyBase = clockDays > 0 ? (mtdHours / clockDays) * forwardRate : 0;

  return {
    weekEarned: Number(weekQ.data?.total_pay ?? 0),
    monthEarned: Number(monthQ.data?.total_pay ?? 0),
    weekPaycheck: weekQ.data ?? null,
    monthPaycheck: monthQ.data ?? null,
    avgDailyBase,
    isLoading: weekQ.isLoading || monthQ.isLoading || clockQ.isLoading,
  };
}
