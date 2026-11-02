// Kombat Month — the hero "belt" (owner revamp 2026-10-02): what you're
// fighting for sits at the TOP. A climbable championship-belt ladder with
// YOU-ARE-HERE, your live points (count-up), the carrot to the next belt,
// the $3M team boss bar with a season countdown, and the rules + the
// eligibility gates folded in. Pure presentation — all values come from
// `rules` and the ledger totals passed in.

import { ArcadePanel, ArcadeSkeleton, NeonBar, NeonButton } from "@/components/arcade";
import { CoinRain } from "@/components/KombatArena";
import { useCountUp } from "@/hooks/useCountUp";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import {
  BELT_ACCENT,
  contestDaysLeft,
  fmtPts,
  tierFor,
  tierPayout,
  volumeBaseDollars,
  type EligibilityStatus,
  type KombatRules,
  type KombatTier,
  type RepTotals,
} from "@/lib/kombat-month";
import { RepAvatar } from "@/components/RepAvatar";
import { cartoonFor, type RepCartoon } from "@/hooks/useRepCartoons";

const SERIF = 'Georgia, Cambria, "Times New Roman", serif';

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
  onTakeTest,
  totals = [],
  cartoons,
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
  /** Rep-only: open the Weekly Activity Test straight from its gate. When
   *  absent (e.g. an owner/office viewer) the gate stays a read-only chip. */
  onTakeTest?: () => void;
  /** All reps — to stack everyone's fighter on the belt they've reached. */
  totals?: RepTotals[];
  cartoons?: Map<string, RepCartoon>;
}) {
  const reduced = usePrefersReducedMotion();
  const myTotal = myTotals?.total ?? 0;
  const tier = tierFor(myTotal, rules);
  const points = useCountUp(myTotal, reduced || !matched);

  // Belts highest-first — climbing the ladder reads as rising.
  const belts = [...rules.prizes.tiers].sort((a, b) => b.points - a.points);
  const unlocked = written >= rules.prizes.unlock_threshold;
  const cashBack = belts.some((b) => (b.pct ?? 0) > 0);
  const myBase = volumeBaseDollars(myTotals, rules);
  // The hero number on a cash-back ladder: the check as it stands RIGHT NOW.
  const myCheck = tier.current ? tierPayout(tier.current, myBase, unlocked, rules) : 0;
  const check = useCountUp(myCheck, reduced || !matched);

  // Who sits on each belt right now (their highest cleared tier) — the shared
  // climb: every rep's fighter stacked on their current rung.
  const byBelt = new Map<string, RepTotals[]>();
  for (const t of totals) {
    const key = tierFor(t.total, rules).current?.key ?? "__none__";
    const arr = byBelt.get(key);
    if (arr) arr.push(t);
    else byBelt.set(key, [t]);
  }

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
          {/* Left: your standing + the carrot + boss bar. Money rains behind
              the whole column; a gold aura breathes behind your score. */}
          <div className="relative min-w-0">
            {matched && myTotal > 0 && <CoinRain count={cashBack ? 14 : 10} className="z-0" />}
            <div className="relative z-10">
              <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                {cashBack
                  ? matched
                    ? "Your check so far"
                    : "Cash on the table"
                  : matched
                    ? "Your points"
                    : "Points to win"}
              </div>
              {/* w-fit so the aura centers on the number itself, not the column. */}
              <div className="relative mt-1 w-fit">
                {matched && (
                  <span aria-hidden className="kombat-hero-aura z-0 h-28 w-28 md:h-36 md:w-36" />
                )}
                <div
                  className={
                    "kombat-score-flare relative z-10 font-display tabular-nums leading-none text-[clamp(2.2rem,12vw,3.5rem)] " +
                    (cashBack ? "gold-foil-text " : "text-kombat-gold ") +
                    ((cashBack ? check.bump : points.bump)
                      ? "transition-transform duration-200 scale-105"
                      : "transition-transform duration-200")
                  }
                >
                  {cashBack
                    ? fmtMoney(matched ? check.display : 0)
                    : fmtPts(matched ? points.display : 0)}
                </div>
              </div>
              {matched ? (
                cashBack ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    <span className="text-kombat-gold font-semibold tabular-nums">
                      {fmtPts(myTotal)} pts
                    </span>{" "}
                    ·{" "}
                    {tier.current && (tier.current.pct ?? 0) > 0 ? (
                      <>
                        <span className="text-victory font-semibold">
                          {fmtRate(
                            tier.current.pct! * (unlocked ? rules.prizes.unlock_multiplier : 1),
                          )}
                          % of {fmtMoney(myBase)} written
                        </span>
                      </>
                    ) : (
                      <span>
                        no rate unlocked yet —{" "}
                        <span className="text-foreground font-semibold">
                          {firstRungTeaser(belts, myBase, unlocked, rules)}
                        </span>
                      </span>
                    )}
                  </div>
                ) : (
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
                )
              ) : (
                <div className="mt-1 text-xs text-muted-foreground">
                  Your row opens on your first synced {contestMonthName(rules)} sale.
                </div>
              )}

              {/* Carrot */}
              <div className="mt-4">
                {tier.next ? (
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-semibold">
                      <span className="text-kombat-gold tabular-nums">
                        {fmtPts(tier.toNext)} pts
                      </span>{" "}
                      to {tier.next.label}
                    </span>
                    <span className="text-xs text-kombat-gold font-display uppercase tracking-widest">
                      {carrotLabel(tier.next, tier.current, myBase, unlocked, rules)}
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
                    Team goal — crack {fmtMoneyShort(rules.prizes.unlock_threshold)}
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
                      💥 {fmtMoneyShort(rules.prizes.unlock_threshold)} SMASHED — every{" "}
                      {cashBack ? "rate" : "cash prize"} pays ×{rules.prizes.unlock_multiplier}.
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      Drop the boss together → every {cashBack ? "rate" : "cash tier"} pays ×
                      {rules.prizes.unlock_multiplier}.
                    </span>
                  )}
                </p>
              </div>
            </div>
          </div>

          {/* Right: the CASH poster — the November launch poster's treatment
              (navy halftone, marquee bulbs, gold-foil lettering) carrying the
              live where-you-stand ladder. The October feast flyer lives on
              for flat-cash ladders only. */}
          <div
            className={
              "relative min-w-0 overflow-hidden rounded-xl border-2 border-kombat-gold/40 " +
              (cashBack ? "kombat-marquee kombat-cash-backdrop" : "")
            }
            style={{
              boxShadow: "0 0 30px -12px color-mix(in oklab, var(--kombat-gold) 55%, transparent)",
            }}
          >
            {!cashBack && (
              <>
                <img
                  src="/close-kombat-feast.jpg"
                  alt=""
                  aria-hidden
                  className="absolute inset-0 z-0 h-full w-full object-cover object-center"
                />
                <span
                  aria-hidden
                  className="absolute inset-0 z-0"
                  style={{
                    background:
                      "linear-gradient(180deg, rgba(8,6,4,.93) 0%, rgba(8,6,4,.5) 32%, rgba(8,6,4,.58) 60%, rgba(8,6,4,.95) 100%)",
                  }}
                />
              </>
            )}
            <div className={"relative z-10 " + (cashBack ? "p-5 sm:p-6" : "p-4 sm:p-5")}>
              <div className="font-display text-[9px] uppercase tracking-widest text-kombat-gold">
                What you're fighting for
              </div>
              {cashBack ? (
                <>
                  <div className="mt-1 font-display text-lg uppercase leading-relaxed sm:text-xl">
                    <span className="gold-foil-text">It's all about the </span>
                    <span
                      className="text-victory"
                      style={{
                        textShadow: "0 0 16px color-mix(in oklab, var(--victory) 70%, transparent)",
                      }}
                    >
                      CA$H
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-white/80">
                    Your points set your rate. Your rate × everything you write = your check.
                  </p>
                </>
              ) : (
                <>
                  <div
                    className="text-2xl font-black text-kombat-gold sm:text-3xl"
                    style={{ fontFamily: SERIF, textShadow: "0 2px 18px rgba(0,0,0,.7)" }}
                  >
                    The Belt Ladder
                  </div>
                  <p className="mt-0.5 text-xs text-white/80">
                    Hit a belt by month end — the cash is yours.
                  </p>
                </>
              )}
              <ol className="mt-4 space-y-1.5">
                {belts.map((b) => {
                  const cleared = myTotal >= b.points;
                  const isTarget = tier.next?.key === b.key;
                  const accent = BELT_ACCENT[b.key] ?? "var(--kombat-gold)";
                  const atBelt = byBelt.get(b.key) ?? [];
                  return (
                    <li
                      key={b.key}
                      className={
                        "flex items-center gap-3 rounded-md border px-3 py-2.5 transition-colors " +
                        (isTarget && cashBack ? "kombat-cash-shine " : "") +
                        (cleared
                          ? "border-kombat-gold/60 bg-[color-mix(in_oklab,var(--kombat-gold)_16%,rgba(0,0,0,.5))]"
                          : isTarget
                            ? "border-kombat-red/60 bg-[color-mix(in_oklab,var(--kombat-red)_18%,rgba(0,0,0,.5))]"
                            : "border-kombat-gold/20 bg-black/50")
                      }
                      style={cleared ? { boxShadow: `0 0 16px -6px ${accent}` } : undefined}
                    >
                      <BeltIcon
                        cleared={cleared}
                        isTarget={isTarget}
                        accent={accent}
                        crown={cashBack && b === belts[0]}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className="block font-display text-[11px] uppercase tracking-widest leading-relaxed"
                          style={{ color: cleared || isTarget ? accent : undefined }}
                        >
                          {b.label}
                        </span>
                        <span className="block text-[10px] text-muted-foreground tabular-nums">
                          {b.points} pts
                          {isTarget && matched ? ` · ${fmtPts(tier.toNext)} to go` : ""}
                        </span>
                        {atBelt.length > 0 && (
                          <span className="mt-1.5 flex flex-wrap items-center gap-1">
                            {atBelt.slice(0, 6).map((t) => (
                              <RepAvatar
                                key={t.rep_name}
                                name={t.rep_name}
                                cartoon={cartoonFor(cartoons, t.rep_name)}
                                className="h-6 w-6"
                                textClassName="text-[0.5rem]"
                              />
                            ))}
                            {atBelt.length > 6 && (
                              <span className="text-[10px] text-muted-foreground tabular-nums">
                                +{atBelt.length - 6}
                              </span>
                            )}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-right">
                        {(b.pct ?? 0) > 0 ? (
                          <span className="block font-display text-base leading-relaxed sm:text-lg">
                            <span className="gold-foil-text">
                              {fmtRate(b.pct! * (unlocked ? rules.prizes.unlock_multiplier : 1))}%
                            </span>
                          </span>
                        ) : (
                          <span className="block text-sm font-semibold tabular-nums">
                            {b.cash > 0
                              ? fmtMoney(cashWithUnlock(b.cash, unlocked, rules))
                              : "Dinner"}
                          </span>
                        )}
                        <span
                          className={
                            "block text-[9px] uppercase tracking-widest " +
                            ((b.pct ?? 0) > 0 && (b.floor ?? 0) > 0
                              ? "text-victory/90"
                              : "text-muted-foreground")
                          }
                        >
                          {(b.pct ?? 0) > 0 && (b.floor ?? 0) > 0
                            ? `min ${fmtMoney(b.floor!)}`
                            : cleared
                              ? "Cleared"
                              : isTarget
                                ? "Next"
                                : "Locked"}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        </div>
      )}

      {/* Rules + eligibility gates */}
      <div className="mt-5 border-t border-kombat-red/20 pt-4">
        <p className="text-xs text-muted-foreground">
          {cashBack ? (
            <>
              <span className="text-kombat-gold font-semibold">
                Your points set your rate. Your rate × everything you write = your check.
              </span>{" "}
              Earn points on{" "}
              <span className="text-foreground">every sale, every activity, every proof</span> — and
              every level you climb re-prices the whole month you already wrote.
            </>
          ) : (
            <>
              <span className="text-kombat-gold font-semibold">Hit a belt, win its cash.</span> Earn
              points on{" "}
              <span className="text-foreground">every sale, every activity, every proof</span>.
            </>
          )}{" "}
          Points count the second they land and update live all month; a cancellation drops them
          right away. The count locks after the cancel window at month end — that's the final tally.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Gate
            ok={eligibility.purposeOk}
            label="My Purpose done"
            detail={eligibility.purposeOk ? "Unlocked" : "Finish the workshop"}
          />
          {rules.eligibility.require_weekly_test ? (
            <Gate
              ok={eligibility.testsOk}
              label="Weekly Activity Test"
              detail={`${eligibility.weeksHit}/${eligibility.weeksDue} weeks`}
              onClick={onTakeTest}
            />
          ) : (
            <Gate
              ok={eligibility.weeksHit > 0}
              label="Weekly Activity Test"
              detail={
                rules.activity.weekly_test > 0
                  ? `${eligibility.weeksHit}/${eligibility.weeksDue} weeks · ${rules.activity.weekly_test} pts each`
                  : `${eligibility.weeksHit}/${eligibility.weeksDue} weeks`
              }
              onClick={onTakeTest}
            />
          )}
          <Gate
            ok={eligibility.saleOk}
            label="A sale that sticks"
            detail={eligibility.saleOk ? "Unlocked" : "Close one this month"}
          />
        </div>
        {!eligibility.eligible && (
          <p className="mt-2 text-[11px] text-warning">
            ⚠ Clear every gate or you can't collect — points mean nothing without the cash.
          </p>
        )}
      </div>
    </ArcadePanel>
  );
}

function cashWithUnlock(cash: number, unlocked: boolean, rules: KombatRules): number {
  return unlocked ? cash * rules.prizes.unlock_multiplier : cash;
}

const fmtMoneyShort = (n: number): string =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : fmtMoney(n);

/** The carrot's prize label. On a cash-back ladder with volume on the
 *  board, show what reaching the next rung is worth in DOLLARS — the next
 *  rung re-prices everything already written, which is the whole hook. */
function carrotLabel(
  next: KombatTier,
  current: KombatTier | null,
  baseDollars: number,
  unlocked: boolean,
  rules: KombatRules,
): string {
  if ((next.pct ?? 0) > 0) {
    if (baseDollars > 0) {
      const now = current ? tierPayout(current, baseDollars, unlocked, rules) : 0;
      const then = tierPayout(next, baseDollars, unlocked, rules);
      return `+${fmtMoney(Math.max(0, then - now))}`;
    }
    return `${fmtPts(next.pct! * (unlocked ? rules.prizes.unlock_multiplier : 1))}% back`;
  }
  return next.cash > 0 ? `+${fmtMoney(cashWithUnlock(next.cash, unlocked, rules))}` : "Dinner";
}

function BeltIcon({
  cleared,
  isTarget,
  accent,
  crown = false,
}: {
  cleared: boolean;
  isTarget: boolean;
  accent: string;
  /** The top rung of a cash-back ladder wears the poster's crown. */
  crown?: boolean;
}) {
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold"
      style={{
        borderColor: cleared || isTarget || crown ? accent : "var(--border)",
        color: cleared || isTarget ? accent : "var(--muted-foreground)",
        background: cleared ? `color-mix(in oklab, ${accent} 16%, transparent)` : "transparent",
      }}
    >
      {crown ? "👑" : cleared ? "★" : isTarget ? "◆" : "🔒"}
    </span>
  );
}

/** "0.63", not "0.625000000001" — rate chips stay human. */
const fmtRate = (x: number): string => String(Math.round(x * 100) / 100);

const contestMonthName = (rules: KombatRules): string =>
  new Date(`${rules.contest.month}T12:00:00Z`).toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });

