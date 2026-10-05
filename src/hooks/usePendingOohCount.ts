import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { isAdminRole } from "@/lib/role-policy";
import { useAuth } from "@/hooks/useAuth";

/**
 * OOH submissions awaiting the office — unmatched or errored reports in
 * ooh_report_queue. Powers the Close Kombat OOH-tab badge. Same discipline as
 * usePendingRespawnCount: admin tier only, head-count, 0 on any error, 60s poll.
 */
export function usePendingOohCount(): number {
  const { realRole } = useAuth();
  const enabled = isAdminRole(realRole);
  const { data } = useQuery({
    enabled,
    queryKey: ["ooh_pending_count"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("ooh_report_queue")
        .select("id", { count: "exact", head: true })
        .in("status", ["needs_review", "error"]);
      if (error) return 0;
      return count ?? 0;
    },
  });
  return enabled ? (data ?? 0) : 0;
}
