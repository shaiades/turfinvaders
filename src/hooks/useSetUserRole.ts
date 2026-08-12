import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { AppRole } from "@/lib/roles";

/** Atomic role swap via the set_user_role RPC. The RPC is the authoritative
 *  gate: owner-only caller (owner decision 2026-08-12) plus last-owner
 *  protection; a non-owner call fails and surfaces the RPC's error as a
 *  toast. Shared by Manage Players and the New Signups panel. */
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
