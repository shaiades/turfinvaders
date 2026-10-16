import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { isAdminRole } from "@/lib/role-policy";
import { useAuth } from "@/hooks/useAuth";

/**
 * Pending Objection Dojo submissions awaiting review — the in-app companion
 * to the notify-dojo push (which only reaches devices that enabled alerts).
 * Powers the count badge on the Desk nav item so Owners/Managers see work
 * waiting even with push off. Captains count too since Dojo v2 (they review
 * their own van) — RLS scopes their count to their crew's rows, so the same
 * head-only query serves both tiers. Everyone else gets 0 without firing a
 * query. Tolerates the table not existing yet (migration-not-applied
 * fallback used across the Dojo).
 */
export function usePendingDojoCount(): number {
  const { realRole } = useAuth();
  const enabled = isAdminRole(realRole) || realRole === "captain";
  const { data } = useQuery({
    enabled,
    queryKey: ["dojo_pending_count", realRole],
    refetchInterval: 60_000,
    queryFn: async () => {
      // Typed read since the 2026-10-16 types regen.
      const { count, error } = await supabase
        .from("objection_attempts")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending");
      if (error) return 0;
      return count ?? 0;
    },
  });
  return enabled ? (data ?? 0) : 0;
}
