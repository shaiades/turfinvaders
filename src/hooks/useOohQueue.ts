import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { laMidnightUtcISO } from "@/lib/dates";
import {
  getOohConfig,
  listMissingReports,
  nextLeadForRep,
  pushLeadIssue,
  resolveOohQueueItem,
} from "@/lib/ooh.functions";
import type { OohConfig, OohQueueRow } from "@/lib/ooh";

/**
 * OOH admin data layer. The queue reads straight through the browser client
 * under RLS (owner / office_staff only); writes and the Monday-touching reads
 * (missing reports, push lead) go through server fns. Every key sits under
 * ["ooh", …]; each read treats an error as "table not deployed yet"
 * (migration 20261008120000) and renders nothing — the feature ships dark.
 */

/** The admin queue: dry-run previews, unmatched submissions, errors. */
export function useOohQueue(enabled = true) {
  return useQuery({
    queryKey: ["ooh", "queue"],
    enabled,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ooh_report_queue")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) return null;
      return (data ?? []) as OohQueueRow[];
    },
  });
}

/** Non-sensitive OOH config (mode, form URL) for the UI. */
export function useOohConfig(enabled = true) {
  return useQuery<OohConfig>({
    queryKey: ["ooh", "config"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: () => getOohConfig(),
  });
}

/** Missing-reports list (admin; reads the current blocks via a server fn). */
export function useMissingReports(enabled = true) {
  return useQuery({
    queryKey: ["ooh", "missing"],
    enabled,
    refetchInterval: 120_000,
    queryFn: () => listMissingReports(),
  });
}

/** Today's LA calendar date (the dispatcher's day key). */
export function laToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

export type AttendanceOverrideRow = {
  id: string;
  office: string;
  rep_name: string;
  for_date: string;
  status: string;
};

/**
 * Manager attendance overrides for TODAY (owner 10/6): the Monday attendance
 * board is sometimes wrong, so an override set here beats it in live dispatch.
 * Admin-gated by RLS (owner / office_staff).
 */
export function useAttendanceOverrides(enabled = true) {
  return useQuery({
    queryKey: ["ooh", "att_overrides", laToday()],
    enabled,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("attendance_overrides")
        .select("id, office, rep_name, for_date, status")
        .eq("for_date", laToday())
        .order("office")
        .order("rep_name");
      if (error) return null; // table not deployed yet → feature ships dark
      return (data ?? []) as AttendanceOverrideRow[];
    },
  });
}

export function useAttendanceOverrideMutations() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["ooh", "att_overrides"] });

  const upsert = useMutation({
    mutationFn: async (vars: { office: "SD" | "OC"; repName: string; status: "on" | "off" }) => {
      const { data: auth } = await supabase.auth.getSession();
      const uid = auth.session?.user.id ?? null;
      // One override per rep/office/day (unique on the rep's FIRST name): drop
      // any existing row for the same first name, then insert the new state.
      const first = vars.repName.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      const { data: existing, error: readErr } = await supabase
        .from("attendance_overrides")
        .select("id, rep_name")
        .eq("for_date", laToday())
        .eq("office", vars.office);
      if (readErr) throw readErr;
      const dupIds = (existing ?? [])
        .filter((r) => (r.rep_name ?? "").trim().split(/\s+/)[0]?.toLowerCase() === first)
        .map((r) => r.id);
      if (dupIds.length > 0) {
        const { error } = await supabase.from("attendance_overrides").delete().in("id", dupIds);
        if (error) throw error;
      }
      const { error } = await supabase.from("attendance_overrides").insert({
        office: vars.office,
        rep_name: vars.repName.trim(),
        for_date: laToday(),
        status: vars.status,
        created_by: uid,
      });
      if (error) throw error;
    },
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("attendance_overrides").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: refresh,
  });

  return { upsert, remove };
}

export type DispatchDecisionRow = {
  id: string;
  created_at: string;
  mode: string;
  trigger: string;
  rep_name: string | null;
  office: string | null;
  lead_item_id: string | null;
  lead_name: string | null;
  action: string;
  score: number | null;
  drive_minutes: number | null;
  strength: number | null;
  reason: string | null;
  issued: boolean;
};

/**
 * Today's (LA) live-dispatch decision log — every issue / would-issue /
 * manager / none / alert call with its reason, so the office can audit the
 * dispatcher from the cockpit instead of a chat window. Polls (realtime
 * discipline: aggregates poll); RLS = owner / office_staff.
 */
export function useDispatchDecisions(enabled = true) {
  return useQuery({
    queryKey: ["ooh", "decisions", laToday()],
    enabled,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ooh_dispatch_decisions")
        .select(
          "id, created_at, mode, trigger, rep_name, office, lead_item_id, lead_name, action, score, drive_minutes, strength, reason, issued",
        )
        .gte("created_at", laMidnightUtcISO(laToday()))
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) return null; // table not deployed yet → feature ships dark
      return (data ?? []) as DispatchDecisionRow[];
    },
  });
}

export function useOohMutations() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["ooh"] });

  const resolve = useMutation({
    mutationFn: (vars: { id: string; action: "dismissed" | "processed" }) =>
      resolveOohQueueItem({ data: vars }),
    onSuccess: refresh,
  });

  const pushLead = useMutation({
    mutationFn: (vars: { boardId: string; itemId: string }) => pushLeadIssue({ data: vars }),
    onSuccess: refresh,
  });

  // Resolve the rep's NEXT not-issued lead (name + time) before a Push (#12).
  // A read, not a write — so it does NOT invalidate the queue.
  const nextLead = useMutation({
    mutationFn: (vars: { boardId: string; repName: string }) => nextLeadForRep({ data: vars }),
  });

  return { resolve, pushLead, nextLead };
}
