// Arcade Score v2 — the PURE half of the canvasser points engine (engagement
// audit 2026-11-03, Tier 2; kombat-month.ts is the pattern). The SQL triggers
// in 20261103130000_canvasser_arcade.sql grant every point server-side; this
// module only SHAPES ledger rows and rules for display, so the Vitest suite
// can pin the math the HUD, ladder and admin all share. Rules live in the
// arcade_rules jsonb singleton merged over DEFAULT_ARCADE_RULES — a missing
// key never zeroes a weight, and the SQL defaults mirror these numbers
// exactly (arcade_rule_num's fallbacks). GAME ONLY — pay never reads any of
// this.

import { addDaysISO, dateFromISO, laTodayISO } from "@/lib/dates";
import {
  daysLeftInRange,
  paceScale,
  rangeRound,
  rangeWorkdays,
  type RangeRound,
  type RangeWorkdays,
} from "@/lib/contest-core";

// ── Rules ────────────────────────────────────────────────────────────────────

export type ArcadeFinaleTier = {
  key: string;
  label: string;
  /** Finale points required to hold this belt. */
  points: number;
  /** Cash prize (owner spiff — never payroll). */
  cash: number;
};

export type ArcadeRules = {
  pts: {
    door: number;
    talk: number;
    lead_set: number;
    lead_confirmed: number;
    sit: number;
    sale: number;
  };
  crit: { chance: number; mult: number; daily_cap: number };
  combo: { window_min: number; cap: number };
  super: { daily_target: number; bonus: number };
  streak: { daily_bonus: number; min_pts: number };
  finale: {
    /** ISO dates; null start/end = no finale configured. */
    start: string | null;
    end: string | null;
    label: string;
    tiers: ArcadeFinaleTier[];
    /** Multipliers applied to pts.* during the finale window (display only —
     *  the SQL triggers score base weights; finale standings re-weight in
     *  code so October history can be dry-run before announcing). */
    weights: { sit: number; lead_confirmed: number };
    budget_cap: number;
  };
};

/** Code defaults — the SQL triggers' fallback numbers MUST match these. */
export const DEFAULT_ARCADE_RULES: ArcadeRules = {
  pts: { door: 0, talk: 1, lead_set: 5, lead_confirmed: 10, sit: 25, sale: 50 },
  crit: { chance: 0.08, mult: 5, daily_cap: 4 },
  combo: { window_min: 20, cap: 3 },
  super: { daily_target: 40, bonus: 15 },
  streak: { daily_bonus: 5, min_pts: 10 },
  finale: {
    start: null,
    end: null,
    label: "FINAL ROUND",
    tiers: [
      { key: "white", label: "White Belt", points: 300, cash: 100 },
      { key: "blue", label: "Blue Belt", points: 600, cash: 250 },
      { key: "red", label: "Red Belt", points: 1000, cash: 500 },
      { key: "black", label: "Black Belt", points: 1500, cash: 1000 },
    ],
    weights: { sit: 1.6, lead_confirmed: 1.25 },
    budget_cap: 10_000,
  },
};

/** Stored arcade_rules.rules (jsonb) over the code defaults — same semantics
 *  as mergeKombatRules: objects merge key-wise, arrays (the tier list)
 *  replace whole, and a stored null falls back to the default. */
export function mergeArcadeRules(stored: unknown): ArcadeRules {
  const merge = (base: unknown, over: unknown): unknown => {
    if (over === undefined || over === null) return base;
    if (
      typeof base !== "object" ||
      base === null ||
      Array.isArray(base) ||
      typeof over !== "object" ||
      Array.isArray(over)
    ) {
      return over;
    }
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
      out[k] = merge((base as Record<string, unknown>)[k], v);
    }
    return out;
  };
  if (typeof stored !== "object" || stored === null) return DEFAULT_ARCADE_RULES;
  return merge(DEFAULT_ARCADE_RULES, stored) as ArcadeRules;
}

// ── Ledger shapes ────────────────────────────────────────────────────────────

export type ArcadeCategory =
  | "talk"
  | "lead_set"
  | "lead_confirmed"
  | "sit"
  | "sale"
  | "super"
  | "finale";

