// The ONE place the Canvasser Arcade reads pay from. Every dollar on the
// leaderboard, the $100K boss meter, the Paycheck HUD and the Daily Wrap comes
// through here — and every number is the REAL pay engine's. This module
// re-exports src/lib/pay.ts (the display mirror of calc_weekly_paycheck /
// calc_monthly_paycheck) and adds ONLY the arcade shaping on top: the $100K
// boss health math, the loot-chest breakdown of an actual paycheck row, the
// XP/level curve, pace projection and badge rules. No pay figure is invented
// here; the SQL engine (and pay.ts beside it) stay the source of truth, so if
// a rate changes there it changes here for free. The spec's TODO fields
// (perAppt / perSit flat payouts) intentionally do NOT exist — canvassers are
// paid a tiered hourly base + commission + the sit bonus ($50/sit starting on
// the 4th) + the $500 monster + the $1,500-per-$100K monthly volume bonus, and
// the loot breakdown shows exactly those, nothing made up.
//
// Pure module (imports only the pure pay.ts): unit-tested by
// scripts/verify-canvasser-pay.ts — run `npm run verify:canvasserpay`.

import {
  MONSTER_BONUS,
  MONSTER_THRESHOLD,
  SIT_BONUS_PER,
  SIT_BONUS_PER_ELEVATED,
  SIT_BONUS_THRESHOLD,
  sitBonusPerForRank,
  VOLUME_BONUS_PER,
  VOLUME_BONUS_STEP,
  volumeBonusForMonthRevenue,
} from "@/lib/pay";

export {
  MONSTER_BONUS,
  MONSTER_THRESHOLD,
  SIT_BONUS_PER,
  SIT_BONUS_PER_ELEVATED,
  SIT_BONUS_THRESHOLD,
  sitBonusPerForRank,
  VOLUME_BONUS_PER,
  VOLUME_BONUS_STEP,
  volumeBonusForMonthRevenue,
};

// ── The $100K boss ─────────────────────────────────────────────────────────
// Each boss is one full $100K block of confirmed sale volume (owner decision
// 2026-10-05: the boss meter matches the pay engine's CALENDAR-MONTH volume
// bonus exactly). Defeat a boss → the pay engine pays $1,500. HP is split into
// ten $10K segments; the last segment is the "enrage".

/** One boss's HP in dollars — a full $100K block. Mirrors VOLUME_BONUS_STEP. */
export const BOSS_HP = VOLUME_BONUS_STEP;
/** The $1,500 chest a defeated boss drops. Mirrors VOLUME_BONUS_PER. */
export const BOSS_BOUNTY = VOLUME_BONUS_PER;
/** Each boss HP bar is drawn as this many $10K chunks. */
export const BOSS_SEGMENTS = 10;
/** Dollars-left at or below which the boss turns "enraged" (red pulse). */
export const BOSS_ENRAGE_HP = BOSS_HP / BOSS_SEGMENTS; // $10K — one segment left

export type BossState = {
  /** 1-based number of the boss currently being fought (1 = first $100K). */
  level: number;
  /** Full $100K blocks already cleared this period. */
  bossesDefeated: number;
  /** $ the pay engine has already banked as volume bonus = defeated × $1,500. */
  bonusEarned: number;
  /** A boss's full HP ($100K). */
  hpMax: number;
  /** Dollars already dealt to the CURRENT boss (0 ≤ hpInto < $100K). */
  hpInto: number;
  /** Dollars still needed to defeat the current boss (= dollars to next bonus). */
  hpLeft: number;
  /** Progress on the current boss, 0..1. */
  pct: number;
  /** Whole $10K segments chipped off the current boss, 0..10. */
  segmentsCleared: number;
  /** True in the final $10K — "ONE BIG ROOF AWAY". */
  enraged: boolean;
};

/**
 * Boss state from a canvasser's month-to-date credited volume. `monthVolume`
 * must already be net of cancellations and exclude Job Walk / office credit —
 * the same number the pay engine's calc_monthly_paycheck uses — because the
 * $1,500 bonus here must equal the dollars actually paid. This function does
 * no filtering; it only shapes a trusted total into a health bar.
 */
