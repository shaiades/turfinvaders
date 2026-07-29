import { redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

/** All app roles, in priority order (highest first). sales_rep (closers,
 *  added 2026-07-29 for Close Kombat) sits above canvasser: a rep sees only
 *  their stats section, never the canvassing suite. */
export const APP_ROLES = ["owner", "office_staff", "captain", "sales_rep", "canvasser"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export function isAppRole(v: unknown): v is AppRole {
  return (APP_ROLES as readonly unknown[]).includes(v);
}

/** Manager tier: owner, captain, and office_staff (the "admin" role) all get full managerial access. */
export const MANAGER_ROLES: readonly AppRole[] = ["owner", "captain", "office_staff"] as const;

export function isManagerRole(role: AppRole | string | null | undefined): boolean {
  if (!role) return false;
  return (MANAGER_ROLES as readonly string[]).includes(role);
}

/** Admin tier: owner and office_staff ONLY — captains are deliberately
 *  excluded. Gates the owner dashboard, the confirmation desk, and
 *  admin-only editing. Never widen a check from this to MANAGER_ROLES. */
export const ADMIN_ROLES: readonly AppRole[] = ["owner", "office_staff"] as const;

export function isAdminRole(role: AppRole | string | null | undefined): boolean {
  if (!role) return false;
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

/** Close Kombat (sales-rep stats): owner, office_staff, and the reps
 *  themselves — captains deliberately excluded (owner decision 2026-07-29).
 *  Gates the /close-kombat route; block_cards RLS mirrors this list. */
export const CLOSE_KOMBAT_ROLES: readonly AppRole[] = [
  "owner",
  "office_staff",
  "sales_rep",
] as const;

/** Highest-priority role held: owner > office_staff > captain > sales_rep >
 *  canvasser; null when none of the app roles are present. */
export function primaryRole(roles: ReadonlyArray<AppRole | string>): AppRole | null {
  for (const r of APP_ROLES) if (roles.includes(r)) return r;
  return null;
}

/** TanStack Router beforeLoad factory: not signed in → /auth; signed in
 *  without any of the allowed roles → /dashboard?tab=dispatch. */
export function requireRoleBeforeLoad(allowed: readonly AppRole[]) {
  return async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
    const { data: roles } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", data.user.id)
      .in("role", [...allowed]);
    if (!roles || roles.length === 0) {
      throw redirect({ to: "/dashboard", search: { tab: "dispatch" } });
    }
  };
}
