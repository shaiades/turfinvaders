import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // getSession() reads the locally persisted session — no network. The old
    // getUser() validated over the network on every invalidation/preload, so
    // one transient failure bounced a signed-in user to /auth. Revocation is
    // still enforced: RLS rejects a dead session's queries, and the
    // SIGNED_OUT invalidation in __root re-runs this guard with no session.
    const { data, error } = await supabase.auth.getSession();
    if (!error && !data.session) throw redirect({ to: "/auth" });
    return { user: data.session?.user ?? null };
  },
  component: () => <AppShell><Outlet /></AppShell>,
});
