// Arcade sound cues + haptics for the canvasser arcade's big moments. Sounds
// are short chiptune phrases on the shared beeper (so they share one
// AudioContext with the intro cutscenes) and are gated by the global sound
// preference; haptics use the Vibration API, gated by the haptics preference.
// Both no-op silently when their pref is off, unsupported, or blocked — audio
// and vibration are garnish, never load-bearing.

import { makeBeeper } from "@/components/intro-fx";
import { isHapticsOn, isSoundOn } from "@/lib/fx-prefs";

export type ArcadeSound = "coin" | "levelup" | "chest" | "badge" | "boss" | "rank";

// makeBeeper itself checks isSoundOn, but we also skip building phrases when off.
let beeper: ReturnType<typeof makeBeeper> | null = null;
function beep(): ReturnType<typeof makeBeeper> {
  return (beeper ??= makeBeeper());
}

/** Play a short arcade phrase. Silent unless the sound pref is on. */
export function playArcadeSound(kind: ArcadeSound): void {
  if (!isSoundOn()) return;
  const b = beep();
  switch (kind) {
    case "coin": // bright two-note pickup
      b(880, 70, 0, "square");
      b(1320, 90, 55, "square");
      break;
    case "levelup": // rising arpeggio
      [523, 659, 784, 1047].forEach((f, i) => b(f, 120, i * 85, "triangle"));
      break;
    case "chest": // treasure fanfare
      b(392, 110, 0, "sawtooth");
      b(587, 130, 100, "triangle");
      b(880, 220, 210, "triangle");
      break;
    case "badge": // sharp stamp
      b(1047, 70, 0, "square");
      b(1568, 110, 70, "square");
      break;
    case "boss": // low hit
      b(196, 150, 0, "sawtooth");
      b(147, 190, 110, "sawtooth");
      break;
    case "rank": // quick climb blip
      b(659, 80, 0, "square");
      b(988, 110, 70, "square");
      break;
  }
}

/** Fire a vibration pattern. Silent unless haptics are on and supported. */
export function haptic(pattern: number | number[]): void {
  if (!isHapticsOn()) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported / blocked */
  }
}

/** A moment's sound + haptic together — the usual call site. */
export function arcadeCue(kind: ArcadeSound, pattern: number | number[]): void {
  playArcadeSound(kind);
  haptic(pattern);
}
