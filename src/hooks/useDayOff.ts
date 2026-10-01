import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { invalidatePunchCaches } from "@/lib/time-clock-keys";

/**
 * Day-off / absence data layer. Every key sits under ["day-off", …] so one
 * prefix invalidation refreshes every surface, and every read treats an
 * error as "table not deployed yet" (migration 20261002180000) and renders
 * nothing — the whole feature ships dark until the SQL lands.
 */

export type DayOffKind = "day_off" | "sick" | "no_show" | "excused" | "other";
export type DayOffStatus = "pending" | "approved" | "denied" | "cancelled";

export type DayOffRow = {
  id: string;
  user_id: string;
  absence_date: string;
  kind: DayOffKind;
  status: DayOffStatus;
  reason: string | null;
  requested_by: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  deny_reason: string | null;
  created_at: string;
};

export const KIND_LABEL: Record<DayOffKind, string> = {
  day_off: "Day off",
  sick: "Sick",
  no_show: "No-show",
  excused: "Excused",
  other: "Other",
};

export type SubmitDayOffResult = {
  ok: number;
  skipped: number;
  results: Array<{ date: string; status: "ok" | "skipped" | "error"; code?: string }>;
};

/** My own upcoming + recent rows (self RLS). null = table not deployed. */
export function useMyDayOff(userId: string, sinceISO: string) {
  return useQuery({
    queryKey: ["day-off", "mine", userId, sinceISO],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("day_off_requests")
        .select("*")
        .eq("user_id", userId)
        .gte("absence_date", sinceISO)
        .in("status", ["pending", "approved", "denied"])
        .order("absence_date", { ascending: true })
        .limit(20);
      if (error) return null;
      return (data ?? []) as DayOffRow[];
    },
  });
}

/** Pending queue — teamId scopes to a van (captains), omit for everyone. */
export function useDayOffQueue(teamId?: string | null) {
  return useQuery({
    queryKey: ["day-off", "queue", teamId ?? "all"],
    queryFn: async () => {
      let memberIds: string[] | null = null;
      if (teamId) {
        const { data: members, error: mErr } = await supabase
          .from("profiles")
          .select("id")
          .eq("team_id", teamId);
        if (mErr) return null;
        memberIds = (members ?? []).map((m) => m.id);
        if (memberIds.length === 0)
          return { rows: [] as DayOffRow[], names: new Map<string, string>() };
      }
      let q = supabase
        .from("day_off_requests")
        .select("*")
        .eq("status", "pending")
        .order("absence_date", { ascending: true })
        .limit(50);
      if (memberIds) q = q.in("user_id", memberIds);
      const { data, error } = await q;
      if (error) return null;
      const rows = (data ?? []) as DayOffRow[];
      const ids = [...new Set(rows.map((r) => r.user_id))];
      const names = new Map<string, string>();
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, display_name")
          .in("id", ids);
        for (const p of profs ?? []) names.set(p.id, p.display_name ?? "Unknown");
      }
      return { rows, names };
    },
  });
}

/** Approved absences inside a week (for the Mon–Sun strip). */
export function useDayOffWeek(weekStartISO: string, weekEndISO: string, teamId?: string | null) {
  return useQuery({
    queryKey: ["day-off", "week", weekStartISO, teamId ?? "all"],
    queryFn: async () => {
      let memberIds: string[] | null = null;
      if (teamId) {
        const { data: members, error: mErr } = await supabase
          .from("profiles")
          .select("id")
          .eq("team_id", teamId);
        if (mErr) return null;
        memberIds = (members ?? []).map((m) => m.id);
        if (memberIds.length === 0)
          return { rows: [] as DayOffRow[], names: new Map<string, string>() };
      }
      let q = supabase
        .from("day_off_requests")
        .select("*")
        .eq("status", "approved")
        .gte("absence_date", weekStartISO)
        .lte("absence_date", weekEndISO)
        .order("absence_date", { ascending: true })
        .limit(200);
      if (memberIds) q = q.in("user_id", memberIds);
      const { data, error } = await q;
      if (error) return null;
      const rows = (data ?? []) as DayOffRow[];
      const ids = [...new Set(rows.map((r) => r.user_id))];
      const names = new Map<string, string>();
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, display_name")
          .in("id", ids);
        for (const p of profs ?? []) names.set(p.id, p.display_name ?? "Unknown");
      }
      return { rows, names };
    },
  });
}

export function useDayOffMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["day-off"] });
    // An approved/recorded absence changes the dispatch Day roster labels.
    invalidatePunchCaches(qc);
  };

  const submit = useMutation({
    mutationFn: async (vars: {
      userId: string;
      dates: string[];
      kind: DayOffKind;
      reason?: string;
    }) => {
      const { data, error } = await supabase.rpc("submit_day_off", {
        _user_id: vars.userId,
        _dates: vars.dates,
        _kind: vars.kind,
        _reason: vars.reason ?? null,
      });
      if (error) throw error;
      return data as unknown as SubmitDayOffResult;
    },
    onSuccess: refresh,
  });

  const review = useMutation({
    mutationFn: async (vars: { id: string; approve: boolean; denyReason?: string }) => {
      const { error } = await supabase.rpc("review_day_off", {
        _id: vars.id,
        _approve: vars.approve,
        _deny_reason: vars.denyReason ?? null,
      });
      if (error) throw error;
    },
    onSuccess: refresh,
  });

  const cancel = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("cancel_day_off", { _id: id });
      if (error) throw error;
    },
    onSuccess: refresh,
  });

  return { submit, review, cancel };
}
