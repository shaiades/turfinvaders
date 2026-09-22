// Sales-rep weekly VOLUME-goal engine (owner, 2026-09-22, superseding the
// 2026-09-17 sales-count goal). A rep sets a weekly volume target in dollars
// (official Sale-$, the same number the Kombat board ranks by) and the tab
// reverse-engineers it through the rep's own trailing-2-completed-weeks
// numbers: remaining $ ÷ avg deal size = sales needed ÷ close% = sits needed
// ÷ sit% = appts needed. Rates come from the trailing window on purpose —
// the old design used the current week's own rates, which are empty every
// Monday morning, exactly when the goal gets set.
//
// Separate from funnel.ts on purpose: that engine is door-based and
// income-based, built for canvassers. Never invents a number when the rates
// can't support the math (null contract, same as funnel.ts).
//
// Pure module: no imports, unit-tested by scripts/verify-rep-goals.ts.

export type RepRates = {
  /** Lead demos ÷ appts, from the trailing window. */
  sitPct: number;
  /** Sold ÷ demos, from the trailing window. */
  closePct: number;
  /** The rep's split volume per sale (revenue ÷ (sold + reloads)) — their
   *  observed $ per deal, slightly hot when office-appt upsale money rode
   *  along in revenue (accepted skew: it's their real board money either
   *  way, just not a per-contract price). */
  avgDealSize: number;
};

export type RepRatesSource = "self" | "company";

/** Structural so a RepStats row, KombatTotals, or a hand-summed baseline
 *  all fit. Exported for the props that carry one across components. */
export type RepRatesInput = {
  sold: number;
  reloads: number;
  revenue: number;
  sitPct: number | null;
  closePct: number | null;
} | null;
type RatesInput = RepRatesInput;

/** Rates from one trailing aggregate, or null when any leg can't support the
 *  math — a 0% close rate or $0 revenue would back-solve to Infinity. */
export function deriveRepRates(stats: RatesInput): RepRates | null {
  if (!stats) return null;
  const sales = stats.sold + stats.reloads;
  if (sales <= 0 || stats.revenue <= 0) return null;
  if (stats.sitPct === null || stats.sitPct <= 0) return null;
  if (stats.closePct === null || stats.closePct <= 0) return null;
  return {
    sitPct: stats.sitPct,
    closePct: stats.closePct,
    avgDealSize: stats.revenue / sales,
  };
}

/** The one fallback ladder (owner, 2026-09-22): the rep's own trailing
 *  numbers win; too thin → company-wide numbers over the same window,
 *  labeled as such; both thin → null and the UI says "not enough data" —
 *  never an invented rate. */
export function resolveRepRates(
  own: RatesInput,
  company: RatesInput,
): { rates: RepRates; source: RepRatesSource } | null {
  const self = deriveRepRates(own);
  if (self) return { rates: self, source: "self" };
  const baseline = deriveRepRates(company);
  if (baseline) return { rates: baseline, source: "company" };
  return null;
}

export type VolumeBackSolve = {
  salesNeeded: number;
  sitsNeeded: number;
  apptsNeeded: number;
};

/** Remaining volume $ → sales → sits → appts. Null when there's nothing left
 *  to solve (goal met is a UI branch) or no usable rates. */
export function backSolveVolumeGoal({
  remainingVolume,
  rates,
}: {
  remainingVolume: number;
  rates: RepRates | null;
}): VolumeBackSolve | null {
  if (rates === null || remainingVolume <= 0) return null;
  const salesNeeded = remainingVolume / rates.avgDealSize;
  const sitsNeeded = salesNeeded / rates.closePct;
  const apptsNeeded = sitsNeeded / rates.sitPct;
  return { salesNeeded, sitsNeeded, apptsNeeded };
}

// ── Projected take-home ──────────────────────────────────────────────────
// The Infinity Sale Playbook's published economics (Learn tab, section 01):
// commission ≈ 20% of profit, profit ≈ 40% of the sale ⇒ ≈8% of volume.
// This is a PROJECTION for motivation, the piggy-bank pattern — it is never
// a payroll figure, never the self-gen 35% rate, and every surface showing
// it must label it as playbook math.
export const PLAYBOOK_PROFIT_PCT = 0.4;
export const PLAYBOOK_COMMISSION_PCT = 0.2;

export function projectedPlaybookTakeHome(volume: number): number {
  return volume * PLAYBOOK_PROFIT_PCT * PLAYBOOK_COMMISSION_PCT;
}