export type ArcadeLedgerRow = {
  canvasser_id: string;
  day: string;
  category: string;
  points: number | null;
  meta?: Record<string, unknown> | null;
};

export type ArcadeTotals = {
  /** Sum of all points per canvasser. */
  byCanvasser: Map<string, number>;
  /** Per-canvasser per-category sums. */
  byCategory: Map<string, Map<string, number>>;
};

/** Totals are ALWAYS computed from ledger rows, never stored (Kombat rule). */
export function totalsFromLedger(rows: readonly ArcadeLedgerRow[]): ArcadeTotals {
  const byCanvasser = new Map<string, number>();
  const byCategory = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const pts = Number(r.points ?? 0);
    if (!r.canvasser_id || !Number.isFinite(pts)) continue;
    byCanvasser.set(r.canvasser_id, (byCanvasser.get(r.canvasser_id) ?? 0) + pts);
    let cats = byCategory.get(r.canvasser_id);
    if (!cats) byCategory.set(r.canvasser_id, (cats = new Map()));
    cats.set(r.category, (cats.get(r.category) ?? 0) + pts);
  }
  return { byCanvasser, byCategory };
}

// ── Super meter ──────────────────────────────────────────────────────────────

export type SuperMeterState = {
  earned: number;
  target: number;
  /** 0..1 toward the target (clamped). */
  pct: number;
  /** Points still needed; 0 once unleashed. */
  remaining: number;
  unleashed: boolean;
  bonus: number;
};

/** The HUD meter fills toward super.daily_target with TODAY's ledger sum —
 *  the same number the SQL arcade_award crossing-check uses. */
export function superMeterState(todayPoints: number, rules: ArcadeRules): SuperMeterState {
  const target = Math.max(1, rules.super.daily_target);
  const earned = Math.max(0, todayPoints);
  return {
    earned,
    target,
    pct: Math.min(1, earned / target),
    remaining: Math.max(0, target - earned),
    unleashed: earned >= target,
    bonus: rules.super.bonus,
  };
}

// ── Combo ────────────────────────────────────────────────────────────────────

export type ComboDisplay = {
  /** Live chain length (0 when expired or not started today). */
  count: number;
  /** ms until the chain dies; 0 when already dead. */
  msLeft: number;
  alive: boolean;
  /** Bonus pts the NEXT conversation would add on top of pts.talk. */
  nextBonus: number;
};

/** Shapes canvasser_combo_state for the drain-timer bar. The server is the
 *  truth; this only projects expiry so the bar can tick between polls. */
export function comboDisplay(
  state: { day: string; count: number; last_at: string } | null | undefined,
  rules: ArcadeRules,
  nowMs: number = Date.now(),
  todayISO: string = laTodayISO(),
): ComboDisplay {
  const windowMs = rules.combo.window_min * 60_000;
  if (!state || state.day !== todayISO || state.count <= 0) {
    return { count: 0, msLeft: 0, alive: false, nextBonus: 0 };
  }
  const lastMs = Date.parse(state.last_at);
  const msLeft = Number.isFinite(lastMs) ? Math.max(0, lastMs + windowMs - nowMs) : 0;
  const alive = msLeft > 0;
  const count = alive ? state.count : 0;
  return {
    count,
    msLeft,
    alive,
    nextBonus: Math.min(Math.max(count + 1 - 1, 0), rules.combo.cap),
  };
}

// ── Daily streak (Mon–Sat scoring days in a row) ─────────────────────────────

/** Sunday never breaks a streak (nobody knocks); any other day must have at
 *  least streak.min_pts of ledger points to keep the chain alive. */
