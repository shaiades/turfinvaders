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

/** The day the result-counts-as-knock trigger went live (migration
 *  20260910230000). doors_knocked is trustworthy only from here — the 60-day
 *  company window holds ~99 doors total and ALL of them are from this era,
 *  so any rate that divides by doors must use this window or it lies. */
export const DOORS_TRACKED_SINCE = "2026-09-10";

/** The funnel's stages live in different windows on purpose: confirms come
 *  from daily_metrics (the office pipeline — daily_logs.confirmed_leads has
 *  never been written), sits/sales from daily_logs, and the door pair only
 *  from the pin era. Each rate divides quantities from the SAME window. */
export type SplitFunnelInputs = {
  /** Pin-era pair (since DOORS_TRACKED_SINCE): doors + confirms. */
  eraDoors: number;
  eraConfirmed: number;
  /** Full 60-day pipeline counts. */
  confirmed: number;
  sits: number;
  sales: number;
};

export const EMPTY_SPLIT: SplitFunnelInputs = {
  eraDoors: 0,
  eraConfirmed: 0,
  confirmed: 0,
  sits: 0,
  sales: 0,
};

export function deriveSplitRates(i: SplitFunnelInputs): ConversionRates {
  return {
    closeRate: i.sits > 0 ? i.sales / i.sits : 0,
    sitRate: i.confirmed > 0 ? i.sits / i.confirmed : 0,
    leadDoorRate: i.eraDoors > 0 ? i.eraConfirmed / i.eraDoors : 0,
  };
}

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
