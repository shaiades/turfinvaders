// The character-select turntable (owner mandate 2026-11-02): wherever a
// player is looking at THEIR individual stats — marketing, canvassing, sales —
// their full-body avatar slowly spins beside/above the numbers, like a video
// game: front, side, back, other side (owner: "just the body spins, not the
// background or the card").
//
// Three tiers, best available wins:
//  1. TURNAROUND — the fighter has generated spin frames (8 views at 45°,
//     fighter-turnaround.server.ts): step through them like a real game.
//     Each frame is chroma-keyed (fighter-cutout.ts) so only the BODY shows.
//  2. PSEUDO-SPIN — approved art but no frames yet: the keyed body rotates
//     as a stack of Z-offset layers (figurine with thickness, not a card).
//     Un-keyable art (CORS taint, scenery backdrop) spins whole, last resort.
//  3. COIN — no art at all: the initials circle spins like a coin (same
//     RepAvatar fallback chain, so the Monday photo is never team-facing).
// prefers-reduced-motion parks every tier face-on.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { RepAvatar } from "@/components/RepAvatar";
import { fighterCutout } from "@/lib/fighter-cutout";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { RepCartoon } from "@/hooks/useRepCartoons";

// One full revolution, matching the CSS fighter-spin duration.
const SPIN_MS = 7000;

// Z offsets (px) for the pseudo-spin figurine stack — ±3px of body at a
// 520px perspective.
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
  const frames = cartoon?.turn ?? null;
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
      {frames ? (
        <TurnaroundSpin name={name} frames={frames} />
      ) : art ? (
        <PseudoSpin name={name} cartoon={cartoon} art={art} textClassName={textClassName} />
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

/** Tier 1 — the real videogame turntable: step through the generated views
 *  (front → side → back → other side), each chroma-keyed to the bare body.
 *  All frames stay mounted (opacity-swapped) so the cycle never flickers on
 *  an undecoded image. */
function TurnaroundSpin({ name, frames }: { name: string; frames: string[] }) {
  const reduced = usePrefersReducedMotion();
  // Keyed frames; a frame whose keying fails falls back to its raw url.
  const [cuts, setCuts] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    setCuts(null);
    void Promise.all(frames.map((f) => fighterCutout(f).then((c) => c ?? f))).then((all) => {
      if (live) setCuts(all);
    });
    return () => {
      live = false;
    };
  }, [frames]);

  const [idx, setIdx] = useState(0);
  const spinning = !!cuts && !reduced;
  useEffect(() => {
    if (!spinning) return;
    const id = setInterval(
      () => setIdx((i) => (i + 1) % frames.length),
      Math.round(SPIN_MS / frames.length),
    );
    return () => clearInterval(id);
  }, [spinning, frames.length]);

  return (
    <span className="relative h-full w-full pb-[4%]">
      {(cuts ?? [frames[0]]).map((src, i) => (
        <img
          key={src}
          src={src}
          alt={i === 0 ? name : ""}
          aria-hidden={i !== 0}
          className={cn(
            "absolute inset-0 h-full w-full object-contain",
            i === (spinning ? idx : 0) ? "opacity-100" : "opacity-0",
          )}
          style={{ objectPosition: "center bottom" }}
        />
      ))}
    </span>
  );
}

/** Tier 2 — no frames yet: the keyed body on a rotateY turntable with
 *  figurine thickness; whole-art spin only when keying is impossible. */
function PseudoSpin({
  name,
  cartoon,
  art,
  textClassName,
}: {
  name: string;
  cartoon?: RepCartoon;
  art: string;
  textClassName: string;
}) {
  const cutout = useFighterCutout(art);
  if (cutout) {
    return (
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
    );
  }
  return (
    // Keying in progress: stand face-on rather than flash a card spin.
    // Keying failed (null): spin the whole art as a last resort — rare,
    // since pipeline art is always a flat fill.
    <span
      className={cn(
        "relative flex h-full w-full items-end justify-center pb-[4%]",
        cutout === null && "fighter-spin",
      )}
    >
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
  );
}
