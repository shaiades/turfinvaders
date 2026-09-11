import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { assigneeColor } from "@/lib/assignee-colors";
import type { ZipTint } from "@/components/ZipBorders";
import { toast } from "sonner";

/**
 * ZIP → captain assignments (zip_assignments, migration 20260911100000).
 * Admins assign; captains chunk their ZIPs into turfs with the existing
 * drawing flow. Readable by every authenticated user; the tint map colors
 * assigned ZCTA polygons with the captain's assignee color so ZIP zones and
 * that captain's turfs read as one palette.
 */

export type ZipAssignmentRow = {
  zip: string;
  captain_id: string;
  assigned_at: string;
  captain: { display_name: string | null } | null;
};

export function useZipAssignments(opts?: { enabled?: boolean }) {
  return useQuery({
    enabled: opts?.enabled ?? true,
    queryKey: ["zip_assignments"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("zip_assignments")
        .select(
          // Two FKs point at profiles (captain_id, assigned_by) — the embed
          // must name the constraint or PostgREST rejects it as ambiguous.
          "zip, captain_id, assigned_at, captain:profiles!zip_assignments_captain_id_fkey(display_name)",
        )
        .order("zip");
      if (error) throw error;
      return (data ?? []) as unknown as ZipAssignmentRow[];
    },
  });
}

/** First name keeps the on-map pill short ("Jorge", not "Jorge Najera"). */
const firstName = (name: string | null | undefined) =>
  (name ?? "").trim().split(/\s+/)[0] || "Captain";

export function zipTintsFrom(rows: ZipAssignmentRow[] | undefined): Record<string, ZipTint> {
  const tints: Record<string, ZipTint> = {};
  for (const r of rows ?? []) {
    tints[r.zip] = {
      color: assigneeColor(r.captain_id),
      label: firstName(r.captain?.display_name),
    };
  }
  return tints;
}

export function useZipTints(opts?: { enabled?: boolean }) {
  const q = useZipAssignments(opts);
  const tints = useMemo(() => zipTintsFrom(q.data), [q.data]);
  return { ...q, tints };
}

/** Admin mutations: assign (upsert — reassign overwrites) and unassign. */
export function useZipAssignmentActions() {
  const qc = useQueryClient();

  const assign = useMutation({
    mutationFn: async ({ zip, captain_id }: { zip: string; captain_id: string }) => {
      const { error } = await supabase
        .from("zip_assignments")
        .upsert({ zip, captain_id }, { onConflict: "zip" });
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success(`📮 ZIP ${vars.zip} assigned`);
      qc.invalidateQueries({ queryKey: ["zip_assignments"] });
    },
    onError: (e: Error) => toast.error(`Couldn't assign ZIP: ${e.message}`, { duration: 8000 }),
  });

  const unassign = useMutation({
    mutationFn: async (zip: string) => {
      const { error } = await supabase.from("zip_assignments").delete().eq("zip", zip);
      if (error) throw error;
    },
    onSuccess: (_d, zip) => {
      toast.success(`ZIP ${zip} unassigned`);
      qc.invalidateQueries({ queryKey: ["zip_assignments"] });
    },
    onError: (e: Error) => toast.error(`Couldn't unassign ZIP: ${e.message}`, { duration: 8000 }),
  });

  return { assign, unassign };
}
