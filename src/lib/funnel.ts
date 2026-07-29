// The ONE funnel engine for the canvasser page (owner decisions, 2026-07-29):
// goals are INCOME (commission dollars, ÷ avg commission per sale — never
// sale revenue); conversion rates come from personal history when it has
// enough volume, else the company-wide baseline (getFunnelBaseline server
// fn); workweeks are Mon–Sat everywhere; both back-solves subtract progress
// already made. CanvasserPersonalDashboard's monthly Mission and
// WeeklyPlaybook's weekly plan must both compute from these helpers so their
// doors/day numbers can never disagree on rates again.

export type FunnelAggregate = {
  doors: number;
  confirmed: number;
  sits: number;
  sales: number;
};

export type ConversionRates = {
  /** sales per sit */
  closeRate: number;
  /** sits per confirmed lead */
  sitRate: number;
  /** confirmed leads per door */
  leadDoorRate: number;
};

export const EMPTY_AGGREGATE: FunnelAggregate = { doors: 0, confirmed: 0, sits: 0, sales: 0 };

/** Personal history qualifies on volume, not tenure. */
export const PERSONAL_MIN_DOORS = 200;
export const PERSONAL_MIN_SITS = 5;

export function personalRatesQualify(a: FunnelAggregate): boolean {
  return a.doors >= PERSONAL_MIN_DOORS && a.sits >= PERSONAL_MIN_SITS;
}

/** Conversion rates from an aggregate; zero denominators yield 0 (a 0 rate
 *  makes backSolveFunnel return null — the shared "insufficient data" state). */
export function deriveRates(a: FunnelAggregate): ConversionRates {
  return {
    closeRate: a.sits > 0 ? a.sales / a.sits : 0,
    sitRate: a.confirmed > 0 ? a.sits / a.confirmed : 0,
    leadDoorRate: a.doors > 0 ? a.confirmed / a.doors : 0,
  };
}

export function ratesUsable(r: ConversionRates): boolean {
  return r.closeRate > 0 && r.sitRate > 0 && r.leadDoorRate > 0;
}

/**
 * The commission the funnel must still produce (owner, 2026-07-29: the goal
 * is TOTAL take-home — commission + hourly base + bonuses). Subtract what
 * the pay engine says is already earned and the projected future base pay
 * for the remaining Mon–Sat workdays; the funnel covers only what's left.
 */
export function commissionGap({
  goal,
  earned,
  futureBase,
}: {
  goal: number;
  earned: number;
  futureBase: number;
}): { gap: number; goalMet: boolean } {
  const gap = Math.max(0, goal - earned - futureBase);
  return { gap, goalMet: goal > 0 && gap === 0 };
}

export type FunnelBackSolve = {
  requiredSales: number;
  requiredSits: number;
  requiredLeads: number;
  requiredDoors: number;
};

/** Income goal → sales → sits → leads → doors. Returns null when any input
 *  can't support the math — both consumers render their explanatory empty
 *  state instead of inventing numbers. */
export function backSolveFunnel({
  incomeGoal,
  avgCommissionPerSale,
  rates,
}: {
  incomeGoal: number;
  avgCommissionPerSale: number;
  rates: ConversionRates;
}): FunnelBackSolve | null {
  if (incomeGoal <= 0 || avgCommissionPerSale <= 0 || !ratesUsable(rates)) return null;
  const requiredSales = incomeGoal / avgCommissionPerSale;
  const requiredSits = requiredSales / rates.closeRate;
  const requiredLeads = requiredSits / rates.sitRate;
  const requiredDoors = requiredLeads / rates.leadDoorRate;
  return { requiredSales, requiredSits, requiredLeads, requiredDoors };
}
