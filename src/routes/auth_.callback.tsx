import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { destinationByRole } from "@/lib/redirect-by-role";

export const Route = createFileRoute("/auth_/callback")({
  // The PKCE code exchange only happens in the browser; never render this on the server.
  ssr: false,
  head: () => ({ meta: [{ title: "Turf Invaders" }] }),
  component: AuthCallbackPage,
});

function AuthCallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const providerError = params.get("error_description") ?? params.get("error");
    if (providerError) {
      setError(providerError);
      return;
    }

    let done = false;
    const finish = async (userId: string) => {
      if (done) return;
      done = true;
      const dest = await destinationByRole(userId);
      navigate({ to: dest.to, search: dest.search as never, replace: true });
    };

    // supabase-js exchanges the ?code= from the URL automatically on client
    // init (detectSessionInUrl + PKCE); we just wait for the session.
    supabase.auth.getSession().then(({ data }) => {
      if (data.session?.user) void finish(data.session.user.id);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session?.user) void finish(session.user.id);
    });

    const timeout = setTimeout(() => {
      if (!done) setError("Sign-in timed out. Please try again.");
    }, 15000);

    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [navigate]);

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="arcade-card p-8 text-center max-w-sm w-full">
        {error ? (
          <>
            <h1 className="font-display text-sm text-destructive mb-3">SIGN-IN FAILED</h1>
            <p className="text-xs text-muted-foreground mb-6">{error}</p>
            <Link
              to="/auth"
              className="inline-block bg-primary text-primary-foreground font-display text-xs uppercase tracking-widest py-3 px-6 rounded-md hover:opacity-90"
            >
              Back to sign in
            </Link>
          </>
        ) : (
          <>
            <h1 className="font-display text-sm text-neon mb-3">SIGNING YOU IN…</h1>
            <p className="text-xs text-muted-foreground">Loading your run.</p>
          </>
        )}
      </div>
    </div>
  );
}
