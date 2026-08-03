import { redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

/** The pure role vocabulary (tiers, labels, assignability, access matrix)
 *  lives in role-policy.ts so server functions can import it without pulling
 *  in the browser supabase client. Everything is re-exported here, so
 *  `@/lib/roles` remains the one import site for browser code. */
export * from "./role-policy";

import type { AppRole } from "./role-policy";

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
