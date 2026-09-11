import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { addDaysISO, laTodayISO } from "@/lib/dates";

/**
 * The canvasser's own daily_metrics rows — the office pipeline's day-by-day
 * truth (confirms/submits land here via the Monday sync, never in
 * daily_logs.confirmed_leads, which nothing writes). Feeds the personal
 * funnel rates; date-free key so midnight PT can't strand the cache.
 */
export function useSixtyDaySelfMetrics(userId: string | undefined) {
  return useQuery({
    enabled: !!userId,
    queryKey: ["self_metrics", userId, "60d"],
    staleTime: 60_000,
    queryFn: async () => {
      const since = addDaysISO(laTodayISO(), -60);
      const { data, error } = await supabase
        .from("daily_metrics")
        .select("metric_date, leads_confirmed")
        .eq("canvasser_id", userId!)
        .gte("metric_date", since);
      if (error) throw error;
      return (data ?? []) as Array<{ metric_date: string; leads_confirmed: number | null }>;
    },
  });
}
