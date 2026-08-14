import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { addDaysISO, laTodayISO } from "@/lib/dates";

/**
 * The ONE source for the signed-in canvasser's own daily_logs. Every
 * self-scoped read lives under the ["daily_logs", userId] prefix so a single
 * invalidation (log save, pin drop, realtime ping) reaches the Log form, the
 * Stats aggregates, the HUD, and the Active Run tally at once — the old
 * ["my_logs"] / ["daily_logs","today"] / ["field-tally"] keys could not see
 * each other's writes.
 *
 * Rows are per (canvasser, log_date, office_location): a rep who works two
 * offices in one day has two rows. Reads here are whole-day (no office
 * filter); only the Log form's WRITE targets the home-office row.
 */

export const dailyLogKeys = {
  all: (userId: string) => ["daily_logs", userId] as const,
  today: (userId: string, date: string) => ["daily_logs", userId, "today", date] as const,
  // Deliberately date-free: a date-suffixed key would strand the cache at
  // midnight PT. The 60-day window is computed inside the queryFn at fetch time.
  sixtyDay: (userId: string) => ["daily_logs", userId, "60d"] as const,
};

export const DAILY_LOG_COUNTERS = [
  "doors_knocked",
  "people_talked_to",
  "renters",
  "leads_called_in",
  "confirmed_leads",
  "next_days",
  "future_leads",
  "demos_sits",
  "sales",
  "one_legs",
  "no_shows",
  "no_demo",
  "not_interested",
] as const;
export type DailyLogCounter = (typeof DAILY_LOG_COUNTERS)[number];

export type DailyLogRow = Partial<Record<DailyLogCounter, number | null>> & {
  log_date: string;
  office_location?: string | null;
  notes?: string | null;
};

export type DailyLogTotals = Record<DailyLogCounter, number>;

/** Whole-day totals across every office row (plus any optimistic rows). */
export function sumLogCounters(rows: readonly DailyLogRow[] | undefined): DailyLogTotals {
  const t = Object.fromEntries(DAILY_LOG_COUNTERS.map((k) => [k, 0])) as DailyLogTotals;
  for (const r of rows ?? []) {
    for (const k of DAILY_LOG_COUNTERS) t[k] += r[k] ?? 0;
  }
  return t;
}

/** The row the manual Log form edits — the canvasser's home-office row. */
export function findOfficeRow(rows: readonly DailyLogRow[] | undefined, office: string) {
  return (rows ?? []).find((r) => r.office_location === office);
}

/** All of today's rows (every office), select * so the Log form has the full
 *  counter set + notes. */
export function useTodayLogs(userId: string | undefined) {
  const today = laTodayISO();
  return useQuery({
    enabled: !!userId,
    queryKey: dailyLogKeys.today(userId ?? "", today),
    staleTime: 10_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("daily_logs")
        .select("*")
        .eq("canvasser_id", userId!)
        .eq("log_date", today);
      if (error) throw error;
      return (data ?? []) as unknown as DailyLogRow[];
    },
  });
}

const SIXTY_DAY_COLS =
  "log_date, doors_knocked, people_talked_to, leads_called_in, confirmed_leads, next_days, future_leads, demos_sits, sales, no_shows";

/** Last 60 days of rows — serves the Stats week/month aggregates AND the
 *  personal funnel-rate derivation (one fetch, was two). staleTime keeps tab
 *  flips from refetching 60 rows; writes invalidate the prefix. */
export function useSixtyDayLogs(userId: string | undefined) {
  return useQuery({
    enabled: !!userId,
    queryKey: dailyLogKeys.sixtyDay(userId ?? ""),
    staleTime: 60_000,
    queryFn: async () => {
      const since = addDaysISO(laTodayISO(), -60);
      const { data, error } = await supabase
        .from("daily_logs")
        .select(SIXTY_DAY_COLS)
        .eq("canvasser_id", userId!)
        .gte("log_date", since);
      if (error) throw error;
      return (data ?? []) as unknown as DailyLogRow[];
    },
  });
}

export type SaveTodayLogInput = {
  office: string;
  teamId: string | null;
  /** ONLY the fields the user actually edited. PostgREST builds
   *  `ON CONFLICT … DO UPDATE SET` from the columns present in the payload,
   *  so a pin bumped into an untouched column between form load and Save
   *  survives — sending the whole form would silently revert it. */
  patch: Partial<Record<DailyLogCounter, number>> & { notes?: string };
};

export function useSaveTodayLog(userId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ office, teamId, patch }: SaveTodayLogInput) => {
      if (!userId) throw new Error("Not signed in");
      const payload = {
        canvasser_id: userId,
        team_id: teamId,
        log_date: laTodayISO(),
        office_location: office,
        ...patch,
      };
      const { error } = await supabase
        .from("daily_logs")
        .upsert(payload, { onConflict: "canvasser_id,log_date,office_location" });
      if (error) throw error;
    },
    onSuccess: () => {
      if (userId) qc.invalidateQueries({ queryKey: dailyLogKeys.all(userId) });
    },
  });
}
