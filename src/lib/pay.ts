// DISPLAY-ONLY mirror of public.calc_weekly_paycheck.
//
// The authoritative pay engine lives in Postgres — latest definition:
// supabase/migrations/20260718183328_2ff3e696-8536-402a-b53c-e6d69f4f9fcc.sql.
// If the SQL changes, change this file in the same commit. These helpers are
// for dashboard hints and projections only; real paychecks must come from the
// calc_weekly_paycheck RPC (via getWeeklyPaycheck/getWeeklyPaychecks server fns).

/** Points: a pitch-miss sit = 1 pt, a sale = 2 pts (demos_sits includes sale rows). */
export const POINTS_TIER_MID = 3;
export const POINTS_TIER_TOP = 7;

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

/** Assumed billable hours for a log date when no time was clocked (Sun 0 / Sat 6.5 / Mon–Fri 7.5). */
export function hoursForLogDate(isoDate: string): number {
  const dow = new Date(isoDate + "T00:00:00Z").getUTCDay();
  if (dow === 0) return 0;
  if (dow === 6) return 6.5;
  return 7.5;
}
