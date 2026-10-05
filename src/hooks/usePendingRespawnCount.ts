import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { isAdminRole } from "@/lib/role-policy";
import { useAuth } from "@/hooks/useAuth";

/**
 * Pending Respawn (shift-off) requests awaiting a decision — powers the Close
 * Kombat nav badge. Same discipline as usePendingProofCount: Admin tier only
 * (the approvers), head-count query, 0 on any error (migration not applied
 * included), 60s poll.
 */
export function usePendingRespawnCount(): number {
  const { realRole } = useAuth();
  const enabled = isAdminRole(realRole);
  const { data } = useQuery({
    enabled,
    queryKey: ["respawn_pending_count"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("respawn_requests")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending");
      if (error) return 0;
      return count ?? 0;
    },
  });
  return enabled ? (data ?? 0) : 0;
}
