// Sound + haptics toggles for the arcade. Sound is off by default; haptics on
// where supported. Flipping a toggle updates the global pref (localStorage +
// a window event), so every arcade surface re-syncs at once. Enabling sound
// plays a confirmation blip, and enabling haptics buzzes once — so the viewer
// knows it worked.

import { Volume2, VolumeX, Vibrate } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFxPrefs } from "@/hooks/useFxPrefs";
import { setHapticsOn, setSoundOn, hapticsSupported } from "@/lib/fx-prefs";
import { haptic, playArcadeSound } from "@/lib/arcade-fx";

const btn =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground md:min-h-9 md:min-w-9";

export function ArcadeFxToggle({ className }: { className?: string }) {
  const { sound, haptics } = useFxPrefs();
  const showHaptics = hapticsSupported();

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <button
        type="button"
        aria-label={sound ? "Turn arcade sound off" : "Turn arcade sound on"}
        aria-pressed={sound}
        onClick={() => {
          const next = !sound;
          setSoundOn(next);
          // The click is a user gesture, so the audio context can resume now.
          if (next) playArcadeSound("coin");
        }}
        className={cn(btn, sound && "text-neon")}
      >
        {sound ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
      </button>
      {showHaptics && (
        <button
          type="button"
          aria-label={haptics ? "Turn haptics off" : "Turn haptics on"}
          aria-pressed={haptics}
          onClick={() => {
            const next = !haptics;
            setHapticsOn(next);
            if (next) haptic(20);
          }}
          className={cn(btn, haptics && "text-neon")}
        >
          <Vibrate className={cn("h-5 w-5", !haptics && "opacity-40")} />
        </button>
      )}
    </div>
  );
}
