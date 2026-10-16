// "Next dollar" engine (conversion audit 2026-10-15, Phase 4 §2) — the ONE
// nearest real-money threshold the map chip points at, from the same pay
// constants calc_weekly_paycheck mirrors (src/lib/pay.ts). Pure + verified
// (scripts/verify-money.ts). Display only — nothing here writes or pays.
//
// The ladder is deterministic so a rep can predict the chip:
//   month volume within $10K of the next $100K step  → "$xK → $1,500"
//   week points < 3                                  → "N pts → $30/hr"
//   week points < 7                                  → "N pts → $35/hr"
//   week points < 10                                 → "N pts → $500 monster"
//   otherwise (sits ≥ 3 by then)                     → "1 sit → +$50/$75"
// Gold + shake when ONE unit away (1 pt, or inside the $10K volume window).
//
// Inputs must be PAY-TRUE: week points/sits from the Mon–Sun daily_logs sum
// (the HUD's axis), never LadderRow.pts (Mon–Sat + dojo bonus); month volume
// from calc_monthly_paycheck's sale_price_total.

import {
  HOURLY_MID,
  HOURLY_TOP,
  MONSTER_BONUS,
  MONSTER_THRESHOLD,
  POINTS_TIER_MID,
  POINTS_TIER_TOP,
  SIT_BONUS_THRESHOLD,
  VOLUME_BONUS_PER,
  VOLUME_BONUS_STEP,
  sitBonusPerForRank,
} from "@/lib/pay";

/** Show the volume chase only inside this window (also the push trigger). */
export const VOLUME_NEAR_WINDOW = 10_000;

export type MoneyTarget = {
  kind: "tier_mid" | "tier_top" | "monster" | "sit_bonus" | "volume";
  /** Big number on the chip: what's left ("2 PTS", "1 SIT", "$8K"). */
  needLabel: string;
  /** What it buys ("$30/HR", "+$50", "$1,500"). */
  prizeLabel: string;
  /** Ring fill 0..1 toward this threshold (from the previous one). */
  progress: number;
  /** One unit away → gold + shake. */
  oneAway: boolean;
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const fmtK = (n: number) => (n >= 1000 ? `$${Math.ceil(n / 1000)}K` : `$${Math.ceil(n)}`);

export function nextMoneyTarget(input: {
  /** Mon–Sun weekly points (sits + sales), the pay axis. */
  weekPts: number;
  /** Mon–Sun weekly sits (demos_sits). */
  weekSits: number;
  /** Month-to-date credited volume (sale_price_total), when known. */
  monthVolume: number | null;
  /** profiles.current_rank — null when pay lock is reverted. */
  rank: string | null;
}): MoneyTarget {
  const { weekPts, weekSits, monthVolume, rank } = input;

  // The $1,500 chase outranks everything once it's close — biggest money on
  // the board, and the "$8K → $1,500" moment the audit called out.
  if (monthVolume != null && monthVolume > 0) {
    const toNext = VOLUME_BONUS_STEP - (monthVolume % VOLUME_BONUS_STEP);
    if (toNext <= VOLUME_NEAR_WINDOW && toNext > 0) {
      return {
        kind: "volume",
        needLabel: fmtK(toNext),
        prizeLabel: `$${VOLUME_BONUS_PER.toLocaleString()}`,
        progress: clamp01((VOLUME_BONUS_STEP - toNext) / VOLUME_BONUS_STEP),
        oneAway: true,
      };
    }
  }

  if (weekPts < POINTS_TIER_MID) {
    const need = POINTS_TIER_MID - weekPts;
    return {
      kind: "tier_mid",
      needLabel: `${need} pt${need === 1 ? "" : "s"}`,
      prizeLabel: `$${HOURLY_MID}/hr`,
      progress: clamp01(weekPts / POINTS_TIER_MID),
      oneAway: need === 1,
    };
  }
  if (weekPts < POINTS_TIER_TOP) {
    const need = POINTS_TIER_TOP - weekPts;
    return {
      kind: "tier_top",
      needLabel: `${need} pt${need === 1 ? "" : "s"}`,
      prizeLabel: `$${HOURLY_TOP}/hr`,
      progress: clamp01((weekPts - POINTS_TIER_MID) / (POINTS_TIER_TOP - POINTS_TIER_MID)),
      oneAway: need === 1,
    };
  }
  if (weekPts < MONSTER_THRESHOLD) {
    const need = MONSTER_THRESHOLD - weekPts;
    return {
      kind: "monster",
      needLabel: `${need} pt${need === 1 ? "" : "s"}`,
      prizeLabel: `$${MONSTER_BONUS} monster`,
      progress: clamp01((weekPts - POINTS_TIER_TOP) / (MONSTER_THRESHOLD - POINTS_TIER_TOP)),
      oneAway: need === 1,
    };
  }

  // Past the monster, every sit past the weekly threshold is cash in hand.
  const per = sitBonusPerForRank(rank ?? undefined);
  if (weekSits >= SIT_BONUS_THRESHOLD) {
    return {
      kind: "sit_bonus",
      needLabel: "1 sit",
      prizeLabel: `+$${per}`,
      progress: 0.9, // always within one action — the ring reads "almost"
      oneAway: true,
    };
  }
  const sitsNeeded = SIT_BONUS_THRESHOLD + 1 - weekSits;
  return {
    kind: "sit_bonus",
    needLabel: `${sitsNeeded} sit${sitsNeeded === 1 ? "" : "s"}`,
    prizeLabel: `+$${per}`,
    progress: clamp01(weekSits / (SIT_BONUS_THRESHOLD + 1)),
    oneAway: sitsNeeded === 1,
  };
}
