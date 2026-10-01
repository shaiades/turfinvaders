// Capital math for God Mode v3 (owner directive 2026-10-01): the Path-to-
// $100M lever sensitivities, speed-of-cash stats, concentration risk, and
// the matched-span / completion-curve corrections. PURE — no imports — so
// scripts/verify-capital.ts can pin every formula. Every consumer must
// label the input windows (doors era 9/10+, block_cards Jul+, cancel $
// month-blurred); the math never invents what the data can't say.

const round0 = (n: number) => Math.round(n);
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── The $100M equation ───────────────────────────────────────────────────
// NetRevenue/yr = Doors/yr × leadPerDoor × sitRate × closeRate
//                 × grossTicket × (1 − cancelRate)
// Levers are evaluated ceteris paribus: they MULTIPLY, they never add.

export type LeverInputs = {
  annualGoal: number;
  doorsPerDay: number;
  workingDaysPerYear: number;
  /** Confirmed leads per door (pair-matched era rate). */
  leadPerDoor: number;
  /** Sits per confirmed lead. */
  sitRate: number;
  /** Sales per sit. */
  closeRate: number;
  /** Gross average ticket: (revenue + cancelAmt) / sold. */
  grossTicket: number;
  /** Cancelled share of gross book: cancelAmt / (revenue + cancelAmt). */
  cancelRate: number;
  /** MEDIAN van's confirmed leads per month (a new van is not your best). */
  medianVanLeadsPerMonth: number;
  /** Annualized counts from the live book (trailing window × 12/n). */
  annualSits: number;
  annualSold: number;
  annualGrossBook: number;
};

export type LeverRow = {
  key: "doors" | "close" | "ticket" | "cancel" | "van";
  /** +$/yr of net revenue for one unit of the lever (doors row: the gap). */
  dollars: number;
  /** Secondary figure the UI renders (doors/day needed, etc.). */
  figure: number;
};

export function leverSensitivities(i: LeverInputs): {
  modeledNetPerYear: number;
  rows: LeverRow[];
} {
  const perDoor = i.leadPerDoor * i.sitRate * i.closeRate * i.grossTicket * (1 - i.cancelRate);
  const modeledNetPerYear = i.doorsPerDay * i.workingDaysPerYear * perDoor;
  const doorsPerDayNeeded =
    perDoor > 0 ? i.annualGoal / (i.workingDaysPerYear * perDoor) : Infinity;
  const plusOnePtClose = i.annualSits * 0.01 * i.grossTicket * (1 - i.cancelRate);
  const ticketPlus1K = i.annualSold * 1000 * (1 - i.cancelRate);
  const cancelTo10 = i.cancelRate > 0.1 ? i.annualGrossBook * (i.cancelRate - 0.1) : 0;
  const plusOneVan =
    i.medianVanLeadsPerMonth * 12 * i.sitRate * i.closeRate * i.grossTicket * (1 - i.cancelRate);
  return {
    modeledNetPerYear: round0(modeledNetPerYear),
    rows: [
      {
        key: "doors",
        dollars: round0(i.annualGoal - modeledNetPerYear),
        figure: round2(doorsPerDayNeeded),
      },
      { key: "close", dollars: round0(plusOnePtClose), figure: round2((i.closeRate + 0.01) * 100) },
      { key: "ticket", dollars: round0(ticketPlus1K), figure: round0(i.grossTicket + 1000) },
      { key: "cancel", dollars: round0(cancelTo10), figure: 10 },
      { key: "van", dollars: round0(plusOneVan), figure: round2(i.medianVanLeadsPerMonth) },
    ],
  };
}

export const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// ── Speed of cash ────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
export const daysBetween = (fromISO: string, toISO: string): number =>
  Math.round((Date.parse(toISO) - Date.parse(fromISO)) / DAY_MS);

type SlipRow = {
  planned_amount: number;
  actual_amount: number;
  anticipated_date: string | null;
  collected_date: string | null;
  status?: string | null;
};

/** Median slip (collected − anticipated, days; negative = early) across
 *  settled rows carrying both dates. */
export function slipStats(rows: SlipRow[]): { medianDays: number | null; count: number } {
  const slips: number[] = [];
  for (const r of rows) {
    if (r.anticipated_date === null || r.collected_date === null) continue;
    const settled = r.planned_amount > 0 && r.actual_amount >= r.planned_amount;
    if (!settled) continue;
    slips.push(daysBetween(r.anticipated_date, r.collected_date));
  }
  return { medianDays: median(slips), count: slips.length };
}

export type AgingBuckets = { b0_30: number; b31_60: number; b61: number };

/** Uncollected remainder past its anticipated date, bucketed by days late. */
export function agingBuckets(rows: SlipRow[], todayISO: string): AgingBuckets {
  const out: AgingBuckets = { b0_30: 0, b31_60: 0, b61: 0 };
  for (const r of rows) {
    const remaining = Math.max(r.planned_amount - r.actual_amount, 0);
    if (remaining <= 0 || r.anticipated_date === null) continue;
    const late = daysBetween(r.anticipated_date, todayISO);
    if (late <= 0) continue;
    if (late <= 30) out.b0_30 = round2(out.b0_30 + remaining);
    else if (late <= 60) out.b31_60 = round2(out.b31_60 + remaining);
    else out.b61 = round2(out.b61 + remaining);
  }
  return out;
}

// ── Matched-span deltas (the MoM bug fix) ────────────────────────────────

/** Collected $ through the same day-of-month, so a mid-month MoM compares
 *  10 days against 10 days — never MTD against a full month. Rows with no
 *  collected_date count from day 1 (they're in the month's books). */
