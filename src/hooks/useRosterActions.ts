import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type VanLite = { id: string; name: string; office_location?: string | null };

const ROSTER_KEYS = [["fleet_dispatch"], ["weekly_results"], ["payroll-ledger"], ["manage_users"]];

/** Move one person (possibly several duplicate profiles grouped under one
 *  board row) to a van or to Free Agents (null). Assigning to a van cascades
 *  the van's office onto the person, matching FleetDispatchManage. */
export function useMoveAgents(vans: VanLite[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, vanId }: { ids: string[]; vanId: string | null; name?: string }) => {
      const patch: { team_id: string | null; office_location?: string } = { team_id: vanId };
      if (vanId) {
        const van = vans.find((v) => v.id === vanId);
        if (van?.office_location) patch.office_location = van.office_location;
      }
      // .select() so an RLS-blocked update (0 rows) errors instead of
      // silently toasting success.
      const { data, error } = await supabase
        .from("profiles")
        .update(patch)
        .in("id", ids)
        .select("id");
      if (error) throw error;
      if (!data?.length) throw new Error("Move failed — you don't have permission for this agent");
    },
    onSuccess: (_d, vars) => {
      const van = vars.vanId ? vans.find((v) => v.id === vars.vanId) : null;
      toast.success(`${vars.name ?? "Agent"} moved to ${van ? van.name : "Free Agents"}`);
      for (const key of ROSTER_KEYS) qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** "Remove from roster" — archive via the archive_agent RPC (is_active=false,
 *  team_id=null, history untouched; reversible from Archived Agents). */
export function useArchiveAgents() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids }: { ids: string[]; name?: string }) => {
      for (const id of ids) {
        const { error } = await supabase.rpc("archive_agent", { _user_id: id });
        if (error) throw error;
      }
    },
    onSuccess: (_d, vars) => {
      toast.success(
        `${vars.name ?? "Agent"} removed from roster — history kept. Reactivate from Archived Agents.`,
      );
      for (const key of ROSTER_KEYS) qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to remove"),
  });
}
