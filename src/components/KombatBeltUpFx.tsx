// Kombat Month — belt-up ceremony (owner revamp 2026-10-02): a rep crossing
// into a new belt is the dopamine beat the contest runs on, so it gets a
// full-screen flourish. Same ref-latch discipline as KombatStrikeFx — the
// parent re-renders on realtime refetches, so finish() must fire onDone
// exactly once and never restart. Reduced motion → toast only.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { rewardToast } from "@/lib/reward-toast";

export type BeltUpFx = { seq: number; beltLabel: string; cash: number };

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

export function KombatBeltUpFx({ fx, onDone }: { fx: BeltUpFx; onDone: () => void }) {
  const onDoneRef = useRef(onDone);
  const fxRef = useRef(fx);
  useEffect(() => {
    onDoneRef.current = onDone;
    fxRef.current = fx;
  });
  const doneRef = useRef(false);
  const finish = useRef(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDoneRef.current();
  }).current;

  useEffect(() => {
    const snap = fxRef.current;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rewardToast(`🏆 NEW BELT — ${snap.beltLabel.toUpperCase()}`, {
      description:
        snap.cash > 0 ? `${fmtMoney(snap.cash)} on the line now.` : "You're on the board.",
      vibrate: reduced ? false : [40, 60, 40, 60, 90],
    });
    if (reduced) {
      finish();
      return;
    }
    let cancelled = false;
    void import("canvas-confetti").then(({ default: confetti }) => {
      if (cancelled) return;
      void confetti({
        particleCount: 120,
        spread: 90,
        startVelocity: 42,
        origin: { y: 0.6 },
        colors: ["#f5c518", "#df2f4a", "#ffffff"],
        disableForReducedMotion: true,
      });
    });
    const t = window.setTimeout(finish, 2600);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [finish]);

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  return createPortal(
    <button
      type="button"
      aria-label="Dismiss"
      onClick={finish}
      className="fixed inset-0 z-[10030] flex items-center justify-center bg-background/70 pointer-events-auto"
    >
      <span className="animate-in zoom-in-50 fade-in duration-300 rounded-2xl border-2 border-kombat-gold/70 bg-kombat-black px-8 py-6 text-center shadow-[0_0_60px_-8px_var(--kombat-gold)]">
        <span className="block font-display text-[10px] uppercase tracking-[0.3em] text-kombat-red">
          New Belt
        </span>
        <span
          className="mt-2 block font-display text-2xl uppercase tracking-widest text-kombat-gold"
          style={{
            textShadow: "0 0 28px color-mix(in oklab, var(--kombat-gold) 60%, transparent)",
          }}
        >
          {fx.beltLabel}
        </span>
        {fx.cash > 0 && (
          <span className="mt-2 block font-mono text-lg font-bold text-victory">
            {fmtMoney(fx.cash)} in play
          </span>
        )}
        <span className="mt-3 block text-[10px] uppercase tracking-widest text-muted-foreground">
          Tap to skip ▸
        </span>
      </span>
    </button>,
    document.body,
  );
}
