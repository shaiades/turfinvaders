// The $100K Boss — a canvasser's monthly volume bonus, drawn as a boss fight.
// The boss's health is $100K; every credited sale chips it; dropping it to 0
// defeats the boss and the pay engine drops a $1,500 chest. HP, bonuses and the
// pace projection all come from useBossMeter → calc_monthly_paycheck, so the
// chest count on screen equals the dollars actually paid. Transforms/opacity
// only; the enrage pulse is suppressed under prefers-reduced-motion.

import { useBossMeter } from "@/hooks/useCanvasserArcade";
import { BOSS_BOUNTY } from "@/lib/canvasserPay";
import { ArcadePanel, ArcadeSkeleton } from "@/components/arcade";
import { useCountUp } from "@/hooks/useCountUp";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

export function BossMeter({ userId }: { userId: string }) {
  const { boss, pace, loading } = useBossMeter(userId);
  const reduced = usePrefersReducedMotion();
  const { display: hpDisplay } = useCountUp(boss.hpLeft, reduced);

  if (loading) {
    return (
      <ArcadePanel title="The $100K Boss" faction="kombat">
        <ArcadeSkeleton className="h-28 w-full" />
      </ArcadePanel>
    );
  }

  // Remaining-health bar: full at a fresh boss, chipped toward 0 at defeat.
  const hpPct = Math.max(0, Math.min(1, boss.hpLeft / boss.hpMax));
  const bloodColor = boss.enraged ? "var(--kombat-red)" : "var(--destructive)";

  return (
    <ArcadePanel
      title="The $100K Boss"
      faction="kombat"
      action={
        <span className="font-display text-[10px] uppercase tracking-widest text-[var(--kombat-gold)]">
          Boss {boss.level}
        </span>
      }
    >
      <div className="space-y-3">
        {/* HP line */}
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`font-display text-[11px] uppercase tracking-widest ${
              boss.enraged ? "text-[var(--kombat-red)]" : "text-muted-foreground"
            }`}
          >
            {boss.enraged ? "⚠ ENRAGED" : "Boss HP"}
          </span>
          <span className="font-display text-sm tabular-nums text-foreground">
            {money(hpDisplay)} <span className="text-[10px] text-muted-foreground">left</span>
          </span>
        </div>

        {/* The boss health bar: 10 × $10K segments, chipping down to 0. */}
        <div
          className={`relative h-5 w-full overflow-hidden rounded-md border border-border bg-[color-mix(in_oklab,var(--foreground)_6%,transparent)] ${
            boss.enraged && !reduced ? "boss-enrage" : ""
          }`}
        >
          <div
            className="h-full rounded-[3px] transition-[width] duration-700 ease-out"
            style={{
              width: `${hpPct * 100}%`,
              background: `linear-gradient(90deg, color-mix(in oklab, ${bloodColor} 55%, transparent), ${bloodColor})`,
              boxShadow: `0 0 16px ${bloodColor}`,
            }}
          />
          {/* Ten segment dividers. */}
          <div className="pointer-events-none absolute inset-0 flex">
            {Array.from({ length: 10 }).map((_, i) => (
              <span key={i} className="flex-1 border-r border-black/40 last:border-r-0" />
            ))}
          </div>
          <div className="scanlines pointer-events-none absolute inset-0 opacity-30" />
        </div>

        {/* To next bonus */}
        <p
          className={`text-center font-display text-[10px] uppercase tracking-widest ${
            boss.enraged ? "text-[var(--kombat-red)]" : "text-muted-foreground"
          }`}
        >
          {boss.enraged ? (
            <>
              ONE BIG ROOF AWAY — {money(boss.hpLeft)} to the next {money(BOSS_BOUNTY)}
            </>
          ) : (
            <>
              {money(boss.hpLeft)} to defeat Boss {boss.level} · {money(BOSS_BOUNTY)} chest
            </>
          )}
        </p>

        {/* Vault + pace */}
        <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
          <div className="min-w-0">
            <p className="font-display text-[9px] uppercase tracking-widest text-muted-foreground">
              Bonus vault
            </p>
            <p className="truncate text-sm">
              {boss.bossesDefeated > 0 ? (
                <>
                  <span aria-hidden>{"🧰".repeat(Math.min(boss.bossesDefeated, 6))}</span>{" "}
                  <span className="font-display text-victory tabular-nums">
                    {money(boss.bonusEarned)}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">No bosses down yet</span>
              )}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="font-display text-[9px] uppercase tracking-widest text-muted-foreground">
              On pace for
            </p>
            <p className="font-display text-sm text-[var(--kombat-gold)] tabular-nums">
              {pace.projectedBonuses} bonus{pace.projectedBonuses === 1 ? "" : "es"}
            </p>
          </div>
        </div>
      </div>
    </ArcadePanel>
  );
}
