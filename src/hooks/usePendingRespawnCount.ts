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
      // One-time + recurring pending requests both land in the same queue tab.
      const [oneTime, recurring] = await Promise.all([
        supabase
          .from("respawn_requests")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending"),
        supabase
          .from("respawn_recurring")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending"),
      ]);
      return (
        (oneTime.error ? 0 : (oneTime.count ?? 0)) + (recurring.error ? 0 : (recurring.count ?? 0))
      );
    },
  });
  return enabled ? (data ?? 0) : 0;
}
