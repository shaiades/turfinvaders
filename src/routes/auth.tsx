import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { destinationByRole } from "@/lib/redirect-by-role";
import { toast } from "sonner";
import turfInvadersHero from "@/assets/turf-invaders-hero.png.asset.json";

export const Route = createFileRoute("/auth")({
  head: () => ({ meta: [{ title: "Turf Invaders" }] }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function redirectByRole(userId: string) {
    const dest = await destinationByRole(userId);
    navigate({ to: dest.to, search: dest.search as never });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signin") {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        toast.success("Welcome back!");
        if (data.user) await redirectByRole(data.user.id);
        else navigate({ to: "/field" });
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: name || email.split("@")[0] },
            emailRedirectTo: window.location.origin,
          },
        });
        if (error) throw error;
        if (!data.session) {
          toast.success("Check your email to confirm your account.");
          return;
        }
        toast.success("Account ready — grab your clipboard!");
        navigate({ to: "/field" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setBusy(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    // On success the browser navigates away to Google; only errors return here.
    if (error) {
      toast.error(error.message);
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center px-4 py-12 relative overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-0 bg-cover bg-center opacity-30"
        style={{ backgroundImage: `url(${turfInvadersHero.url})` }}
      />
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/80 to-background"
      />
      <div className="w-full max-w-md relative">
        <Link to="/" className="flex items-center justify-center mb-6" aria-label="Turf Invaders">
          <img
            src={turfInvadersHero.url}
            alt="Turf Invaders"
            style={{ maxWidth: 300 }}
            className="w-full h-auto object-contain drop-shadow-[0_0_28px_color-mix(in_oklab,var(--neon)_65%,transparent)]"
          />
        </Link>
        <div className="arcade-card arcade-card-glow p-8">
          <h1 className="font-display text-base text-neon text-center mb-1">
            {mode === "signin" ? "INSERT CREDENTIALS" : "NEW PLAYER"}
          </h1>
          <p className="text-xs text-center text-muted-foreground mb-6">
            {mode === "signin" ? "Continue your run" : "Press start to begin"}
          </p>

          <form onSubmit={submit} className="space-y-3" method="post" autoComplete="on">
            {mode === "signup" && (
              <Field
                label="Player name"
                value={name}
                onChange={setName}
                placeholder="Your name"
                autoComplete="name"
                name="name"
              />
            )}
            <Field
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              required
              autoComplete="email"
              name="email"
            />
            <Field
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              required
              minLength={6}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              name="password"
            />
            <button
              disabled={busy}
              className="w-full bg-primary text-primary-foreground font-display text-xs uppercase tracking-widest py-3 rounded-md hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
            </button>
          </form>

          <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" /> OR <div className="h-px flex-1 bg-border" />
          </div>

          <button
            onClick={google}
            disabled={busy}
            className="w-full border border-border hover:bg-surface-elevated py-3 rounded-md text-sm font-medium flex items-center justify-center gap-2"
          >
            <GoogleIcon /> Continue with Google
          </button>

          <button
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            className="block mx-auto mt-6 text-xs text-muted-foreground hover:text-foreground"
          >
            {mode === "signin" ? "Need an account? Sign up" : "Already a player? Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required,
  minLength,
  placeholder,
  autoComplete,
  name,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  minLength?: number;
  placeholder?: string;
  autoComplete?: string;
  name?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        minLength={minLength}
        placeholder={placeholder}
        autoComplete={autoComplete}
        name={name}
        className="mt-1 w-full bg-input border border-border rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
      />
    </label>
  );
}

function GoogleIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 48 48">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 8 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.6 16 19 13 24 13c3 0 5.8 1.1 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.4-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.6l6.2 5.2C41.4 35.5 44 30.2 44 24c0-1.3-.1-2.3-.4-3.5z"
      />
    </svg>
  );
}