export function dailyStreak(
  rows: readonly ArcadeLedgerRow[],
  rules: ArcadeRules,
  todayISO: string = laTodayISO(),
): { days: number; aliveToday: boolean } {
  const perDay = new Map<string, number>();
  for (const r of rows) {
    const pts = Number(r.points ?? 0);
    if (!Number.isFinite(pts)) continue;
    perDay.set(r.day, (perDay.get(r.day) ?? 0) + pts);
  }
  const min = Math.max(1, rules.streak.min_pts);
  const scored = (iso: string) => (perDay.get(iso) ?? 0) >= min;
  const isWorkday = (iso: string) => dateFromISO(iso).getDay() !== 0;
  const prevWorkday = (iso: string): string => {
    let d = addDaysISO(iso, -1);
    while (!isWorkday(d)) d = addDaysISO(d, -1);
    return d;
  };
  const aliveToday = scored(todayISO);
  let cursor = aliveToday ? todayISO : prevWorkday(todayISO);
  let days = 0;
  while (scored(cursor)) {
    days += 1;
    cursor = prevWorkday(cursor);
  }
  return { days, aliveToday };
}

// ── Finale (Tier 3 reads these; harmless before it ships) ────────────────────

export function finaleActive(rules: ArcadeRules, todayISO: string = laTodayISO()): boolean {
  const f = rules.finale;
  return !!f.start && !!f.end && todayISO >= f.start && todayISO <= f.end;
}

/** Finale standings re-weight quality categories in code (the ledger keeps
 *  base weights) so rule changes re-score history consistently. */
export function finalePoints(
  byCategory: ReadonlyMap<string, number> | undefined,
  rules: ArcadeRules,
): number {
  if (!byCategory) return 0;
  let total = 0;
  for (const [cat, pts] of byCategory) {
    const w =
      cat === "sit"
        ? rules.finale.weights.sit
        : cat === "lead_confirmed"
          ? rules.finale.weights.lead_confirmed
          : 1;
    total += pts * w;
  }
  return total;
}

/** The belt a finale total holds (highest tier whose points are met). */
export function finaleTierFor(
  points: number,
  rules: ArcadeRules,
): ArcadeFinaleTier | null {
  let held: ArcadeFinaleTier | null = null;
  for (const t of [...rules.finale.tiers].sort((a, b) => a.points - b.points)) {
    if (points >= t.points) held = t;
  }
  return held;
}

/** FINISH HIM: inside this many points of the next belt, the UI goes loud. */
export const FINALE_FINISH_WINDOW = 25;

export function finaleFinishHim(
  points: number,
  rules: ArcadeRules,
): { next: ArcadeFinaleTier; toGo: number } | null {
  const sorted = [...rules.finale.tiers].sort((a, b) => a.points - b.points);
  for (const t of sorted) {
    if (points < t.points) {
      const toGo = t.points - points;
      return toGo <= FINALE_FINISH_WINDOW ? { next: t, toGo } : null;
    }
  }
  return null;
}

/** The next belt above `points` (any distance — FINISH HIM is the loud
 *  last-25 version), with how far to go. Null at Black Belt. */
export function finaleNextTier(
  points: number,
  rules: ArcadeRules,
): { next: ArcadeFinaleTier; toGo: number } | null {
  const sorted = [...rules.finale.tiers].sort((a, b) => a.points - b.points);
  for (const t of sorted) {
    if (points < t.points) return { next: t, toGo: t.points - points };
  }
  return null;
}

export type FinalePace = {
  workdays: RangeWorkdays;
  daysLeft: number;
  /** Straight-line finale-end projection off the elapsed-workday run rate. */
  projected: number;
  projectedTier: ArcadeFinaleTier | null;
  /** Finale pts per remaining workday to land the next belt (0 = none left
   *  or already Black). */
  perDayToNext: number;
  round: RangeRound | null;
};

/** The me-vs-me finale math (contest-core primitives over the finale
 *  window). Null when no finale window is configured. */
export function finalePace(
  points: number,
  rules: ArcadeRules,
  todayISO: string = laTodayISO(),
): FinalePace | null {
  const f = rules.finale;
  if (!f.start || !f.end) return null;
  const workdays = rangeWorkdays(f.start, f.end, todayISO);
  const projected = points * paceScale(workdays);
  const nxt = finaleNextTier(points, rules);
  return {
    workdays,
    daysLeft: daysLeftInRange(f.start, f.end, todayISO),
    projected,
    projectedTier: finaleTierFor(projected, rules),
    perDayToNext: nxt && workdays.remaining > 0 ? nxt.toGo / workdays.remaining : 0,
    round: rangeRound(f.start, f.end, todayISO),
  };
}
