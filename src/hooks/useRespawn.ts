import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  applyApprovedRespawnsForWeek,
  cancelRespawnRequest,
  reviewRespawnRequest,
  submitRespawnRequest,
} from "@/lib/respawn.functions";
import type { RepOffice, RespawnStatus } from "@/lib/respawn";

/**
 * Respawn (sales-rep shift-off) data layer. Reads go straight through the
 * browser client under RLS (reps see their own rows, approvers see all);
 * writes go through the server fns so Monday stays in sync. Every key sits
 * under ["respawn", …] for one-prefix invalidation, and every read treats an
 * error as "table not deployed yet" (migration 20261006120000) and renders
 * nothing — the feature ships dark until the SQL lands.
 */

export type RespawnRow = {
  id: string;
  user_id: string;
  rep_name: string;
  office: RepOffice | string;
  week_start: string;
  shifts: string[];
  approved_shifts: string[] | null;
  reason: string | null;
  status: RespawnStatus;
  late: boolean;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  monday_item_id: string | null;
  created_at: string;
  updated_at: string;
};

const SELECT = "*";

/** My own requests from a week onward (RLS self). null = table not deployed. */
export function useMyRespawn(userId: string | null, sinceISO: string) {
  return useQuery({
    queryKey: ["respawn", "mine", userId ?? "none", sinceISO],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("respawn_requests")
        .select(SELECT)
        .eq("user_id", userId!)
        .gte("week_start", sinceISO)
        .order("week_start", { ascending: true })
        .limit(30);
      if (error) return null;
      return (data ?? []) as RespawnRow[];
    },
  });
}

/** My request for one specific week (the popup's "already on file?" check). */
export function useMyRespawnForWeek(userId: string | null, weekStartISO: string, enabled = true) {
  return useQuery({
    queryKey: ["respawn", "mine-week", userId ?? "none", weekStartISO],
    enabled: enabled && !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("respawn_requests")
        .select(SELECT)
        .eq("user_id", userId!)
        .eq("week_start", weekStartISO)
        .maybeSingle();
      if (error) return null;
      return (data ?? null) as RespawnRow | null;
    },
  });
}

/** Approver queue: every request for the current week onward (RLS admin). */
export function useRespawnQueue(fromWeekISO: string, enabled = true) {
  return useQuery({
    queryKey: ["respawn", "queue", fromWeekISO],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("respawn_requests")
        .select(SELECT)
        .gte("week_start", fromWeekISO)
        .order("week_start", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(300);
      if (error) return null;
      return (data ?? []) as RespawnRow[];
    },
  });
}

export function useRespawnMutations() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["respawn"] });

  const submit = useMutation({
    mutationFn: (vars: { weekStart: string; shifts: string[]; reason?: string }) =>
      submitRespawnRequest({ data: vars }),
    onSuccess: refresh,
  });

  const review = useMutation({
    mutationFn: (vars: {
      id: string;
      approve: boolean;
      note?: string;
      approvedShifts?: string[];
    }) => reviewRespawnRequest({ data: vars }),
    onSuccess: refresh,
  });

  const cancel = useMutation({
    mutationFn: (id: string) => cancelRespawnRequest({ data: { id } }),
    onSuccess: refresh,
  });

  const applyWeek = useMutation({
    mutationFn: (weekStart: string) => applyApprovedRespawnsForWeek({ data: { weekStart } }),
    onSuccess: refresh,
  });

  return { submit, review, cancel, applyWeek };
}
