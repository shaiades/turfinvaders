// Kombat Month — the hero "belt" (owner revamp 2026-10-02): what you're
// fighting for sits at the TOP. A climbable championship-belt ladder with
// YOU-ARE-HERE, your live points (count-up), the carrot to the next belt,
// the $3M team boss bar with a season countdown, and the rules + the
// eligibility gates folded in. Pure presentation — all values come from
// `rules` and the ledger totals passed in.

import { ArcadePanel, ArcadeSkeleton, NeonBar, NeonButton } from "@/components/arcade";
import { useCountUp } from "@/hooks/useCountUp";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import {
  BELT_ACCENT,
  contestDaysLeft,
  fmtPts,
  tierFor,
  type EligibilityStatus,
  type KombatRules,
  type RepTotals,
} from "@/lib/kombat-month";

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

export function KombatBeltLadder({
  rules,
  loading,
  matched,
  myTotals,
  written,
  eligibility,
  canSubmit,
  onSubmitProof,
}: {
  rules: KombatRules;
  loading: boolean;
  /** false = the viewer isn't on the board yet (show the ladder, no "you"). */
  matched: boolean;
  myTotals: RepTotals | undefined;
  written: number;
  eligibility: EligibilityStatus;
  canSubmit: boolean;
  onSubmitProof: () => void;
}) {
  const reduced = usePrefersReducedMotion();
  const myTotal = myTotals?.total ?? 0;
  const tier = tierFor(myTotal, rules);
  const points = useCountUp(myTotal, reduced || !matched);

  // Belts highest-first — climbing the ladder reads as rising.
  const belts = [...rules.prizes.tiers].sort((a, b) => b.points - a.points);
  const unlocked = written >= rules.prizes.unlock_threshold;

  // Carrot progress: from the current belt's floor to the next belt's wall.
  const floor = tier.current?.points ?? 0;
  const ceil = tier.next?.points ?? tier.current?.points ?? 1;
  const carrotPct = tier.next ? (myTotal - floor) / Math.max(1, ceil - floor) : 1;
  const daysLeft = contestDaysLeft(rules);

  return (
    <ArcadePanel
      title={rules.contest.label}
      faction="kombat"
      status={loading ? "warn" : "good"}
      headline={
        <span className="timer-display !text-[11px] !tracking-[0.12em] px-2 py-0.5">
          {daysLeft > 0 ? `${daysLeft}D LEFT` : "SEASON OVER"}
        </span>
      }
      action={
        canSubmit ? (
          <NeonButton tone="kombat-gold" onClick={onSubmitProof}>
            Submit proof
          </NeonButton>
        ) : undefined
      }
    >
      {loading ? (
        <ArcadeSkeleton className="h-64" />
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          {/* Left: your standing + the carrot + boss bar */}
          <div className="min-w-0">
            <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              {matched ? "Your points" : "Points to win"}
            </div>
            <div
              className={
                "font-display tabular-nums text-kombat-gold leading-none mt-1 text-[clamp(2.2rem,12vw,3.5rem)] " +
                (points.bump
                  ? "transition-transform duration-200 scale-105"
                  : "transition-transform duration-200")
              }
              style={{
                textShadow: "0 0 24px color-mix(in oklab, var(--kombat-gold) 55%, transparent)",
              }}
            >
              {fmtPts(matched ? points.display : 0)}
            </div>
            {matched ? (
              <div className="mt-1 text-xs text-muted-foreground">
                <span className="text-kombat-gold font-semibold">
                  {fmtPts(myTotals?.locked ?? 0)}
                </span>{" "}
                final ·{" "}
                <span className="text-foreground font-semibold">
                  {fmtPts(myTotals?.pending ?? 0)}
                </span>{" "}
                live
              </div>
            ) : (
              <div className="mt-1 text-xs text-muted-foreground">
                Your row opens on your first synced October sale.
              </div>
            )}

            {/* Carrot */}
            <div className="mt-4">
              {tier.next ? (
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-semibold">
                    <span className="text-kombat-gold tabular-nums">{fmtPts(tier.toNext)} pts</span>{" "}
                    to {tier.next.label}
                  </span>
                  <span className="text-xs text-kombat-gold font-display uppercase tracking-widest">
                    {tier.next.cash > 0
                      ? `+${fmtMoney(cashWithUnlock(tier.next.cash, unlocked, rules))}`
                      : "Dinner"}
                  </span>
                </div>
              ) : (
                <div className="text-sm font-semibold text-kombat-gold">
                  👑 KOMBAT KING — you maxed the ladder.
                </div>
              )}
              <NeonBar pct={carrotPct} accent="var(--kombat-gold)" />
            </div>

            {/* $3M boss bar */}
            <div className="mt-5">
              <div className="flex items-baseline justify-between gap-2 text-[10px] font-display uppercase tracking-widest">
                <span className={unlocked ? "text-kombat-gold" : "text-muted-foreground"}>
                  Team goal — crack $3M
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {fmtMoney(written)} / {fmtMoney(rules.prizes.unlock_threshold)}
                </span>
              </div>
              <NeonBar
                pct={written / rules.prizes.unlock_threshold}
                accent={unlocked ? "var(--victory)" : "var(--kombat-red)"}
                tall
                sheen
              />
              <p className="mt-1.5 text-xs">
                {unlocked ? (
                  <span className="text-victory font-semibold">
                    💥 $3M SMASHED — every cash prize pays ×{rules.prizes.unlock_multiplier}.
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    Drop the boss together → every cash tier pays ×{rules.prizes.unlock_multiplier}.
                  </span>
                )}
              </p>
            </div>
          </div>

          {/* Right: the belt ladder */}
          <div className="min-w-0">
            <ol className="space-y-1.5">
              {belts.map((b) => {
                const cleared = myTotal >= b.points;
                const isTarget = tier.next?.key === b.key;
                const accent = BELT_ACCENT[b.key] ?? "var(--kombat-gold)";
                return (
                  <li
                    key={b.key}
                    className={
                      "flex items-center gap-3 rounded-md border px-3 py-2.5 transition-colors " +
                      (cleared
                        ? "border-kombat-gold/60 bg-[color-mix(in_oklab,var(--kombat-gold)_10%,transparent)]"
                        : isTarget
                          ? "border-kombat-red/60 bg-[color-mix(in_oklab,var(--kombat-red)_12%,transparent)]"
                          : "border-border opacity-60")
                    }
                    style={cleared ? { boxShadow: `0 0 16px -6px ${accent}` } : undefined}
                  >
                    <BeltIcon cleared={cleared} isTarget={isTarget} accent={accent} />
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate font-display text-[11px] uppercase tracking-widest"
                        style={{ color: cleared || isTarget ? accent : undefined }}
                      >
                        {b.label}
                      </span>
                      <span className="block text-[10px] text-muted-foreground tabular-nums">
                        {b.points} pts{isTarget && matched ? ` · ${fmtPts(tier.toNext)} to go` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-sm font-semibold tabular-nums">
                        {b.cash > 0 ? fmtMoney(cashWithUnlock(b.cash, unlocked, rules)) : "Dinner"}
                      </span>
                      <span className="block text-[9px] uppercase tracking-widest text-muted-foreground">
                        {cleared ? "Cleared" : isTarget ? "Next" : "Locked"}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      )}

      {/* Rules + eligibility gates */}
      <div className="mt-5 border-t border-kombat-red/20 pt-4">
        <p className="text-xs text-muted-foreground">
          Earn points on{" "}
          <span className="text-foreground">every sale, every activity, every proof</span>. Points
          count the second they land and update live all month; a cancellation drops them right
          away. The count locks after the cancel window at month end — that's the final tally. Hit a
          belt by <span className="text-kombat-gold">Oct 31</span> to win the cash.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Gate
            ok={eligibility.purposeOk}
            label="My Purpose done"
            detail={eligibility.purposeOk ? "Unlocked" : "Finish the workshop"}
          />
          <Gate
            ok={eligibility.testsOk}
            label="Weekly Activity Test"
            detail={`${eligibility.weeksHit}/${eligibility.weeksDue} weeks`}
          />
          <Gate
            ok={eligibility.saleOk}
            label="A sale that sticks"
            detail={eligibility.saleOk ? "Unlocked" : "Close one this month"}
          />
        </div>
        {!eligibility.eligible && (
          <p className="mt-2 text-[11px] text-warning">
            ⚠ Clear all three gates or you can't collect — points mean nothing without the cash.
          </p>
        )}
      </div>
    </ArcadePanel>
  );
}

function cashWithUnlock(cash: number, unlocked: boolean, rules: KombatRules): number {
  return unlocked ? cash * rules.prizes.unlock_multiplier : cash;
}

function BeltIcon({
  cleared,
  isTarget,
  accent,
}: {
  cleared: boolean;
  isTarget: boolean;
  accent: string;
}) {
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold"
      style={{
        borderColor: cleared || isTarget ? accent : "var(--border)",
        color: cleared || isTarget ? accent : "var(--muted-foreground)",
        background: cleared ? `color-mix(in oklab, ${accent} 16%, transparent)` : "transparent",
      }}
    >
      {cleared ? "★" : isTarget ? "◆" : "🔒"}
    </span>
  );
}

function Gate({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div
      className={
        "flex items-start gap-2 rounded-md border px-2.5 py-2 " +
        (ok ? "border-victory/40 bg-victory/5" : "border-border")
      }
    >
      <span
        aria-hidden
        className={
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold " +
          (ok ? "border-victory text-victory" : "border-muted-foreground/40 text-muted-foreground")
        }
      >
        {ok ? "✓" : "·"}
      </span>
      <span className="min-w-0">
        <span className={"block text-xs font-medium " + (ok ? "" : "text-muted-foreground")}>
          {label}
        </span>
        <span className="block text-[10px] text-muted-foreground">{detail}</span>
      </span>
    </div>
  );
}
