import { redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import type { AppRole } from "./role-policy";

/** Role vocabulary and policy live in role-policy.ts (import-free, so server
 *  functions can share it). This module re-exports all of it and adds the
 *  route-guard helper that needs the supabase client. */
export * from "./role-policy";

/** TanStack Router beforeLoad factory: not signed in → /auth; signed in
 *  without any of the allowed roles → /dashboard?tab=dispatch. Checks REAL
 *  user_roles rows, so the View As override can't bypass it. NOTE: /dashboard
 *  itself must never use this guard — it is the failure-redirect target, and
 *  guarding it would loop. */
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
