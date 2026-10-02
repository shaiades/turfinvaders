import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { isAdminRole } from "@/lib/role-policy";
import { useAuth } from "@/hooks/useAuth";

/**
 * Pending Kombat Month proof submissions awaiting review — powers the Desk
 * nav badge alongside usePendingDojoCount, same discipline: Admin tier
 * only, head-count query, 0 on any error (migration-not-applied included).
 */
export function usePendingProofCount(): number {
  const { realRole } = useAuth();
  const enabled = isAdminRole(realRole);
  const { data } = useQuery({
    enabled,
    queryKey: ["kombat_pending_proofs"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("contest_proofs")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending");
      if (error) return 0;
      return count ?? 0;
    },
  });
  return enabled ? (data ?? 0) : 0;
}
