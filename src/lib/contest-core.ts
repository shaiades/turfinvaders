// Contest-core — the game-agnostic date/pace primitives both contest engines
// share (lifted from kombat-month.ts for Tier 3 of the engagement audit,
// 2026-11-03). Close Kombat (sales reps, month-scoped) and the canvasser
// FINAL ROUND (arbitrary start–end window) both count Mon–Sat workdays, frame
// weeks as fight ROUNDs and project a straight-line pace; only the rules
// types differ, so the shared math takes plain ISO strings. Pure LA-date
// string arithmetic, no fetches. kombat-month.ts delegates here (its verify
// suite pins that the lift changed nothing); canvasser-arcade.ts builds the
// finale wrappers on top.

import { addDaysISO, laTodayISO } from "@/lib/dates";

/** Mon–Sat: Sundays are off in both games (nobody knocks, nobody pitches). */
export const isWorkdayISO = (iso: string): boolean =>
  new Date(`${iso}T12:00:00Z`).getUTCDay() !== 0;

export type RangeWorkdays = { total: number; elapsed: number; remaining: number };

/** Mon–Sat days of [start, end]. `elapsed` runs through today inclusive
 *  (0 before the range); `remaining` runs FROM today inclusive — they
 *  deliberately overlap on today, because pace counts today's partial work
 *  while "need per day" still has today to work with. */
export function rangeWorkdays(
  start: string,
  end: string,
  todayISO: string = laTodayISO(),
): RangeWorkdays {
  let total = 0;
  let elapsed = 0;
  let remaining = 0;
  for (let d = start; d <= end; d = addDaysISO(d, 1)) {
    if (!isWorkdayISO(d)) continue;
    total += 1;
    if (d <= todayISO) elapsed += 1;
    if (d >= todayISO) remaining += 1;
  }
  return { total, elapsed, remaining };
}

/** Straight-line projection scale off the elapsed-workday run rate — the
 *  linear model PaycheckCard, Kombat pace and the finale all share. Day one
 *  (or an opening Sunday) has no elapsed workday yet: treat it as one so
 *  early points project forward instead of reading as zero. */
export function paceScale(wd: RangeWorkdays): number {
  return wd.total / Math.max(1, wd.elapsed);
}

export type RangeRound = {
  /** 1-based fight-round number of the week today falls in. */
  roundNumber: number;
  totalRounds: number;
  /** The round's clamped window inside the contest range. */
  start: string;
  end: string;
  /** Calendar days from today through the round's end, inclusive. */
  daysLeftInRound: number;
};

/** The contest week as a fight ROUND: Monday-anchored weeks clamped to
 *  [start, end], numbered from the range's first week (a partial opening
 *  week is ROUND 1). Null outside the range. */
export function rangeRound(
  start: string,
  end: string,
  todayISO: string = laTodayISO(),
): RangeRound | null {
  if (todayISO < start || todayISO > end) return null;
  // Monday of the range's first week.
  const dow = new Date(`${start}T12:00:00Z`).getUTCDay();
  const firstMonday = addDaysISO(start, -((dow + 6) % 7));
  let roundNumber = 0;
  let totalRounds = 0;
  let roundStart = start;
  let roundEnd = end;
  for (let ws = firstMonday, n = 1; ws <= end; ws = addDaysISO(ws, 7), n += 1) {
    totalRounds = n;
    const s = ws < start ? start : ws;
    const e = addDaysISO(ws, 6) > end ? end : addDaysISO(ws, 6);
    if (todayISO >= s && todayISO <= e) {
      roundNumber = n;
      roundStart = s;
      roundEnd = e;
    }
  }
  let daysLeftInRound = 0;
  for (let d = todayISO; d <= roundEnd; d = addDaysISO(d, 1)) daysLeftInRound += 1;
  return { roundNumber, totalRounds, start: roundStart, end: roundEnd, daysLeftInRound };
}

/** Calendar days from today through `end`, inclusive; 0 once past. The
 *  urgency number on contest banners. */
export function daysLeftInRange(
  start: string,
  end: string,
  todayISO: string = laTodayISO(),
): number {
  if (todayISO > end) return 0;
  let n = 0;
  for (let d = todayISO < start ? start : todayISO; d <= end; d = addDaysISO(d, 1)) n += 1;
  return n;
}
