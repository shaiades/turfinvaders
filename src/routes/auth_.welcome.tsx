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
 *  change-password screen.
 *
 *  Links arrive as ?th=<recovery token hash>. NOTHING is consumed on page
 *  load — iMessage/WhatsApp/email preview bots prefetch invite links, and
 *  the old auto-consuming action_link died to the first bot that touched it
 *  ("links expire instantly", 2026-09-11). The token is spent only when the
 *  invitee taps ENTER (verifyOtp). Legacy links (supabase action_link with
 *  #access_token/?code) keep working through the fallback effect below. */
export const Route = createFileRoute("/auth_/welcome")({
  // Token processing happens client-side only (same rule as /auth/callback).
  ssr: false,
  head: () => ({ meta: [{ title: "Welcome — Turf Invaders" }] }),
  component: WelcomePage,
});

function WelcomePage() {
  const navigate = useNavigate();
  const [tokenHash, setTokenHash] = useState<string | null>(null);
  const [entering, setEntering] = useState(false);
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

    // Tap-to-enter invite: hold the token, show the button, consume nothing.
    const th = params.get("th");
    if (th) {
      setTokenHash(th);
      return;
    }

    // Legacy path: supabase-js picks the session out of the URL on client
    // init (detectSessionInUrl handles both ?code= and #access_token=
    // forms); we just wait for it, exactly like /auth/callback.
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

  /** The tap that actually spends the one-time token. On success the URL is
   *  scrubbed so a reload can't re-spend it; if it was already used but this
   *  browser already holds the session (double-tap, reload after entering),
   *  fall through to the password screen instead of crying expired. */
  async function enterWithInvite() {
    if (!tokenHash) return;
    setEntering(true);
    const { data, error } = await supabase.auth.verifyOtp({
      type: "recovery",
      token_hash: tokenHash,
    });
    if (data?.session?.user) {
      window.history.replaceState(null, "", window.location.pathname);
      setUserId(data.session.user.id);
      setTokenHash(null);
      setEntering(false);
      return;
    }
    if (error) {
      const { data: sess } = await supabase.auth.getSession();
      if (sess.session?.user) {
        window.history.replaceState(null, "", window.location.pathname);
        setUserId(sess.session.user.id);
        setTokenHash(null);
      } else {
        setExpired(true);
      }
    }
    setEntering(false);
  }

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
              This invite link was already used or has expired — links last about an hour, and a
              newer link replaces older ones. Ask your manager for a fresh one, or sign in if you
              already have a password.
            </p>
            <Link to="/auth" className="text-xs text-neon underline underline-offset-4">
              Go to sign in
            </Link>
          </div>
        ) : tokenHash && !userId ? (
          <div className="text-center space-y-4">
            <h1 className="font-display text-sm text-neon">YOUR INVITE IS READY</h1>
            <p className="text-xs text-muted-foreground">
              Tap the button to sign in to your Turf Invaders account — then set your own password.
            </p>
            <Button
              className="w-full font-display uppercase tracking-widest"
              onClick={enterWithInvite}
              disabled={entering}
            >
              {entering ? "Signing you in…" : "▶ Enter"}
            </Button>
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
