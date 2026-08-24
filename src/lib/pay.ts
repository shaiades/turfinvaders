// DISPLAY-ONLY mirror of public.calc_weekly_paycheck.
//
// The authoritative pay engine lives in Postgres — latest definition:
// supabase/migrations/20260718192842_2f90b1c4-b52e-45f8-94a6-ed821aab8869.sql.
// If the SQL changes, change this file in the same commit. These helpers are
// for dashboard hints and projections only; real paychecks must come from the
// calc_weekly_paycheck RPC (via getWeeklyPaycheck/getWeeklyPaychecks server fns).

/** Points: a pitch-miss sit = 1 pt, a sale = 2 pts (demos_sits includes sale rows). */
export const POINTS_TIER_MID = 3;
export const POINTS_TIER_TOP = 7;

/** Weekly points from daily_logs vectors. demos_sits already includes sale
 *  rows, so demosSits + sales ≡ pitch-miss sits × 1 + sales × 2 — the same
 *  SUM(demos_sits + sales) calc_weekly_paycheck uses. Must not change values. */
export function weeklyPoints(demosSits: number, sales: number): number {
  return demosSits + sales;
}

export const HOURLY_BASE = 18;
export const HOURLY_MID = 30;
export const HOURLY_TOP = 35;

export const COMMISSION_BASE = 0.01;
export const COMMISSION_TOP = 0.02;

export const SIT_BONUS_THRESHOLD = 3;
export const SIT_BONUS_PER = 50;
export const SIT_BONUS_PER_ELEVATED = 75;

export const MONSTER_BONUS = 500;
export const MONSTER_THRESHOLD = 10;

/** Ranks whose hourly rate and commission are locked at the top tier. */
export const RATE_LOCK_RANKS = ["Jr. Diamond", "Sr. Diamond", "Captain"] as const;
/** Ranks that earn the elevated per-sit bonus. */
export const ELEVATED_SIT_BONUS_RANKS = ["Sr. Gold", ...RATE_LOCK_RANKS] as const;

/** Monthly Volume Bonus: $1,500 per full $100k of confirmed sale volume
 *  in a calendar month (computed by calc_monthly_paycheck). */
export const VOLUME_BONUS_STEP = 100_000;
export const VOLUME_BONUS_PER = 1_500;

export function volumeBonusForMonthRevenue(revenue: number): number {
  return Math.floor(Math.max(0, revenue) / VOLUME_BONUS_STEP) * VOLUME_BONUS_PER;
}

/** Starting Pay Lock lifecycle (profiles.pay_lock_status). While 'reverted',
 *  the RATE_LOCK_RANKS rate lock is suspended and comp follows the normal
 *  weekly point tiers; rank and the $75 sit bonus are retained. */
export type PayLockStatus = "active" | "warned" | "reverted";
/** Minimum rolling 4-week sit average to keep the pay lock. */
export const PAY_LOCK_MIN_ROLLING_AVG = 5;

export function payRateForPoints(points: number, rank?: string | null): number {
  if (rank && (RATE_LOCK_RANKS as readonly string[]).includes(rank)) return HOURLY_TOP;
  if (points >= POINTS_TIER_TOP) return HOURLY_TOP;
  if (points >= POINTS_TIER_MID) return HOURLY_MID;
  return HOURLY_BASE;
}

export function commissionRateForPoints(points: number, rank?: string | null): number {
  if (rank && (RATE_LOCK_RANKS as readonly string[]).includes(rank)) return COMMISSION_TOP;
  return points >= POINTS_TIER_TOP ? COMMISSION_TOP : COMMISSION_BASE;
}

export function sitBonusPerForRank(rank?: string | null): number {
  return rank && (ELEVATED_SIT_BONUS_RANKS as readonly string[]).includes(rank)
    ? SIT_BONUS_PER_ELEVATED
    : SIT_BONUS_PER;
}

/** Base-pay hours come exclusively from clocked time_entries: full worked
 *  time minus PUNCHED (or manager-entered) meal periods only — there is no
 *  blanket deduction, Sundays pay when worked, and there is NO activity-based
 *  hour estimate: no clock-in means no base pay. */

/** CA overtime mirror of calc_weekly_paycheck v6 (change together!):
 *  workweek Mon–Sun LA; daily >8h = 1.5x, >12h = 2x; 7th consecutive day
 *  worked = first 8h at 1.5x, beyond at 2x; weekly straight time >40h = 1.5x
 *  (hours already premium daily never double-count). */
export const DAILY_OT_AFTER = 8;
export const DAILY_DT_AFTER = 12;
export const WEEKLY_OT_AFTER = 40;
export const MEAL_REQUIRED_AFTER_HOURS = 5;

export type WeekHoursSplit = { reg: number; ot: number; dt: number };

/** dayHours: billable hours per worked day of one Mon–Sun workweek, in day
 *  order with the 7th slot being Sunday. Mirrors the SQL exactly — the
 *  verify:overtime script asserts both stay in step. */
export function splitWeekHours(dayHours: number[]): WeekHoursSplit {
  const workedAllSeven = dayHours.length === 7 && dayHours.every((h) => h > 0);
  let reg = 0, ot = 0, dt = 0;
  dayHours.forEach((h, i) => {
    const is7th = workedAllSeven && i === 6;
    if (is7th) {
      ot += Math.min(h, DAILY_OT_AFTER);
      dt += Math.max(h - DAILY_OT_AFTER, 0);
    } else {
      reg += Math.min(h, DAILY_OT_AFTER);
      ot += Math.min(Math.max(h - DAILY_OT_AFTER, 0), DAILY_DT_AFTER - DAILY_OT_AFTER);
      dt += Math.max(h - DAILY_DT_AFTER, 0);
    }
  });
  if (reg > WEEKLY_OT_AFTER) {
    ot += reg - WEEKLY_OT_AFTER;
    reg = WEEKLY_OT_AFTER;
  }
  return { reg, ot, dt };
}

/** Premium dollars on top of straight-time-for-all-hours, given the split
 *  and the week's flat-sum bonuses + commission (Alvarado / DLSE 49.2.4). */
export function overtimePremiumPay(
  split: WeekHoursSplit,
  hourlyRate: number,
  flatBonus: number,
  commission: number,
): number {
  const hours = split.reg + split.ot + split.dt;
  let prem = 0.5 * hourlyRate * split.ot + 1.0 * hourlyRate * split.dt;
  if (split.reg > 0 && flatBonus > 0) {
    prem += (flatBonus / split.reg) * (1.5 * split.ot + 2.0 * split.dt);
  }
  if (hours > 0 && commission > 0) {
    prem += (commission / hours) * (0.5 * split.ot + 1.0 * split.dt);
  }
  return prem;
}
