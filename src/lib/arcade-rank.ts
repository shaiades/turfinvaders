// Arcade ranking + bounty scoring — the pure pieces of the leaderboard
// (conversion audit 2026-10-15), split out so scripts/verify-arcade-today.ts
// can pin them. useCanvasserArcade sorts with the comparators;
// getDispatchProduction prices bounty bonuses with bestBountyMultiplier.

/** The fields the ladder comparators rank on (LadderRow is a superset). */
export type RankableRow = {
  /** Points over the range (sit = 1, sale = 2, + bounty bonus). */
  pts: number;
  /** Credited sale $ net of cancels. */
  vol: number;
  /** Board-outcome lead count (appointment-day axis). */
  lds: number;
  /** Leads SET in range (generation-day axis). */
  ld: number;
  drs: number;
  tlk: number;
};

/**
 * Today's order: leads set today → conversations → doors → points. Points
 * credit sits to the APPOINTMENT day (monday-live-dispatch blockDay), so a
 * points-ranked Today board showed everyone who set leads today at 0 — the
 * scoreboard lied. Leads set, talks and doors all land on today's log row.
 */
export const dayLadderCompare = (a: RankableRow, b: RankableRow): number =>
  b.ld - a.ld || b.tlk - a.tlk || b.drs - a.drs || b.pts - a.pts;

/** Week/Month order (unchanged): points → $ → leads → doors. */
export const rangeLadderCompare = (a: RankableRow, b: RankableRow): number =>
  b.pts - a.pts || b.vol - a.vol || b.lds - a.lds || b.drs - a.drs;

/** A live bounty window in epoch ms with its multiplier. */
export type BountyWindow = { startMs: number; endMs: number; mult: number };

/**
 * The multiplier a lead earns from the bounties live at its SET time
 * (created_at). Overlapping bounties never stack — the best single
 * multiplier wins; no live bounty (or a bogus one) means 1. The caller adds
 * (mult − 1) bonus points per confirmed lead — game points only, never pay.
 */
export function bestBountyMultiplier(setMs: number, windows: readonly BountyWindow[]): number {
  let best = 1;
  for (const w of windows) {
    if (setMs >= w.startMs && setMs < w.endMs && w.mult > best) best = w.mult;
  }
  return best;
}
