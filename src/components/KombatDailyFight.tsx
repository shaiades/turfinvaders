// The Daily Fight (owner audit 2026-11-01) — the me-vs-me strip. The belt
// ladder sells the month; this card sells TODAY: points scored today, the
// straight-line projection of your check, the per-day rate the next rung
// demands, the scoring-day combo, and the coach's callout naming your
// biggest untapped move. Pure presentation over the lib's daily math.

import { ArcadePanel } from "@/components/arcade";
import { useCountUp } from "@/hooks/useCountUp";
import {
  coachCallout,
  fmtPts,
  paceProjection,
  scoringStreak,
  tierFor,
  todayPoints,
  type DailyRowLite,
  type KombatRules,
  type RepTotals,
} from "@/lib/kombat-month";

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

export function KombatDailyFight({
  rules,
  myTotals,
  myRows,
  matched,
  unlockActive,
  tookTestThisWeek,
}: {
  rules: KombatRules;
  myTotals: RepTotals | undefined;
  myRows: readonly DailyRowLite[];
  matched: boolean;
  unlockActive: boolean;
  tookTestThisWeek?: boolean;
}) {
  const today = matched ? todayPoints(myRows) : 0;
  const pace = paceProjection(matched ? myTotals : undefined, rules, unlockActive);
  const streak = matched ? scoringStreak(myRows) : { days: 0, aliveToday: false };
  const callout = matched
    ? coachCallout(myTotals, rules, tookTestThisWeek)
    : {
        label: "Enter the ring",
        line: "Your first synced sale opens your row — then the daily fight begins.",
      };
  const next = tierFor(myTotals?.total ?? 0, rules).next;
  const todayCount = useCountUp(today, !matched);

  return (
    <ArcadePanel
      title="Daily Fight"
      faction="kombat"
      status="good"
      headline={
        streak.days >= 2 ? (
          <span className="font-display text-[10px] uppercase tracking-widest text-kombat-gold">
            🔥 {streak.days}-day combo
          </span>
        ) : undefined
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Today"
          value={fmtPts(todayCount.display)}
          bump={todayCount.bump}
          sub={streak.aliveToday ? "pts · combo alive" : "pts — score to keep the combo"}
          accent={today > 0 ? "var(--victory)" : undefined}
        />
        <Stat
          label="On pace for"
          value={
            pace.projectedCheck > 0
              ? fmtMoney(pace.projectedCheck)
              : `${fmtPts(pace.projectedPoints)} pts`
          }
          sub={
            pace.projectedTier
              ? `${pace.projectedTier.label} at today's pace`
              : "no rate at today's pace — push"
          }
          foil={pace.projectedCheck > 0}
          accent={pace.projectedTier ? undefined : "var(--kombat-red)"}
        />
        <Stat
          label="Need / day"
          value={next ? fmtPts(Math.ceil(pace.perDayNeeded * 10) / 10) : "👑"}
          sub={
            next
              ? `for ${next.label}${(next.pct ?? 0) > 0 ? ` (${next.pct}%)` : ""}`
              : "ladder maxed"
          }
        />
        <Stat
          label="Combo"
          value={streak.days >= 2 ? `🔥 ${streak.days}` : streak.aliveToday ? "🔥 1" : "—"}
          sub={
            streak.days >= 2 || streak.aliveToday
              ? "scoring days in a row"
              : "start one — score today"
          }
          shine={streak.days >= 5}
        />
      </div>

      <div className="mt-3 rounded-md border border-kombat-red/50 bg-[color-mix(in_oklab,var(--kombat-red)_12%,transparent)] px-3 py-2.5">
        <span className="font-display text-[9px] uppercase tracking-widest text-kombat-red">
          Coach says · {callout.label}
        </span>
        <p className="mt-1 text-sm leading-snug">{callout.line}</p>
      </div>
    </ArcadePanel>
  );
}

function Stat({
  label,
  value,
  sub,
  foil = false,
  shine = false,
  bump = false,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  foil?: boolean;
  shine?: boolean;
  bump?: boolean;
  accent?: string;
}) {
  return (
    <div
      className={
        "rounded-md border border-kombat-gold/25 bg-black/40 px-3 py-2.5 " +
        (shine ? "kombat-cash-shine" : "")
      }
    >
      <span className="block font-display text-[9px] uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <span
        className={
          "mt-1 block font-bold tabular-nums leading-tight " +
          (value.length > 7 ? "text-lg sm:text-xl " : "text-xl sm:text-2xl ") +
          (foil ? "gold-foil-text " : "") +
          (bump
            ? "transition-transform duration-200 scale-105"
            : "transition-transform duration-200")
        }
        style={!foil && accent ? { color: accent } : undefined}
      >
        {value}
      </span>
      <span className="mt-0.5 block text-[10px] text-muted-foreground">{sub}</span>
    </div>
  );
}
