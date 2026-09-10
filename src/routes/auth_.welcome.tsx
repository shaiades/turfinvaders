import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArcadeCard } from "@/components/arcade";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { destinationByRole } from "@/lib/redirect-by-role";
import { toast } from "sonner";

/** Landing page for manager-generated invite links (invites.functions.ts).
 *  The link signs the person into their EXISTING account (all history
 *  attached); this page has them set a password so they can log in normally
 *  from then on, then routes them by role. Also works for anyone already
 *  signed in who needs a new password — the app has no other
 *  change-password screen. */
export const Route = createFileRoute("/auth_/welcome")({
  // Token processing happens client-side only (same rule as /auth/callback).
  ssr: false,
  head: () => ({ meta: [{ title: "Welcome — Turf Invaders" }] }),
  component: WelcomePage,
});

function WelcomePage() {
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const providerError = params.get("error_description") ?? params.get("error");
    if (providerError) {
      setExpired(true);
      return;
    }

    // supabase-js picks the session out of the URL on client init
    // (detectSessionInUrl handles both ?code= and #access_token= forms);
    // we just wait for it, exactly like /auth/callback.
    let done = false;
    supabase.auth.getSession().then(({ data }) => {
      if (data.session?.user && !done) {
        done = true;
        setUserId(data.session.user.id);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if ((event === "SIGNED_IN" || event === "PASSWORD_RECOVERY") && session?.user && !done) {
        done = true;
        setUserId(session.user.id);
      }
    });
    const timeout = setTimeout(() => {
      if (!done) setExpired(true);
    }, 15000);
    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, []);

  async function savePassword() {
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      toast.error("Passwords don't match");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      toast.success("Password set — you're in!");
      const dest = await destinationByRole(userId as string);
      navigate({ to: dest.to, search: dest.search as never, replace: true });
    } catch (e) {
      toast.error((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <ArcadeCard className="p-8 max-w-sm w-full">
        {expired ? (
          <div className="text-center">
            <h1 className="font-display text-sm text-destructive mb-3">LINK EXPIRED</h1>
            <p className="text-xs text-muted-foreground mb-6">
              This invite link was already used or has expired. Ask your manager for a fresh one, or
              sign in if you already have a password.
            </p>
            <Link to="/auth" className="text-xs text-neon underline underline-offset-4">
              Go to sign in
            </Link>
          </div>
        ) : !userId ? (
          <div className="text-center">
            <h1 className="font-display text-sm text-neon mb-3">CHECKING YOUR INVITE…</h1>
            <p className="text-xs text-muted-foreground">One moment.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <h1 className="font-display text-sm text-neon">WELCOME TO TURF INVADERS</h1>
              <p className="text-xs text-muted-foreground mt-2">
                You're signed in. Set a password so you can log in on your own from now on.
              </p>
            </div>
            <Input
              type="password"
              autoComplete="new-password"
              placeholder="New password (8+ characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Input
              type="password"
              autoComplete="new-password"
              placeholder="Repeat password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            <Button className="w-full" onClick={savePassword} disabled={saving}>
              {saving ? "Saving…" : "Set password & enter"}
            </Button>
          </div>
        )}
      </ArcadeCard>
    </div>
  );
}
