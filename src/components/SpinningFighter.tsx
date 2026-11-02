// The character-select turntable (owner mandate 2026-11-02): wherever a
// player is looking at THEIR individual stats — marketing, canvassing, sales —
// their full-body BODY slowly spins beside/above the numbers, like a video
// game. The flat backdrop the cartoon pipeline paints is chroma-keyed away
// client-side (fighter-cutout.ts), and the cutout spins as a short stack of
// Z-offset layers so edge-on it reads as a figurine with thickness, never a
// sheet of paper — and never a spinning card (owner correction 2026-11-02).
// While the cutout resolves the art stands still; if keying is impossible
// (CORS taint, non-flat backdrop) the uncut art spins as a last resort. A
// player with no approved art spins their initials coin (same RepAvatar
// fallback chain, so the Monday photo is still never team-facing). Motion
// lives in CSS (fighter-spin / fighter-pedestal) and parks face-on under
// prefers-reduced-motion.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { RepAvatar } from "@/components/RepAvatar";
import { fighterCutout } from "@/lib/fighter-cutout";
import type { RepCartoon } from "@/hooks/useRepCartoons";

// Z offsets (px) for the figurine stack — ±3px of body at a 520px perspective.
const DEPTH_LAYERS = [-3, -2, -1, 0, 1, 2, 3];

/** undefined = keying in progress · null = can't be keyed · string = cutout. */
function useFighterCutout(url: string | null): string | null | undefined {
  const [cut, setCut] = useState<string | null | undefined>(url ? undefined : null);
  useEffect(() => {
    if (!url) {
      setCut(null);
      return;
    }
    let live = true;
    setCut(undefined);
    void fighterCutout(url).then((c) => {
      if (live) setCut(c);
    });
    return () => {
      live = false;
    };
  }, [url]);
  return cut;
}

export function SpinningFighter({
  name,
  cartoon,
  tone = "neon",
  className,
  textClassName = "text-xl",
}: {
  name: string;
  cartoon?: RepCartoon;
  /** Pedestal glow: "neon" for the field/marketing sides, "gold" for Kombat. */
  tone?: "neon" | "gold";
  /** Sizing from the caller, e.g. "h-24 w-20". */
  className?: string;
  textClassName?: string;
}) {
  // Same art chain as RepAvatar variant="full": full body, else portrait,
  // else the initials coin.
  const art = cartoon?.full ?? cartoon?.portrait ?? null;
  const cutout = useFighterCutout(art);
  return (
    <span
      className={cn(
        "fighter-spin-stage relative inline-flex shrink-0 items-end justify-center",
        className,
      )}
      style={{
        ["--pedestal-color" as string]: tone === "gold" ? "var(--kombat-gold)" : "var(--neon)",
      }}
    >
      <span aria-hidden className="fighter-pedestal h-[14%] w-[92%] blur-[5px]" />
      {art && cutout ? (
        // The keyed body on the turntable: a stack of Z-offset copies gives
        // the sprite thickness, so the edge-on pass reads as a figurine.
        <span className="fighter-spin relative h-full w-full pb-[4%]">
          {DEPTH_LAYERS.map((z) => (
            <img
              key={z}
              src={cutout}
              alt={z === 0 ? name : ""}
              aria-hidden={z !== 0}
              className="absolute inset-0 h-full w-full object-contain"
              style={{ objectPosition: "center bottom", transform: `translateZ(${z}px)` }}
            />
          ))}
        </span>
      ) : art && cutout === undefined ? (
        // Keying in progress — stand face-on rather than flash a card spin.
        <span className="relative flex h-full w-full items-end justify-center pb-[4%]">
          <RepAvatar
            name={name}
            cartoon={cartoon}
            variant="full"
            fit="contain"
            position="center bottom"
            rounded="none"
            className="h-full w-full"
            textClassName={textClassName}
          />
        </span>
      ) : art ? (
        // Un-keyable art (CORS taint, scenery backdrop): spin it whole as a
        // last resort — rare, since pipeline art is always a flat fill.
        <span className="fighter-spin relative flex h-full w-full items-end justify-center pb-[4%]">
          <RepAvatar
            name={name}
            cartoon={cartoon}
            variant="full"
            fit="contain"
            position="center bottom"
            rounded="none"
            className="h-full w-full"
            textClassName={textClassName}
          />
        </span>
      ) : (
        // No art yet: the initials circle spins like a coin on the pedestal.
        <span className="fighter-spin relative flex h-full w-full items-end justify-center pb-[4%]">
          <RepAvatar
            name={name}
            className="aspect-square h-auto w-[78%] max-h-full"
            textClassName={textClassName}
          />
        </span>
      )}
    </span>
  );
}