export function bossState(monthVolume: number): BossState {
  const v = Math.max(0, monthVolume);
  const bossesDefeated = Math.floor(v / BOSS_HP);
  const hpInto = v - bossesDefeated * BOSS_HP; // 0 ≤ hpInto < BOSS_HP
  const hpLeft = BOSS_HP - hpInto;
  return {
    level: bossesDefeated + 1,
    bossesDefeated,
    // Derived through the engine helper so a rate change can never desync.
    bonusEarned: volumeBonusForMonthRevenue(v),
    hpMax: BOSS_HP,
    hpInto,
    hpLeft,
    pct: hpInto / BOSS_HP,
    segmentsCleared: Math.floor(hpInto / BOSS_ENRAGE_HP),
    // A freshly spawned boss (hpInto 0, hpLeft full) is never enraged.
    enraged: hpInto > 0 && hpLeft <= BOSS_ENRAGE_HP,
  };
}

export type PaceProjection = {
  /** Straight-line end-of-period volume from the pace so far. */
  projectedVolume: number;
  /** Bosses that pace would defeat (= $1,500 chests projected). */
  projectedBonuses: number;
};

/**
 * Straight-line projection of where the period ends at the current pace.
 * `workdaysElapsed` counts workdays that have already happened (today
 * inclusive); `workdaysTotal` is the period's workday count. Guards against
 * day-zero: with no elapsed workdays it reports the current total unchanged.
 */
export function paceProjection(
  monthVolume: number,
  workdaysElapsed: number,
  workdaysTotal: number,
): PaceProjection {
  const v = Math.max(0, monthVolume);
  const elapsed = Math.max(0, workdaysElapsed);
  const total = Math.max(elapsed, workdaysTotal);
  const projectedVolume = elapsed > 0 ? (v / elapsed) * total : v;
  return {
    projectedVolume,
    projectedBonuses: Math.floor(projectedVolume / BOSS_HP),
  };
}

// ── Loot breakdown ───────────────────────────────────────────────────────
// A real paycheck row, re-skinned as game loot. base = silver, commission =
// gems, sit bonus = gold, monster + volume bonus = treasure chests. There is
// deliberately NO "bronze / per-appointment" line: no such pay exists, and we
// never render a dollar figure that isn't in the engine.

export type LootCoin = "silver" | "gold" | "gems" | "chest";
export type LootKind = "base" | "commission" | "sitBonus" | "monster" | "volumeBonus";

export type LootLine = {
  kind: LootKind;
  /** Human label for the line, e.g. "Base pay". */
  label: string;
  /** Which treasure the line pays out in. */
  coin: LootCoin;
  /** Dollars — straight from the pay engine (may be 0; the UI dims zeroes). */
  amount: number;
};

/** Fields the loot breakdown reads off a paycheck row. All optional so a
 *  weekly-only or monthly-only caller can pass just what it has. */
export type LootInput = {
  /** Weekly clocked base pay (before OT/meal premium). */
  base_pay?: number;
  ot_premium_pay?: number;
  meal_premium_pay?: number;
  commission?: number;
  sit_bonus?: number;
  monster_bonus?: number;
  /** Monthly $1,500-per-$100K volume bonus. */
  volume_bonus?: number;
  volume_bonus_ot_true_up?: number;
};

/**
 * Loot lines in display order. `base` folds the clocked components (straight
 * base + OT premium + meal premium) into one silver line, since the arcade
 * treats "time on the clock" as one loot source. Lines are always returned
 * (even at $0) so the HUD can show the full ladder and dim what's empty.
 */
export function lootLines(input: LootInput): LootLine[] {
  const base = (input.base_pay ?? 0) + (input.ot_premium_pay ?? 0) + (input.meal_premium_pay ?? 0);
  const volume = (input.volume_bonus ?? 0) + (input.volume_bonus_ot_true_up ?? 0);
  return [
    { kind: "base", label: "Base pay", coin: "silver", amount: base },
    { kind: "commission", label: "Commission", coin: "gems", amount: input.commission ?? 0 },
    { kind: "sitBonus", label: "Sit bonus", coin: "gold", amount: input.sit_bonus ?? 0 },
    { kind: "monster", label: "Monster bonus", coin: "chest", amount: input.monster_bonus ?? 0 },
    { kind: "volumeBonus", label: "$100K bonus", coin: "chest", amount: volume },
  ];
}

