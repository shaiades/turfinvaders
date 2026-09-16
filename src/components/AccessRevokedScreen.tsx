import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { LogOut } from "lucide-react";

/**
 * Removed-player lockout (owner ask 2026-09-16). The DB side bans the auth
 * account the moment a profile is archived (trigger in migration
 * 20260916100000), which kills sign-ins and token refreshes — but an
 * already-open session keeps a valid access token for up to an hour. This
 * pair closes that window:
 *
 *  - useLiveAccessRevoked watches the signed-in user's OWN profile row over
 *    realtime (profiles is in the publication since PR #157) and flips the
 *    moment a manager archives — or reactivates — them mid-session.
 *  - AccessRevokedScreen replaces the entire shell, so no nav, HUD, or
 *    CrewBeacon renders behind it.
 *
 * History is untouched by removal; the copy says so, since the person
 * staring at this screen earned the numbers still on the boards.
 */
export function useLiveAccessRevoked(userId: string | null | undefined, fromProfile: boolean): boolean {
  // null = no live signal yet; once an event lands it wins over the
  // profile snapshot in BOTH directions (archive and reactivate).
  const [live, setLive] = useState<boolean | null>(null);

  useEffect(() => {
    setLive(null);
    if (!userId) return;
    const channel = supabase
      .channel(`self-access-${userId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${userId}` },
        (payload) => {
          const next = (payload.new as { is_active?: boolean | null }).is_active;
          // Explicit false only — same fail-open rule as useAuth.
          if (next !== undefined) setLive(next === false);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  return live ?? fromProfile;
}

export function AccessRevokedScreen({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 bg-background">
      <div className="max-w-md text-center">
        <h1 className="font-display text-3xl md:text-4xl text-[var(--destructive)]">GAME OVER</h1>
        <h2 className="mt-4 font-display text-base md:text-lg text-neon">ACCESS REMOVED</h2>
        <p className="mt-3 text-sm text-muted-foreground">
          You've been removed from the roster, so this account can no longer open Turf Invaders.
          Your stats and history stay on the boards — nothing you earned goes away.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Think this is a mistake? Talk to your manager — reactivating you restores this login.
        </p>
        <div className="mt-6">
          <button
            type="button"
            onClick={onSignOut}
            className="inline-flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
