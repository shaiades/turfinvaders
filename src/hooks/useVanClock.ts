import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { laTodayISO } from "@/lib/dates";
import { invalidatePunchCaches } from "@/lib/time-clock-keys";

/** One van member's live punch state, as the Van Clock console renders it. */
export type MemberClockState = {
  openEntryId: string | null;
  clockIn: string | null;
  onLunchSince: string | null;
  /** Billable hours already closed today. */
  todayHours: number;
  /** Last clock-out today (null while open or not in yet). */
  lastOut: string | null;
};

export type CrewActionResult = {
  ok: number;
  skipped: number;
  results: Array<{
    user_id: string;
    status: "ok" | "skipped" | "error";
    code?: string;
    entry_id?: string;
    closed_lunch?: boolean;
  }>;
};

/**
 * Live punch state for the whole van in two queries (+ one for open meals).
 * Polling is the guarantee — time_entries realtime delivery is unreliable
 * (see FleetDispatch) — so the console re-reads every 30s and after every
 * bulk action via invalidatePunchCaches.
 */
export function useVanClockStatus(teamId: string, memberIds: string[]) {
  const today = laTodayISO();
  return useQuery({
    enabled: memberIds.length > 0,
    refetchInterval: 30_000,
    queryKey: ["van-clock", "status", teamId, today, [...memberIds].sort().join("|")],
    queryFn: async () => {
      const [openRes, todayRes] = await Promise.all([
        supabase
          .from("time_entries")
          .select("id, user_id, clock_in")
          .in("user_id", memberIds)
          .is("clock_out", null)
          .is("voided_at", null),
        supabase
          .from("time_entries")
          .select("user_id, billable_hours, clock_out")
          .in("user_id", memberIds)
          .eq("log_date", today)
          .is("voided_at", null),
      ]);
      if (openRes.error) throw openRes.error;
      if (todayRes.error) throw todayRes.error;
      const open = openRes.data ?? [];
      let openMeals: Array<{ time_entry_id: string; meal_start: string }> = [];
      if (open.length > 0) {
        const { data, error } = await supabase
          .from("meal_periods")
          .select("time_entry_id, meal_start")
          .in(
            "time_entry_id",
            open.map((o) => o.id),
          )
          .is("meal_end", null);
        if (error) throw error;
        openMeals = data ?? [];
      }
      const mealByEntry = new Map(openMeals.map((m) => [m.time_entry_id, m.meal_start]));
      const byUser = new Map<string, MemberClockState>();
      for (const id of memberIds) {
        byUser.set(id, {
          openEntryId: null,
          clockIn: null,
          onLunchSince: null,
          todayHours: 0,
          lastOut: null,
        });
      }
      for (const o of open) {
        const s = byUser.get(o.user_id);
        if (!s) continue;
        s.openEntryId = o.id;
        s.clockIn = o.clock_in;
        s.onLunchSince = mealByEntry.get(o.id) ?? null;
      }
      for (const t of todayRes.data ?? []) {
        const s = byUser.get(t.user_id);
        if (!s) continue;
        s.todayHours += Number(t.billable_hours ?? 0);
        if (t.clock_out && (!s.lastOut || t.clock_out > s.lastOut)) s.lastOut = t.clock_out;
      }
      return byUser;
    },
  });
}

export type CrewAction = "clock_in" | "clock_out" | "start_lunch" | "end_lunch";

const CREW_RPC: Record<CrewAction, "crew_clock_in" | "crew_clock_out" | "crew_start_lunch" | "crew_end_lunch"> = {
  clock_in: "crew_clock_in",
  clock_out: "crew_clock_out",
  start_lunch: "crew_start_lunch",
  end_lunch: "crew_end_lunch",
};

/** One mutation for all four bulk punches. The RPCs are "now"-only and
 *  skip-and-report per member; authorization errors are the only throws. */
export function useCrewAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ action, userIds }: { action: CrewAction; userIds: string[] }) => {
      const { data, error } = await supabase.rpc(CREW_RPC[action], { _user_ids: userIds });
      if (error) throw error;
      return data as unknown as CrewActionResult;
    },
    onSuccess: () => invalidatePunchCaches(qc),
  });
}
