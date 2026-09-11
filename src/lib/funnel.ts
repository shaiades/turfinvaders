// The ONE funnel engine for the canvasser page (owner decisions, 2026-07-29):
// goals are INCOME (commission dollars, ÷ avg commission per sale — never
// sale revenue); conversion rates come from personal history when it has
// enough volume, else the company-wide baseline (getFunnelBaseline server
// fn); workweeks are Mon–Sat everywhere; both back-solves subtract progress
// already made. Both horizons of the Plan tab's back-solve (PlanPanel on the
// Mission page) must compute from these helpers so their doors/day numbers
// can never disagree on rates again.

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

/** The ONE avg-commission fallback chain (owner, 2026-08-14): the canvasser's
 *  own number wins, else the company 60-day average, else the $200 floor so
 *  goal math can never divide by zero. */
export function resolveAvgCommission(
  profileAvg: number | null | undefined,
  companyAvg: number,
  floor: number,
): number {
  return Number(profileAvg ?? 0) || companyAvg || floor;
}

/** Expected commission dollars a single door knock is worth today — the
 *  forward funnel walked one door at a time. Null when the rates can't
 *  support the math; consumers show their empty state, never $0/knock. */
export function expectedValuePerDoor(
  rates: ConversionRates | null,
  avgCommissionPerSale: number,
): number | null {
  if (!rates || !ratesUsable(rates) || avgCommissionPerSale <= 0) return null;
  return avgCommissionPerSale * rates.closeRate * rates.sitRate * rates.leadDoorRate;
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
