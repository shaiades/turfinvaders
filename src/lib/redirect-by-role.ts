import { supabase } from "@/integrations/supabase/client";
import { isManagerRole } from "@/lib/roles";

export type RoleDestination = {
  to: "/field" | "/dashboard" | "/close-kombat";
  search?: { tab: "executive" };
};

/**
 * Canvasser-only accounts land on /field, sales-rep-only accounts on
 * /close-kombat; everyone else gets the executive dashboard. Shared by the
 * auth page and the OAuth callback.
 */
export async function destinationByRole(userId: string): Promise<RoleDestination> {
  const { data } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role as string);
  const isManager = roles.some(isManagerRole);
  if (roles.includes("sales_rep") && !isManager && !roles.includes("canvasser")) {
    return { to: "/close-kombat" };
  }
  const isCanvasserOnly = roles.includes("canvasser") && !isManager;
  return isCanvasserOnly ? { to: "/field" } : { to: "/dashboard", search: { tab: "executive" } };
}
