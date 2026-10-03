// K.O. rank-up flash (Close Kombat, owner 2026-10-02): the addictive beat — when
// YOU climb past the rep ahead, a comic "K.O.! YOU PASSED <name>" starburst punches
// in with a ka-ching + confetti, then clears itself. Reduced-motion → a toast only.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { makeBeeper } from "@/components/intro-fx";
import { rewardToast } from "@/lib/reward-toast";

export function KombatKoFlash({ name, onDone }: { name: string; onDone: () => void }) {
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
    if (reduced) {
      rewardToast(`K.O.! You passed ${name}`);
      const t = setTimeout(finish, 50);
      return () => clearTimeout(t);
    }
    const beep = makeBeeper();
    beep(1318, 90, 0, "sine");
    beep(1760, 160, 90, "sine");
    beep(2093, 200, 220, "sine");
    let cancelled = false;
    import("canvas-confetti")
      .then((m) => {
        if (cancelled) return;
        m.default({
          particleCount: 80,
          spread: 85,
          startVelocity: 46,
          origin: { y: 0.42 },
          colors: ["#f5c518", "#ee2233", "#ffffff"],
        });
      })
      .catch(() => {});
    const t = setTimeout(finish, 1700);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [reduced, name]);

  if (reduced) return null;
  return createPortal(
    <div
      className="pointer-events-none fixed inset-0 z-[10040] grid place-items-center"
      aria-hidden
    >
      <div className="pop-ko-flash relative grid h-56 w-56 place-items-center sm:h-72 sm:w-72">
        <span className="pop-burst absolute inset-0 bg-kombat-gold" />
        <span className="pop-burst absolute inset-[6px] bg-kombat-red" />
        <span className="relative px-6 text-center">
          <span className="pop-ink block font-display text-4xl text-kombat-gold sm:text-5xl">
            K.O.!
          </span>
          <span className="mt-2 block font-display text-[10px] uppercase tracking-widest text-white">
            You passed {name}
          </span>
        </span>
      </div>
    </div>,
    document.body,
  );
}
