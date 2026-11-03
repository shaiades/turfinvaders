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

export type ConfirmedMetricRow = {
  canvasser_id: string;
  metric_date: string;
  leads_confirmed: number | null;
  team_id: string | null;
};

/**
 * Confirmed-lead counts for a date window, straight from daily_metrics — the
 * ONE source for "confirmed" on every surface (daily_logs.confirmed_leads is
 * a dead column nothing writes). Multi-canvasser surfaces (Command Center,
 * Executive raw table, player profiles) aggregate these rows themselves.
 */
export async function fetchConfirmedByCanvasserDay(opts: {
  sinceISO: string;
  untilISO?: string | null;
  teamId?: string | null;
  canvasserId?: string | null;
}): Promise<ConfirmedMetricRow[]> {
  let q = supabase
    .from("daily_metrics")
    .select("canvasser_id, metric_date, leads_confirmed, team_id")
    .gte("metric_date", opts.sinceISO);
  if (opts.untilISO) q = q.lte("metric_date", opts.untilISO);
  if (opts.teamId) q = q.eq("team_id", opts.teamId);
  if (opts.canvasserId) q = q.eq("canvasser_id", opts.canvasserId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as ConfirmedMetricRow[];
}
