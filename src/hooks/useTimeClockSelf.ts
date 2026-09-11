import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { laTodayISO } from "@/lib/dates";

/**
 * The canvasser's own punch state, extracted from TimeClock so the HUD's
 * off-the-clock warning reads the SAME cache entries the punch buttons
 * invalidate — one queryFn each, no drift, no duplicate fetches.
 */

/** The open (un-clocked-out) shift, newest first; null when off the clock.
 *  Punch state must be KNOWN, not assumed — consumers treat pending/error
 *  as unknown, never as "off the clock". */
export function useOpenShift(userId: string) {
  return useQuery({
    queryKey: ["time-clock-open", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_entries")
        .select("id, clock_in, clock_out, log_date, billable_hours, meal_status")
        .eq("user_id", userId)
        .is("clock_out", null)
        .order("clock_in", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/** Today's non-voided shifts, oldest first. */
export function useTodayShifts(userId: string) {
  const today = laTodayISO();
  return useQuery({
    queryKey: ["time-clock-today", userId, today],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_entries")
        .select("id, clock_in, clock_out, billable_hours, meal_status, entry_source, voided_at")
        .eq("user_id", userId)
        .eq("log_date", today)
        .is("voided_at", null)
        .order("clock_in", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}
