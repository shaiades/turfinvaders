import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  addOohQueueNote,
  getOohConfig,
  listMissingReports,
  nextLeadForRep,
  pushLeadIssue,
  resolveOohQueueItem,
  setDispatchMode,
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

  // Post a skipped report's note onto its matched card (activity Update), then
  // mark the queue item handled. The note-rescue for reports the auto-writeback
  // didn't write (already dispositioned / non-allow-listed board).
  const addNote = useMutation({
    mutationFn: (vars: { id: string }) => addOohQueueNote({ data: vars }),
    onSuccess: refresh,
  });

  // Resolve the rep's NEXT not-issued lead (name + time) before a Push (#12).
  // A read, not a write — so it does NOT invalidate the queue.
  const nextLead = useMutation({
    mutationFn: (vars: { boardId: string; repName: string }) => nextLeadForRep({ data: vars }),
  });

  // Flip the live-dispatch mode (owner only; the server fn enforces it). The
  // Dispo chip cycles off → dry_run → live. Refresh so the chip reflects it.
  const dispatchMode = useMutation({
    mutationFn: (vars: { mode: "off" | "dry_run" | "live" }) => setDispatchMode({ data: vars }),
    onSuccess: refresh,
  });

  return { resolve, pushLead, nextLead, addNote, dispatchMode };
}
