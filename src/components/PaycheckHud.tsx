// Paycheck HUD — commission made visual. A wallet that counts up with a rolling
// odometer and a loot breakdown of the REAL pay engine: base = silver, sit
// bonus = gold, commission = gems, the $500 monster and the $1,500-per-$100K
// bonus = treasure chests. Each line taps open to the exact derivation (hours ×
// rate, % of sold volume, sits past 3…), so every dollar traces to a column —
// no per-appointment line, because no such pay exists. The month view's
// projection is clearly labeled an estimate; the week/month totals are the
// engine's own take-home.

import { useState } from "react";
import { useWallet } from "@/hooks/useCanvasserArcade";
import { useMyEarnings } from "@/hooks/useMyEarnings";
import { SIT_BONUS_THRESHOLD, type LootCoin, type LootKind } from "@/lib/canvasserPay";
import { laMonthStartISO, laTodayISO, remainingWorkdaysInMonth } from "@/lib/dates";
import { ArcadePanel, ArcadeSkeleton } from "@/components/arcade";
import { useCountUp } from "@/hooks/useCountUp";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

const COIN_ICON: Record<LootCoin, string> = {
  silver: "🪙",
  gold: "🥇",
  gems: "💎",
  chest: "🧰",
};

export function PaycheckHud({ userId }: { userId: string }) {
  const [scope, setScope] = useState<"week" | "month">("week");
  const reduced = usePrefersReducedMotion();
  const wallet = useWallet(userId, scope);
  const earnings = useMyEarnings(userId);
  const [open, setOpen] = useState<LootKind | null>(null);

  const headline = scope === "week" ? wallet.weekTotal : wallet.monthTotal;
  const { display, bump } = useCountUp(headline, reduced);

  // Straight-line month projection — labeled an estimate, never paid.
  const total = remainingWorkdaysInMonth(laMonthStartISO());
  const remaining = remainingWorkdaysInMonth(laTodayISO());
  const elapsed = Math.max(1, total - remaining + 1);
  const projected = (wallet.monthTotal / elapsed) * total;

  if (wallet.loading) {
    return (
      <ArcadePanel title="Paycheck">
        <ArcadeSkeleton className="h-40 w-full" />
      </ArcadePanel>
    );
  }

  const wk = earnings.weekPaycheck;

  const derive = (kind: LootKind): string => {
    if (kind === "base") {
      const base = `${Math.round(wk?.hours ?? 0)}h clocked × ${money(wk?.hourly_rate ?? 0)}/hr`;
      const prem = (wk?.ot_premium_pay ?? 0) + (wk?.meal_premium_pay ?? 0);
      return prem > 0 ? `${base} + ${money(prem)} OT/meal premium` : base;
    }
    if (kind === "commission") {
      const rate = Math.round((wk?.commission_rate ?? 0) * 100);
      return `${rate}% of ${money(wk?.sale_price_total ?? 0)} in sold volume`;
    }
    if (kind === "sitBonus") {
      const past = Math.max(0, (wk?.sits ?? 0) - SIT_BONUS_THRESHOLD);
      return past > 0
        ? `${past} sit${past === 1 ? "" : "s"} past ${SIT_BONUS_THRESHOLD} × bonus rate`
        : `No bonus until sit #${SIT_BONUS_THRESHOLD + 1} this week`;
    }
    if (kind === "monster") {
      return `${wk?.points ?? 0} pts — $500 unlocks at 10`;
    }
    return "$1,500 per $100K of monthly sold volume";
  };

  return (
    <ArcadePanel
      title="Paycheck"
      action={
        <div className="inline-flex rounded-md border border-border bg-surface p-0.5">
          {(["week", "month"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`rounded px-2.5 py-1 font-display text-[9px] uppercase tracking-widest transition ${
                scope === s ? "bg-neon/15 text-neon" : "text-muted-foreground"
              }`}
            >
              {s === "week" ? "Week" : "Month"}
            </button>
          ))}
        </div>
      }
    >
      <div className="space-y-4">
        {/* Wallet odometer */}
        <div className="text-center">
          <p className="font-display text-[9px] uppercase tracking-widest text-muted-foreground">
            {scope === "week" ? "This week" : "This month"} · take-home
          </p>
          <p
            className={`font-display text-3xl text-victory tabular-nums transition-transform ${
              bump && !reduced ? "scale-110" : "scale-100"
            }`}
            style={{ textShadow: "0 0 24px color-mix(in oklab, var(--victory) 45%, transparent)" }}
          >
            {money(display)}
          </p>
          {scope === "month" && (
            <p className="mt-0.5 font-display text-[9px] uppercase tracking-widest text-muted-foreground">
              on pace for ~{money(projected)} · est.
            </p>
          )}
        </div>

        {/* Loot breakdown */}
        <ul className="space-y-1">
          {wallet.lines.map((l) => {
            const zero = l.amount <= 0;
            const isOpen = open === l.kind;
            return (
              <li key={l.kind}>
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : l.kind)}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left transition hover:bg-foreground/5 ${
                    zero ? "opacity-40" : ""
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden className="text-base">
                      {COIN_ICON[l.coin]}
                    </span>
                    <span className="truncate text-sm">{l.label}</span>
                  </span>
                  <span className="shrink-0 font-display text-sm tabular-nums text-foreground">
                    {money(l.amount)}
                  </span>
                </button>
                {isOpen && (
                  <p className="px-2 pb-2 pl-9 text-[11px] text-muted-foreground">{derive(l.kind)}</p>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </ArcadePanel>
  );
}
