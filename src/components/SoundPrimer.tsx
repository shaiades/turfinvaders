import { useEffect, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { hasSoundPrompted, isSoundOn, markSoundPrompted, setSoundOn } from "@/lib/fx-prefs";
import { playArcadeSound, haptic } from "@/lib/arcade-fx";

/**
 * One-time "TURN UP THE ARCADE?" opt-in (engagement audit 2026-11-03 §1.5).
 * The chiptune kit (coins, K.O.s, level-ups) ships silent by owner spec, and
 * almost no rep ever found the toggle — so the first session asks exactly
 * once, arcade-style, then never again either way. INSERT COIN flips the
 * pref inside the tap handler, which is also what unlocks iOS audio, and
 * plays the coin so the choice is immediately audible. Mounted app-wide for
 * canvasser tier; renders nothing once answered.
 *
 * Deliberately NOT a Radix dialog: a fixed bottom card above the tab bar
 * doesn't trap focus or block the map — a rep mid-door can ignore it.
 */
export function SoundPrimer() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (hasSoundPrompted() || isSoundOn()) return;
    // Let the shell settle (and any intro play) before asking.
    const id = window.setTimeout(() => setShow(true), 2500);
    return () => window.clearTimeout(id);
  }, []);

  if (!show) return null;

  const dismiss = () => {
    markSoundPrompted();
    setShow(false);
  };

  return (
    <div
      role="dialog"
      aria-label="Turn on arcade sound?"
      className="fixed inset-x-0 bottom-24 z-[60] px-4 md:bottom-8"
    >
      <div className="mx-auto max-w-sm rounded-xl border border-[var(--neon)]/50 bg-background/95 p-4 shadow-[0_0_32px_-8px_var(--neon)] backdrop-blur">
        <div className="pointer-events-none absolute inset-0 rounded-xl scanlines opacity-20" />
        <p className="font-display text-xs uppercase tracking-widest text-neon">
          🔊 Turn up the arcade?
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Hear the coins, K.O.s and level-ups as you earn them. You can flip it
          any time from the wrap screen.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => {
              // The pref flip + first sound inside the tap unlocks iOS audio.
              setSoundOn(true);
              playArcadeSound("coin");
              haptic([20, 30, 20]);
              dismiss();
            }}
            className="min-h-11 flex-1 rounded-lg border border-[var(--kombat-gold)]/60 bg-[color-mix(in_oklab,var(--kombat-gold)_15%,transparent)] px-4 font-display text-xs uppercase tracking-widest text-[var(--kombat-gold)]"
          >
            <Volume2 className="mr-1.5 inline h-4 w-4" />
            Insert Coin
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="min-h-11 flex-1 rounded-lg border border-border px-4 font-display text-xs uppercase tracking-widest text-muted-foreground"
          >
            <VolumeX className="mr-1.5 inline h-4 w-4" />
            Silent Mode
          </button>
        </div>
      </div>
    </div>
  );
}
