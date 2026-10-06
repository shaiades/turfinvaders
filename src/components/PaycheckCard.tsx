// ONE "Paycheck" card — the single home for take-home pay on Mission
// (consolidation 2026-10-05). Merges the old header Take-Home widget, the
// Stats-tab Paycheck HUD and the Paycheck Engine into one card: a Week/Month
// toggle, the income-goal bar welded to the money, a loot breakdown that taps
// open to the exact derivation, and the month projection. Every dollar is the
// real pay engine's — useWallet re-skins a calc_*_paycheck row and useMyEarnings
// reads the same monthly row the owner's payroll pays from, so nothing is
// invented and the week/month totals can never disagree. The "$/hr · N pts this
// week" tier line is intentionally NOT here: that lives on the header HUD now,
// its one home.

import { useState } from "react";
import { Pencil } from "lucide-react";
import {
  SIT_BONUS_THRESHOLD,
  VOLUME_BONUS_STEP,
  type LootCoin,
  type LootKind,
} from "@/lib/canvasserPay";
import { laMonthStartISO, laTodayISO, remainingWorkdaysInMonth } from "@/lib/dates";
import { ArcadePanel, ArcadeSkeleton, NeonBar, TeamBadge } from "@/components/arcade";
import { useWallet } from "@/hooks/useCanvasserArcade";
import { useMyEarnings } from "@/hooks/useMyEarnings";
import { useCountUp } from "@/hooks/useCountUp";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { CanvasserStatsData } from "@/hooks/useCanvasserStats";

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

const COIN_ICON: Record<LootCoin, string> = {
  silver: "🪙",
  gold: "🥇",
  gems: "💎",
  chest: "🧰",
};

export function PaycheckCard({
  userId,
  stats,
  teamName,
  teamColor,
  onEditGoal,
}: {
  userId: string;
  stats: CanvasserStatsData;
  teamName: string | null;
  teamColor: string;
  /** Jump to the Plan tab to change the goal (the month goal's edit home). */
  onEditGoal: () => void;
}) {
  const [scope, setScope] = useState<"week" | "month">("week");
  const reduced = usePrefersReducedMotion();
  const wallet = useWallet(userId, scope);
  const earnings = useMyEarnings(userId);
  const [open, setOpen] = useState<LootKind | null>(null);

  const headline = scope === "week" ? wallet.weekTotal : wallet.monthTotal;
  const { display, bump } = useCountUp(headline, reduced);

  // Straight-line month projection — labeled an estimate, never paid.
  const totalWd = remainingWorkdaysInMonth(laMonthStartISO());
  const remainingWd = remainingWorkdaysInMonth(laTodayISO());
  const elapsedWd = Math.max(1, totalWd - remainingWd + 1);
  const projected = (wallet.monthTotal / elapsedWd) * totalWd;

  // Income goal, welded to the money headline (the number a grinder manages is
  // dollars remaining). Earned side IS the displayed total so the two agree.
  const goalTarget = scope === "week" ? stats.weeklyGoal : stats.monthlyGoal;
  const goalPct = goalTarget > 0 ? Math.min(1, headline / goalTarget) : 0;
  const toGo = Math.max(0, goalTarget - headline);

  const monthly = earnings.monthPaycheck;

  if (wallet.loading) {
    return (
      <ArcadePanel title="Paycheck">
        <ArcadeSkeleton className="h-48 w-full" />
      </ArcadePanel>
    );
  }

  const wk = earnings.weekPaycheck;

  // Per-line derivation — only the week row exposes the fields (hours × rate,
  // % of sold volume, sits past 3…), so expansion is week-only; month lines
  // show their amount without a possibly-mismatched week derivation under it.
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
        {/* Wallet odometer + van badge */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-display text-[9px] uppercase tracking-widest text-muted-foreground">
              {scope === "week" ? "This week" : "This month"} · take-home
            </p>
            <p
              className={`font-display text-4xl text-victory tabular-nums transition-transform ${
                bump && !reduced ? "scale-105" : "scale-100"
              }`}
              style={{
                textShadow: "0 0 24px color-mix(in oklab, var(--victory) 45%, transparent)",
              }}
            >
              {money(display)}
            </p>
            {scope === "month" && (
              <p className="mt-0.5 font-display text-[9px] uppercase tracking-widest text-muted-foreground">
                on pace for ~{money(projected)} · est.
              </p>
            )}
          </div>
          {teamName && (
            <div className="shrink-0">
              <TeamBadge name={teamName} color={teamColor} />
            </div>
          )}
        </div>

        {/* Income goal bar */}
        {goalTarget > 0 && (
          <div>
            <NeonBar pct={goalPct} accent="var(--victory)" />
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              <span>
                {scope === "week" ? "Weekly" : "Monthly"} goal ·{" "}
                <span className="text-victory">{money(goalTarget)}</span>
              </span>
              {toGo > 0 ? (
                <span className="text-[var(--warning)]">{money(toGo)} to go</span>
              ) : (
                <span className="text-victory">Goal hit — gravy from here 🏆</span>
              )}
            </div>
          </div>
        )}

        {/* Month volume-bonus progress toward the next $100K chest */}
        {scope === "month" && monthly && Number(monthly.sale_price_total) > 0 && (
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            $100K volume bonus ·{" "}
            <span className={Number(monthly.volume_bonus) > 0 ? "text-victory" : ""}>
              {money(Number(monthly.volume_bonus))}
            </span>
            {" (paid next month) · "}
            {money(VOLUME_BONUS_STEP - (Number(monthly.sale_price_total) % VOLUME_BONUS_STEP))} to
            next $1,500
          </div>
        )}

        {/* Loot breakdown */}
        <ul className="space-y-1">
          {wallet.lines.map((l) => {
            const zero = l.amount <= 0;
            const isOpen = open === l.kind;
            const expandable = scope === "week";
            return (
              <li key={l.kind}>
                <button
                  type="button"
                  onClick={() => expandable && setOpen(isOpen ? null : l.kind)}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left transition ${
                    expandable ? "hover:bg-foreground/5" : "cursor-default"
                  } ${zero ? "opacity-40" : ""}`}
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
                {expandable && isOpen && (
                  <p className="px-2 pb-2 pl-9 text-[11px] text-muted-foreground">
                    {derive(l.kind)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>

        {scope === "month" && (
          <button
            type="button"
            onClick={onEditGoal}
            className="flex items-center gap-1.5 font-display text-[10px] uppercase tracking-widest text-muted-foreground transition hover:text-foreground"
          >
            <Pencil className="h-3 w-3" /> Edit monthly goal in Plan
          </button>
        )}
      </div>
    </ArcadePanel>
  );
}
