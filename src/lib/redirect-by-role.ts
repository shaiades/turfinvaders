import { supabase } from "@/integrations/supabase/client";
import { isManagerRole, privilegeRole } from "@/lib/roles";

export type RoleDestination = {
  to: "/field" | "/dashboard" | "/close-kombat" | "/reports";
  search?: { tab: "dispatch" } | { tab: "exports" };
};

/**
 * Canvasser-only accounts land on /field, sales-rep-only accounts on
 * /close-kombat; everyone else gets the merged Fleet Dispatch command tab.
 * Shared by the auth page and the OAuth callback.
 */
export async function destinationByRole(userId: string): Promise<RoleDestination> {
  const { data } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  // Collapse to privilege tiers so a confirmer-only account routes exactly
  // like a canvasser-only one (→ /field).
  const roles = (data ?? []).map((r) => privilegeRole(r.role as string) as string);
  const isManager = roles.some(isManagerRole);
  // Cage wins for dual-role closer+knocker accounts too (owner call
  // 2026-09-12): sales_rep outranks canvasser in primaryRole, so AppShell
  // would bounce a /field landing straight to /close-kombat anyway — the
  // old canvasser carve-out here was dead code telling the other story.
  if (roles.includes("sales_rep") && !isManager) {
    return { to: "/close-kombat" };
  }
  // Mary's whole app is the Reports console (read-only payroll + exports).
  if (roles.includes("bookkeeper") && !isManager) {
    return { to: "/reports", search: { tab: "exports" } };
  }
  const isCanvasserOnly = roles.includes("canvasser") && !isManager;
  return isCanvasserOnly ? { to: "/field" } : { to: "/dashboard", search: { tab: "dispatch" } };
}
