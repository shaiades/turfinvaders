// The first-time badge unlock animation (§1 "also fix"). Plays ONCE per badge:
// useCanvasserBadges hands over the freshly-earned (unseen) badges, this plays a
// confetti + stamp celebration, then calls onDone so the rows flip seen=true and
// never replay. Reduced motion → a still card, no confetti, quicker auto-close.
// Sound/haptics ride the shared arcade toggle (off by default) via arcadeCue.

import { useEffect, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { arcadeCue } from "@/lib/arcade-fx";
import type { BadgeDef, BadgeId } from "@/lib/canvasserPay";

export function BadgeUnlock({
  badges,
  onDone,
}: {
  badges: BadgeDef[];
  onDone: (ids: BadgeId[]) => void;
}) {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(false);
  const [closed, setClosed] = useState(false);
  const doneRef = useRef(false);
  const ids = badges.map((b) => b.id);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setClosed(true); // hide now; markSeen's refetch empties `unseen` right after
    onDone(ids);
  };

  useEffect(() => {
    if (badges.length === 0) return;
    arcadeCue("badge", [30, 40, 60]);
    if (!reduced) {
      confetti({
        particleCount: 90,
        spread: 72,
        startVelocity: 42,
        origin: { y: 0.5 },
        colors: ["#ffcf33", "#ff3d9a", "#22e6ff"],
      });
    }
    const raf = requestAnimationFrame(() => setShown(true));
    const t = setTimeout(finish, reduced ? 1600 : 2800);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
    // Mount-once celebration; the badge list is fixed for this instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (badges.length === 0 || closed) return null;

  return (
    <div
      role="dialog"
      aria-label="Badge unlocked"
      aria-live="polite"
      onClick={finish}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm"
    >
      <div
        className="w-full max-w-xs rounded-2xl border border-[var(--kombat-gold)]/70 bg-surface p-6 text-center shadow-2xl"
        style={{
          transition: reduced ? undefined : "transform 320ms ease-out, opacity 320ms ease-out",
          transform: reduced || shown ? "scale(1)" : "scale(0.86)",
          opacity: reduced || shown ? 1 : 0,
          boxShadow: "0 0 36px color-mix(in oklab, var(--kombat-gold) 45%, transparent)",
        }}
      >
        <p className="font-display text-xs uppercase tracking-[0.3em] text-[var(--kombat-gold)]">
          {badges.length > 1 ? `${badges.length} Badges Unlocked` : "Badge Unlocked"}
        </p>
        <div className="mt-4 flex flex-wrap items-start justify-center gap-5">
          {badges.map((b) => (
            <div key={b.id} className="flex w-20 flex-col items-center gap-1">
              <span
                aria-hidden
                className="text-5xl drop-shadow-[0_0_10px_var(--neon)]"
                style={
                  reduced
                    ? undefined
                    : { animation: "badge-pop 520ms cubic-bezier(.2,1.3,.4,1) both" }
                }
              >
                {b.icon}
              </span>
              <span className="font-display text-[11px] uppercase tracking-widest text-foreground">
                {b.label}
              </span>
              <span className="text-[10px] leading-tight text-muted-foreground">{b.blurb}</span>
            </div>
          ))}
        </div>
        <p className="mt-5 font-display text-[9px] uppercase tracking-widest text-muted-foreground">
          Tap to continue
        </p>
      </div>

      {!reduced && (
        <style>{`@keyframes badge-pop{0%{transform:scale(0) rotate(-18deg)}70%{transform:scale(1.25) rotate(6deg)}100%{transform:scale(1) rotate(0)}}`}</style>
      )}
    </div>
  );
}
