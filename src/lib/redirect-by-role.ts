import { supabase } from "@/integrations/supabase/client";

export type RoleDestination = {
  to: "/field" | "/dashboard";
  search?: { tab: "executive" };
};

/**
 * Canvasser-only accounts land on /field; everyone else gets the
 * executive dashboard. Shared by the auth page and the OAuth callback.
 */
export async function destinationByRole(userId: string): Promise<RoleDestination> {
  const { data } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role as string);
  const isCanvasserOnly =
    roles.includes("canvasser") &&
    !roles.some((r) => r === "owner" || r === "captain" || r === "office_staff");
  return isCanvasserOnly ? { to: "/field" } : { to: "/dashboard", search: { tab: "executive" } };
}