/** Sum of a set of loot lines — the headline wallet number. */
export function lootTotal(lines: readonly LootLine[]): number {
  return lines.reduce((a, l) => a + l.amount, 0);
}

/**
 * Sit bonus for a sit count, mirroring the pay engine: $0 for the first 3 sits,
 * then $50 (or $75 for elevated ranks) for each sit starting on the 4th. Used
 * for live "earned today" previews before the weekly RPC lands; the official
 * number still comes from calc_weekly_paycheck.
 */
export function sitBonusFor(sits: number, rank?: string | null): number {
  return Math.max(0, Math.floor(sits) - SIT_BONUS_THRESHOLD) * sitBonusPerForRank(rank);
}

// ── XP & levels ────────────────────────────────────────────────────────────
// Light progression on top of the avatar card. XP is cosmetic (it never
// touches pay) so the curve can be whatever feels good; it is deterministic
// and tested so the Wrap's level-up bar always agrees with the profile card.

export const XP_PER = {
  /** Appointment set (a lead). */
  appt: 10,
  /** A sit (lead that reached the demo). */
  sit: 30,
  /** A sale from one of your leads. */
  sold: 100,
  /** Defeating a $100K boss. */
  boss: 1000,
} as const;

export type XpEvents = {
  appts?: number;
  sits?: number;
  solds?: number;
  bossesDefeated?: number;
};

/** Total XP from a bag of events. */
export function xpFor(e: XpEvents): number {
  return (
    (e.appts ?? 0) * XP_PER.appt +
    (e.sits ?? 0) * XP_PER.sit +
    (e.solds ?? 0) * XP_PER.sold +
    (e.bossesDefeated ?? 0) * XP_PER.boss
  );
}

/** Arcade rank titles by level (capped at the last for high levels). */
export const LEVEL_TITLES = [
  "Rookie Knocker",
  "Door Warrior",
  "Street Hunter",
  "Block Captain",
  "Turf Boss",
  "Neon Legend",
  "Arcade God",
] as const;

/** Cumulative XP required to BE at a given level (level 1 starts at 0).
 *  50·n·(n−1): L1=0, L2=100, L3=300, L4=600, L5=1000, … — a gentle ramp. */
export function cumXpForLevel(level: number): number {
  const n = Math.max(1, Math.floor(level));
  return 50 * n * (n - 1);
}

export type LevelState = {
  level: number;
  title: string;
  /** XP accumulated inside the current level. */
  intoLevel: number;
  /** XP span of the current level (intoLevel / levelSpan = pct). */
  levelSpan: number;
  /** Progress through the current level, 0..1. */
  pct: number;
  /** Total XP needed to reach the next level. */
  nextLevelAt: number;
};

/** Resolve a total XP into its level, title and progress to the next level. */
export function levelForXp(totalXp: number): LevelState {
  const xp = Math.max(0, totalXp);
  let level = 1;
  while (cumXpForLevel(level + 1) <= xp) level++;
  const floor = cumXpForLevel(level);
  const nextLevelAt = cumXpForLevel(level + 1);
  const levelSpan = nextLevelAt - floor;
  const intoLevel = xp - floor;
  return {
    level,
    title: LEVEL_TITLES[Math.min(level - 1, LEVEL_TITLES.length - 1)],
    intoLevel,
    levelSpan,
    pct: levelSpan > 0 ? intoLevel / levelSpan : 0,
    nextLevelAt,
  };
}

// ── Badges ─────────────────────────────────────────────────────────────────
// Each unlocks once, with an animation. Definitions are pure data; the
// unlock test is pure so the Wrap and the profile strip agree on what's lit.

export type BadgeId = "first_blood" | "hat_trick" | "sniper" | "boss_slayer" | "streak" | "van_mvp";

export type BadgeDef = {
  id: BadgeId;
  label: string;
  icon: string;
  blurb: string;
};

