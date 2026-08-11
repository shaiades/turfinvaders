import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { AppRole } from "@/lib/roles";

/** Atomic role swap via the set_user_role RPC. The function enforces the
 *  real guardrails server-side: manager-tier caller, captains/admins limited
 *  to canvasser/sales_rep/captain and blocked from Owner/Admin targets,
 *  last-owner protection. Shared by Manage Players and the Permissions tab. */
export function useSetUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: AppRole }) => {
      const { error } = await supabase.rpc("set_user_role", {
        _target_user: userId,
        _new_role: role,
      });
      if (error) throw error;
    },
    onSuccess: () => toast.success("Role updated"),
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["manage_users"] });
      qc.invalidateQueries({ queryKey: ["cleanup_inventory"] });
      qc.invalidateQueries({ queryKey: ["fleet_dispatch"] });
    },
  });
}
