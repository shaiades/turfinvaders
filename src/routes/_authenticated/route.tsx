import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  component: AuthenticatedLayout,
});

/** The session lives in localStorage only (see integrations/supabase/client),
 *  so the server can never know whether a visitor is signed in — hence
 *  ssr:false above. That used to pair with a `beforeLoad` redirect, but
 *  `beforeLoad` resolves (and swaps the router's matched route to /auth)
 *  as part of the SAME render pass React uses to hydrate the server's
 *  markup, before ssr:false's own ClientOnly gate ever gets a chance to
 *  keep the first paint empty. Server sends nothing, client briefly wants
 *  to hydrate straight into /auth's real content instead — a guaranteed
 *  hydration mismatch (React error #418) on every signed-out load.
 *
 *  Doing the check inside a mount effect instead means the FIRST client
 *  render always matches the server (null, same as ClientOnly's fallback);
 *  the redirect only fires after that commit has already succeeded, as an
 *  ordinary post-mount navigation rather than something hydration has to
 *  reconcile against. */
function AuthenticatedLayout() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // getSession() reads the locally persisted session — no network. The old
    // getUser() validated over the network on every check, so one transient
    // failure bounced a signed-in user to /auth; a failed read here just
    // leaves the guard pending rather than ejecting anyone.
    supabase.auth.getSession().then(({ data, error }) => {
      if (cancelled) return;
      if (!error && !data.session) navigate({ to: "/auth", replace: true });
      else setReady(true);
    });
    // Revocation is still enforced: RLS rejects a dead session's queries,
    // and a real SIGNED_OUT here (not the tab-focus re-emits __root already
    // filters) sends the user back to /auth immediately.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") navigate({ to: "/auth", replace: true });
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [navigate]);

  if (!ready) return null;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
