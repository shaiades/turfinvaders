import { redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import type { AppRole } from "./role-policy";

/** Role vocabulary and policy live in role-policy.ts (import-free, so server
 *  functions can share it). This module re-exports all of it and adds the
 *  route-guard helper that needs the supabase client. */
export * from "./role-policy";

/** TanStack Router beforeLoad factory: not signed in → /auth; signed in
 *  without any of the allowed roles → /dashboard?tab=dispatch. Checks REAL
 *  user_roles rows, so the View As override can't bypass it.
 *
 *  Resilience (2026-08-13): guards re-run on every router invalidation and
 *  link preload, so a transient failure must never eject a signed-in user.
 *  getSession() reads the locally persisted session (no network round-trip,
 *  unlike getUser()), and only a DEFINITIVE result redirects: a failed
 *  session read or roles query lets the navigation proceed — RLS, not this
 *  UX guard, is the security boundary, and a revoked session still lands on
 *  /auth via the SIGNED_OUT invalidation in __root. NOTE: /dashboard itself
 *  must never use this guard — it is the failure-redirect target, and
 *  guarding it would loop. */
export function requireRoleBeforeLoad(allowed: readonly AppRole[]) {
  return async () => {
    const { data, error } = await supabase.auth.getSession();
    if (!error && !data.session) throw redirect({ to: "/auth" });
    const userId = data.session?.user.id;
    if (!userId) return; // session read hiccup — stay put rather than bounce
    // RLS returns EMPTY (not an error) when a query races a token refresh and
    // goes out unauthenticated — indistinguishable from "no roles". The own-
    // profile read is a sentinel every signed-in user can see; it runs in the
    // same instant, so roles-empty only ejects when the batch was provably
    // authenticated. Sentinel missing/errored → stay put.
    const [rolesRes, profileRes] = await Promise.all([
      supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .in("role", [...allowed]),
      supabase.from("profiles").select("id").eq("id", userId).maybeSingle(),
    ]);
    if (
      !rolesRes.error &&
      !profileRes.error &&
      profileRes.data &&
      (rolesRes.data ?? []).length === 0
    ) {
      throw redirect({ to: "/dashboard", search: { tab: "dispatch" } });
    }
  };
}
