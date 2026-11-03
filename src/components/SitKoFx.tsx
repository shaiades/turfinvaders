// SIT = the K.O. (engagement audit 2026-11-03, Tier 2): a confirmed demo is
// the single behavior the business most needs, so it gets the biggest
// in-field moment — the comic starburst (pop-ko-flash CSS, KombatKoFlash's
// kit) with YOUR fighter thrown into the frame, a rising fanfare and gold
// confetti. Reduced-motion → a toast only. Self-clearing.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { makeBeeper } from "@/components/intro-fx";
import { rewardToast } from "@/lib/reward-toast";
import { haptic } from "@/lib/arcade-fx";
import type { RepCartoon } from "@/hooks/useRepCartoons";

export function SitKoFx({
  points,
  cartoon,
  onDone,
}: {
  /** Ledger points the sit just minted (shown on the burst). */
  points: number;
  /** YOUR fighter. */
  cartoon?: RepCartoon | null;
  onDone: () => void;
}) {
  const reduced = usePrefersReducedMotion();
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      onDoneRef.current();
    };
    haptic([40, 60, 40, 60, 90]);
    if (reduced) {
      rewardToast(`K.O.! SIT CONFIRMED — +${points} pts`);
      const t = setTimeout(finish, 50);
      return () => clearTimeout(t);
    }
    const beep = makeBeeper();
    beep(880, 90, 0, "square");
    beep(1174, 90, 100, "square");
    beep(1568, 140, 200, "square");
    beep(2093, 300, 340, "sine");
    let cancelled = false;
    import("canvas-confetti")
      .then((m) => {
        if (cancelled) return;
        m.default({
          particleCount: 150,
          spread: 90,
          startVelocity: 48,
          origin: { y: 0.45 },
          colors: ["#f5c518", "#22d3ee", "#ffffff"],
        });
      })
      .catch(() => {});
    const t = setTimeout(finish, 2100);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [reduced, points]);

  if (reduced) return null;
  return createPortal(
    <div
      className="pointer-events-none fixed inset-0 z-[10040] grid place-items-center"
      aria-hidden
    >
      {cartoon?.full && (
        <img
          src={cartoon.full}
          alt=""
          className="animate-in slide-in-from-left-10 fade-in absolute left-[6%] bottom-[14%] h-44 w-auto duration-300 drop-shadow-[0_0_26px_rgba(255,210,62,0.65)] sm:left-[18%] sm:h-60"
        />
      )}
      <div className="pop-ko-flash relative grid h-56 w-56 place-items-center sm:h-72 sm:w-72">
        <span className="pop-burst absolute inset-0 bg-kombat-gold" />
        <span className="pop-burst absolute inset-[6px] bg-[var(--turf-cyan)]" />
        <span className="relative px-6 text-center">
          <span className="pop-ink block font-display text-4xl text-kombat-gold sm:text-5xl">
            K.O.!
          </span>
          <span className="mt-2 block font-display text-[10px] uppercase tracking-widest text-white">
            Sit confirmed · +{points} pts
          </span>
        </span>
      </div>
    </div>,
    document.body,
  );
}
