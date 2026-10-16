import { useEffect, useState } from "react";
import { Heart, X } from "lucide-react";
import { laTodayISO } from "@/lib/dates";
import { supabase } from "@/integrations/supabase/client";

function storageKey(userId: string) {
  return `gratitude:${userId}:${laTodayISO()}`;
}

export function hasPassedGratitudeGate(userId: string | undefined): boolean {
  if (!userId || typeof window === "undefined") return false;
  try {
    return !!window.localStorage.getItem(storageKey(userId));
  } catch {
    return false;
  }
}

// One-tap answers — tap one and you're back on the doors. The free-text ritual
// became a wall between a rookie and their first knock (audit 2026-10-15);
// the WORDS matter less than the beat of gratitude, so presets win.
const PRESETS = ["My family", "My health", "My team", "This opportunity"] as const;

/**
 * Gratitude check-in (owner ritual, reworked in the 2026-10-15 audit,
 * Phase 3 §1). The gate NO LONGER blocks the map: ActiveRun mounts, GPS
 * starts, doors get knocked. After the FIRST logged door of the day
 * (`promptArmed`), a one-tap card slides over the map — tap what you're
 * grateful for and it's gone. Still once per LA day (same localStorage key
 * as the old gate, so nobody gets double-prompted across the deploy), still
 * feeds the Daily Wrap gratitude wall, still fires ti-gratitude-unlocked for
 * the tutorial.
 *
 * `pending` (auth still resolving) keeps holding children back — ActiveRun's
 * savedView freeze depends on children not mounting until auth settles.
 * `bypass` skips the ritual for exempt roles (GRATITUDE_GATE_ROLES).
 */
export function GratitudeGate({
  userId,
  bypass = false,
  pending = false,
  promptArmed = false,
  children,
}: {
  userId: string | undefined;
  bypass?: boolean;
  pending?: boolean;
  /** True once today's first door is logged — the prompt waits for it. */
  promptArmed?: boolean;
  children: React.ReactNode;
}) {
  const [unlocked, setUnlocked] = useState<boolean>(() => hasPassedGratitudeGate(userId));
  // "Later" hides the card until the next mount — never blocks, never nags
  // twice in one stretch of street.
  const [snoozed, setSnoozed] = useState(false);

  useEffect(() => {
    setUnlocked(hasPassedGratitudeGate(userId));
  }, [userId]);

  if (pending) return null;

  const submit = (v: string) => {
    if (!userId) return;
    try {
      window.localStorage.setItem(
        storageKey(userId),
        JSON.stringify({ text: v, at: new Date().toISOString() }),
      );
    } catch {
      /* ignore */
    }
    // Best-effort share to the Daily Wrap's gratitude wall (owner call
    // 2026-09-11). Fire-and-forget: the prompt NEVER waits on the network.
    // Untyped table access until the generated types catch up.
    // Typed insert since the 2026-10-16 types regen.
    void supabase
      .from("gratitude_entries")
      .insert({ user_id: userId, entry_date: laTodayISO(), text: v.slice(0, 280) })
      .then(() => {});
    setUnlocked(true);
    // The canvasser tutorial defers its field-screen pop until the ritual
    // completes (same event the old gate fired).
    window.dispatchEvent(new Event("ti-gratitude-unlocked"));
  };

  const showPrompt = !bypass && !unlocked && !snoozed && promptArmed && !!userId;

  return (
    <>
      {children}
      {showPrompt && (
        <div className="fixed inset-x-0 bottom-20 z-[1900] px-3 pb-safe">
          <div
            data-tour="gratitude-gate"
            role="dialog"
            aria-label="Gratitude check-in"
            className="mx-auto w-full max-w-xl rounded-2xl border border-[color-mix(in_oklab,var(--neon)_45%,var(--border))] bg-surface p-4 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.8)]"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Heart className="h-4 w-4 text-[#ff4d8d]" aria-hidden />
                First door down — what are you grateful for?
              </div>
              <button
                type="button"
                aria-label="Ask me later"
                onClick={() => setSnoozed(true)}
                className="-m-1 flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => submit(p)}
                  className="min-h-11 rounded-xl border border-neon/50 bg-neon/10 px-3 text-sm font-medium text-neon"
                >
                  {p}
                </button>
              ))}
            </div>
            <p className="mt-2 text-center text-xs text-muted-foreground">
              One tap · once a day · lands on the Daily Wrap wall
            </p>
          </div>
        </div>
      )}
    </>
  );
}
