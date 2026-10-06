// Van Wars scoring — the pure shaping for the weekly street race. A van's WAR
// SCORE is points per active knocker by default (config-switchable to a plain
// total), so a small crew can out-run a big one. Points mirror the pay engine's
// weeklyPoints (a pitch-miss sit = 1, a sale = 2); the owner can retune the
// per-sit / per-sale weights and the per-head/total mode in the vanwars_config
// table without a deploy. Ties break on sit rate. Pure + unit-tested
// (scripts/verify-vanwars.ts, `npm run verify:vanwars`).

import { sitRate, type SitRate } from "@/lib/canvasserPay";

export type VanWarsMode = "per_head" | "total";

export type VanWarsConfig = {
  mode: VanWarsMode;
  /** Points for a pitch-miss sit (default 1). */
  sitWeight: number;
  /** Points a sale is worth in total, inclusive of its sit (default 2). */
  saleWeight: number;
};

export const DEFAULT_VANWARS_CONFIG: VanWarsConfig = {
  mode: "per_head",
  sitWeight: 1,
  saleWeight: 2,
};

/**
 * War points for one knocker from their range points + sales. `pts` is
 * weeklyPoints = demos_sits + sales (demos_sits already counts the sold sit, so
 * a sale is sit+sale = 2), and `sal` is the sale count. Therefore non-sale sits
 * = pts − 2·sal, and war = sitWeight·(pts − 2·sal) + saleWeight·sal. With the
 * (1, 2) defaults this is exactly `pts`, so "same as now" holds until the owner
 * retunes the weights. pts − 2·sal can never go negative (every sale is a sit,
 * so demos_sits ≥ sales ⇒ pts ≥ 2·sal).
 */
export function warPointsFor(
  pts: number,
  sal: number,
  cfg: VanWarsConfig = DEFAULT_VANWARS_CONFIG,
): number {
  const nonSaleSits = Math.max(0, pts - 2 * sal);
  return cfg.sitWeight * nonSaleSits + cfg.saleWeight * sal;
}

/** Coerce a raw vanwars_config row (any/missing shape) to a safe config. */
export function resolveVanWarsConfig(row: unknown): VanWarsConfig {
  const r = (row ?? {}) as Record<string, unknown>;
  const mode: VanWarsMode = r.mode === "total" ? "total" : "per_head";
  const sw = Number(r.sit_weight);
  const lw = Number(r.sale_weight);
  return {
    mode,
    sitWeight: Number.isFinite(sw) && sw > 0 ? sw : 1,
    saleWeight: Number.isFinite(lw) && lw > 0 ? lw : 2,
  };
}

/** One knocker's contribution to their van's war score. */
export type VanWarRowInput = {
  teamName: string | null;
  teamColor: string | null;
  pts: number;
  sal: number;
  vol: number;
  /** Funnel sits (closer-outcome) and the leads they were set over. */
  sitSits: number;
  sitLeads: number;
};

export type VanWarStanding = {
  name: string;
  color: string;
  /** The ranking score: per-head (default) or total war points. */
  war: number;
  /** Total war points across the crew (always the sum, for display). */
  warTotal: number;
  /** Active knockers on the crew in range (the per-head divisor). */
  knockers: number;
  /** Total weekly points. */
  pts: number;
  /** Credited sale volume, net of cancels. */
  vol: number;
  /** Crew funnel sit rate + grade (the tiebreak + the badge). */
  sit: SitRate;
};

/**
 * Roll knocker rows up into ranked crew standings for the week's race. War
 * score per the config mode; ties broken by sit rate, then total points, then
 * dollars. Every row that reaches here is an active knocker (the ladder only
 * emits rows with production), so `knockers` is the row count per crew.
 */
export function buildVanWarStandings(
  rows: readonly VanWarRowInput[],
  cfg: VanWarsConfig = DEFAULT_VANWARS_CONFIG,
): VanWarStanding[] {
  type Acc = {
    name: string;
    color: string;
    warTotal: number;
    knockers: number;
    pts: number;
    vol: number;
    sits: number;
    leads: number;
  };
  const map = new Map<string, Acc>();
  for (const r of rows) {
    const key = r.teamName ?? "Unassigned";
    const v: Acc = map.get(key) ?? {
      name: key,
      color: r.teamColor ?? "#8a8f99",
      warTotal: 0,
      knockers: 0,
      pts: 0,
      vol: 0,
      sits: 0,
      leads: 0,
    };
    v.warTotal += warPointsFor(r.pts, r.sal, cfg);
    v.knockers += 1;
    v.pts += r.pts;
    v.vol += r.vol;
    v.sits += r.sitSits;
    v.leads += r.sitLeads;
    map.set(key, v);
  }
  return [...map.values()]
    .map((v) => ({
      name: v.name,
      color: v.color,
      war: cfg.mode === "per_head" ? (v.knockers > 0 ? v.warTotal / v.knockers : 0) : v.warTotal,
      warTotal: v.warTotal,
      knockers: v.knockers,
      pts: v.pts,
      vol: v.vol,
      sit: sitRate(v.sits, v.leads),
    }))
    .sort(
      (a, b) =>
        b.war - a.war || (b.sit.rate ?? 0) - (a.sit.rate ?? 0) || b.pts - a.pts || b.vol - a.vol,
    );
}