export function matchedSpanCollected(
  rows: Array<{ actual_amount: number; collected_date: string | null }>,
  monthStart: string,
  throughDayOfMonth: number,
): number {
  const last = new Date(
    Date.UTC(Number(monthStart.slice(0, 4)), Number(monthStart.slice(5, 7)) - 1, 1),
  );
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const cap = Math.min(throughDayOfMonth, last.getUTCDate());
  const cutoff = `${monthStart.slice(0, 8)}${String(cap).padStart(2, "0")}`;
  let sum = 0;
  for (const r of rows) {
    if (r.actual_amount <= 0) continue;
    if (r.collected_date === null || r.collected_date <= cutoff) sum += r.actual_amount;
  }
  return round2(sum);
}

// ── Completion-curve pace (collections are lumpy; straight-line whipsaws) ─

/** Median cumulative completion fraction by day-of-month across historical
 *  months: fraction[d] = share of the month's eventual total banked by day
 *  d+1. Months need a real total and ≥ 1 dated payment to teach. */
export function buildCompletionCurve(
  rows: Array<{ collection_month: string; actual_amount: number; collected_date: string | null }>,
): number[] | null {
  const byMonth = new Map<string, { total: number; byDay: Map<number, number> }>();
  for (const r of rows) {
    if (r.actual_amount <= 0) continue;
    const slot = byMonth.get(r.collection_month) ?? { total: 0, byDay: new Map() };
    slot.total += r.actual_amount;
    const day =
      r.collected_date !== null && r.collected_date.slice(0, 7) === r.collection_month.slice(0, 7)
        ? Number(r.collected_date.slice(8, 10))
        : 1; // undated / out-of-month money counts from day 1
    slot.byDay.set(day, (slot.byDay.get(day) ?? 0) + r.actual_amount);
    byMonth.set(r.collection_month, slot);
  }
  const fractionsPerDay: number[][] = Array.from({ length: 31 }, () => []);
  let taught = 0;
  for (const m of byMonth.values()) {
    if (m.total <= 0 || m.byDay.size === 0) continue;
    taught += 1;
    let cum = 0;
    for (let d = 1; d <= 31; d++) {
      cum += m.byDay.get(d) ?? 0;
      fractionsPerDay[d - 1].push(cum / m.total);
    }
  }
  if (taught < 6) return null; // not enough history to beat straight-line
  return fractionsPerDay.map((f) => median(f) ?? 0);
}

/** Project the month's total from collected-to-date and the typical
 *  completion fraction at this day; floors the fraction so day-1 noise
 *  can't project absurd totals. */
export function projectFromCurve(
  collectedToDate: number,
  dayOfMonth: number,
  curve: number[],
): number {
  const f = Math.max(curve[Math.min(Math.max(dayOfMonth, 1), 31) - 1] ?? 0, 0.05);
  return round2(collectedToDate / f);
}

// ── Concentration risk ───────────────────────────────────────────────────

const LENDERS = [
  "service finance",
  "cal-first",
  "cal first",
  "pace funding",
  "synchrony",
  "gaf",
  "momnt",
  "homerun",
  "renew",
] as const;
const CASH_LIKE = ["cash", "check", "wire transfer", "debit card", "credit card"] as const;

export type FinancingMix = {
  buckets: Array<{ label: string; amount: number; share: number }>;
  /** Largest single LENDER's share of collected (cash-like excluded). */
  topLenderShare: number;
  topLenderLabel: string | null;
};

/** Collected $ by payment channel. Comma-joined dropdowns bucket as
 *  "Mixed"; unknown labels pass through verbatim (never silently lumped). */
export function financingMix(
  rows: Array<{ actual_amount: number; payment_type: string | null }>,
): FinancingMix {
  const by = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    if (r.actual_amount <= 0) continue;
    const raw = (r.payment_type ?? "").trim().toLowerCase();
    const label =
      raw === ""
        ? "Unlabeled"
        : raw.includes(",")
          ? "Mixed"
          : (LENDERS.find((l) => l === raw) ??
            (CASH_LIKE.includes(raw as never) ? "Cash/Check/Card" : raw));
    const pretty =
      label === "Cash/Check/Card" || label === "Mixed" || label === "Unlabeled"
        ? label
        : label.replace(/\b\w/g, (c) => c.toUpperCase());
    by.set(pretty, (by.get(pretty) ?? 0) + r.actual_amount);
    total += r.actual_amount;
  }
  const buckets = [...by.entries()]
    .map(([label, amount]) => ({
      label,
      amount: round2(amount),
      share: total > 0 ? amount / total : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
  const lenderPretty = new Set(LENDERS.map((l) => l.replace(/\b\w/g, (c) => c.toUpperCase())));
  const topLender = buckets.find((b) => lenderPretty.has(b.label)) ?? null;
  return {
    buckets,
    topLenderShare: topLender?.share ?? 0,
    topLenderLabel: topLender?.label ?? null,
  };
}

/** Share of revenue held by the top-N names. Repless revenue stays in the
 *  denominator (conservative). */
export function topShare(
  entries: Array<{ name: string; amount: number }>,
  totalAmount: number,
  n: number,
): { share: number; names: string[] } {
  const sorted = [...entries].sort((a, b) => b.amount - a.amount).slice(0, n);
  const sum = sorted.reduce((s, e) => s + e.amount, 0);
  return {
    share: totalAmount > 0 ? sum / totalAmount : 0,
    names: sorted.map((e) => e.name),
  };
}