export const BADGES: readonly BadgeDef[] = [
  { id: "first_blood", label: "First Blood", icon: "🩸", blurb: "First sale of the week" },
  { id: "hat_trick", label: "Hat Trick", icon: "🎩", blurb: "3 sits in a day" },
  { id: "sniper", label: "Sniper", icon: "🎯", blurb: "50%+ sit rate over 20+ leads" },
  { id: "boss_slayer", label: "Boss Slayer", icon: "⚔️", blurb: "Clear a $100K boss" },
  { id: "streak", label: "On Fire", icon: "🔥", blurb: "Consecutive days with a sit" },
  { id: "van_mvp", label: "Van MVP", icon: "🚐", blurb: "Top your van this week" },
];

/** Threshold for the Hat Trick badge (sits in a single day). */
export const HAT_TRICK_SITS = 3;
/** Sniper badge needs this many leads before the 50% sit rate counts. */
export const SNIPER_MIN_LEADS = 20;
export const SNIPER_SIT_RATE = 0.5;

export type BadgeStats = {
  /** Sales credited this week (First Blood). */
  weekSales: number;
  /** Most sits in any single day this period (Hat Trick). */
  bestDaySits: number;
  /** Sit rate over the window, 0..1 (Sniper). */
  sitRate: number;
  /** Lead count the sit rate is measured over (Sniper gate). */
  sitRateLeads: number;
  /** $100K bosses cleared this period (Boss Slayer). */
  bossesDefeated: number;
  /** Current consecutive-days-with-a-sit streak (On Fire). */
  sitStreakDays: number;
  /** True if top of their van this week (Van MVP). */
  vanMvp: boolean;
};

/**
 * Most sits on any SINGLE day within [start, end] (inclusive, ISO YYYY-MM-DD) —
 * the Hat Trick input. Pure: the data layer supplies per-day sit counts (one
 * entry per office row is fine; same-day entries are summed). This is what lets
 * Hat Trick honour the selected range instead of firing on today only — a Week
 * or Month wrap lights it if the grinder stacked 3+ sits on any day in range.
 * ISO date strings compare lexicographically = chronologically, so the window
 * test needs no Date parsing.
 */
export function bestDaySits(
  daySits: readonly { date: string; sits: number }[],
  start: string,
  end: string,
): number {
  const byDay = new Map<string, number>();
  for (const r of daySits) {
    if (r.date < start || r.date > end) continue;
    byDay.set(r.date, (byDay.get(r.date) ?? 0) + Math.max(0, r.sits));
  }
  let best = 0;
  for (const v of byDay.values()) if (v > best) best = v;
  return best;
}

/** Which badges a stats snapshot has earned. Pure, order matches BADGES. */
export function evaluateBadges(s: BadgeStats): Set<BadgeId> {
  const out = new Set<BadgeId>();
  if (s.weekSales >= 1) out.add("first_blood");
  if (s.bestDaySits >= HAT_TRICK_SITS) out.add("hat_trick");
  if (s.sitRateLeads >= SNIPER_MIN_LEADS && s.sitRate >= SNIPER_SIT_RATE) out.add("sniper");
  if (s.bossesDefeated >= 1) out.add("boss_slayer");
  if (s.sitStreakDays >= 2) out.add("streak");
  if (s.vanMvp) out.add("van_mvp");
  return out;
}

// ── Sit rate (the "lead quality" headline) ──────────────────────────────────
// Owner decision 2026-10-05 "show both": the pay engine's Canvass-Stats sit
// keeps driving pay & points, while the HEADLINE sit rate is the closer-outcome
// funnel — of the leads you SET, how many reached a sit (PM, PM w/ Reset or
// Sold) — over total leads. This is just the ratio; the data layer supplies
// the matched counts.

export type SitRate = {
  sits: number;
  leads: number;
  /** sits ÷ leads, 0..1, or null when there are no leads yet. */
  rate: number | null;
  /** Fighting-game letter grade for the rate. */
  grade: "S" | "A" | "B" | "C" | "D" | null;
};

/** S ≥ 55%, A ≥ 45%, B ≥ 35%, C ≥ 25%, else D. Null until the first lead. */
export function sitRate(sits: number, leads: number): SitRate {
  if (leads <= 0) return { sits, leads, rate: null, grade: null };
  const rate = sits / leads;
  const grade =
    rate >= 0.55 ? "S" : rate >= 0.45 ? "A" : rate >= 0.35 ? "B" : rate >= 0.25 ? "C" : "D";
  return { sits, leads, rate, grade };
}
