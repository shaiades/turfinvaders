import { useQuery } from "@tanstack/react-query";
import { dojoTable } from "@/components/ObjectionDojo";
import { isAdminRole } from "@/lib/role-policy";
import { useAuth } from "@/hooks/useAuth";

/**
 * Pending Objection Dojo submissions awaiting review — the in-app companion
 * to the notify-dojo push (which only reaches devices that enabled alerts).
 * Powers the count badge on the Desk nav item so Owners/Managers see work
 * waiting even with push off. Admin tier only; everyone else gets 0 without
 * firing a query. Counts head-only and tolerates the table not existing yet
 * (migration-not-applied fallback used across the Dojo).
 */
export function usePendingDojoCount(): number {
  const { realRole } = useAuth();
  const enabled = isAdminRole(realRole);
  const { data } = useQuery({
    enabled,
    queryKey: ["dojo_pending_count"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count, error } = await dojoTable("objection_attempts")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending");
      if (error) return 0;
      return count ?? 0;
    },
  });
  return enabled ? (data ?? 0) : 0;
}