/** Before the first rung: what the lowest level already amounts to on the
 *  volume this rep has written — the "it's closer than you think" line. */
function firstRungTeaser(
  belts: readonly KombatTier[],
  baseDollars: number,
  unlocked: boolean,
  rules: KombatRules,
): string {
  const first = belts[belts.length - 1];
  if (!first || (first.pct ?? 0) === 0) return "";
  const worth = tierPayout(first, baseDollars, unlocked, rules);
  return `${first.label} at ${first.points} pts pays ${fmtMoney(worth)}`;
}

function Gate({
  ok,
  label,
  detail,
  onClick,
}: {
  ok: boolean;
  label: string;
  detail: string;
  /** When set, the gate becomes a button that fires this (e.g. take the test). */
  onClick?: () => void;
}) {
  const inner = (
    <>
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
        {onClick && (
          <span className="mt-0.5 block text-[10px] font-semibold uppercase tracking-wide text-kombat-gold">
            {ok ? "Take it again →" : "Take the test →"}
          </span>
        )}
      </span>
    </>
  );
  const base =
    "flex items-start gap-2 rounded-md border px-2.5 py-2 text-left " +
    (ok ? "border-victory/40 bg-victory/5" : "border-border");
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={
          base +
          " min-h-11 w-full transition-colors hover:border-kombat-gold/60 hover:bg-kombat-gold/5 " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kombat-gold/50 md:min-h-0"
        }
      >
        {inner}
      </button>
    );
  }
  return <div className={base}>{inner}</div>;
}
