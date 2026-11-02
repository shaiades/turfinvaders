// The character-select turntable (owner mandate 2026-11-02): wherever a
// player is looking at THEIR individual stats — marketing, canvassing, sales —
// their full-body fighter slowly spins beside/above the numbers, like a video
// game. Full-body art spins frameless over a glowing floor disc; a player with
// no approved art spins their initials coin instead (same RepAvatar fallback
// chain, so the Monday photo is still never team-facing). Motion lives in CSS
// (fighter-spin / fighter-pedestal in styles.css) and parks face-on under
// prefers-reduced-motion.

import { cn } from "@/lib/utils";
import { RepAvatar } from "@/components/RepAvatar";
import type { RepCartoon } from "@/hooks/useRepCartoons";

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
  const hasArt = !!(cartoon?.full ?? cartoon?.portrait);
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
      <span className="fighter-spin relative flex h-full w-full items-end justify-center pb-[4%]">
        {hasArt ? (
          <RepAvatar
            name={name}
            cartoon={cartoon}
            variant="full"
            fit="contain"
            position="center bottom"
            rounded="none"
            className="h-full w-full bg-transparent"
            textClassName={textClassName}
          />
        ) : (
          // No art yet: the initials circle spins like a coin on the pedestal.
          <RepAvatar
            name={name}
            className="aspect-square h-auto w-[78%] max-h-full"
            textClassName={textClassName}
          />
        )}
      </span>
    </span>
  );
}
