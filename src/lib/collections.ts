// Collections-board rules (owner directive 2026-09-30, God Mode page):
// pure helpers for mirroring the monthly "<Month> Collections <YYYY>" Monday
// boards into public.report_collections and aggregating anticipated vs
// collected money. Pure constants-only imports — no supabase, no Monday —
// so scripts/verify-collections.ts can exercise every rule.
//
// Money doctrine (same as report_sales): a blank amount cell is $0, never
// guessed. Collected $ trusts the Actual Amount column, never the Status
// label — Status is a hand-maintained workflow lane (Run Card → Collected →
// Processed → Funded) and "Partial Collected" rows carry real dollars that
// must count. Status still drives badges and the overdue rule.

import { OFFICE_LOCATIONS } from "@/lib/offices";

/** One public.report_collections row (also the sync's upsert payload). */
export type ReportCollectionRow = {
  monday_item_id: string;
  board_id: string;
  board_name: string;
  collection_month: string;
  group_title: string | null;
  office: string | null;
  customer_name: string | null;
  planned_amount: number;
  actual_amount: number;
  anticipated_date: string | null;
  collected_date: string | null;
  status: string | null;
  milestone: string | null;
  payment_type: string | null;
  in_bank: string | null;
  date_deposited: string | null;
  notes: string | null;
};

/** Column ids verified live on board 18419836536 ("September Collections
 *  2026", 2026-09-30). The monthly boards are duplicated from each other, so
 *  ids persist; the title fallback covers older boards whose ids drifted.
 *  Read by ID FIRST — a deliberate deviation from the title-only Sales-Report
 *  reader: the "Anticipated"/"Collected" title pair sits on ids `date_1`/
 *  `date`, one hand-rename away from silently swapping date semantics.
 *  EXCLUDED by design: mirror4 "Total Amount" (mirror column — unreliable via
 *  the items API) and link_to_production (unused by the money view). */
export const COLLECTIONS_COLUMNS = {
  planned: { id: "numbers", title: "planned amount" },
  actual: { id: "numeric", title: "actual amount" },
  anticipated: { id: "date_1", title: "anticipated" },
  collected: { id: "date", title: "collected" },
  status: { id: "status2", title: "status" },
  milestone: { id: "status4", title: "milestone" },
  office: { id: "color_mm32n26w", title: "office" },
  paymentType: { id: "dropdown", title: "payment type" },
  inBank: { id: "color_mkzz6rz", title: "in bank" },
  dateDeposited: { id: "date_mkzzgn8m", title: "date deposited" },
  notes: { id: "long_text", title: "notes" },
} as const;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Strict on purpose: "Subitems of September Collections 2026" (Monday's
// auto-created shadow board) fails the ^ anchor; "Early 2026 collections"
// fails the month alternation. Both land in the sync's `skipped` list with a
// reason instead of guessing a bucket.
const COLLECTIONS_BOARD_RE = new RegExp(
  `^(${MONTH_NAMES.join("|")})\\s+Collections\\s+(20\\d{2})$`,
  "i",
);

/** "September Collections 2026" → "2026-09-01"; null when the name doesn't
 *  parse (never guess a month bucket). */
export function parseCollectionsBoardName(name: string): { collectionMonthISO: string } | null {
  const m = String(name ?? "")
    .trim()
    .match(COLLECTIONS_BOARD_RE);
  if (!m) return null;
  const idx = MONTH_NAMES.findIndex((n) => n.toLowerCase() === m[1].toLowerCase());
  if (idx < 0) return null;
  return { collectionMonthISO: `${m[2]}-${String(idx + 1).padStart(2, "0")}-01` };
}

/** Parse Monday money text ("$1,234.56") → number, else null. Same rules as
 *  the block-cards reader (bounded, 2dp). */
export function parseMoney(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const stripped = typeof v === "number" ? String(v) : String(v).replace(/[^0-9.-]/g, "");
  if (!/[0-9]/.test(stripped)) return null; // pure text ("call office") is no amount
  const n = Number(stripped);
  if (!Number.isFinite(n) || n < 0 || n >= 1e10) return null;
  return Math.round(n * 100) / 100;
}

/** Monday date cell text ("2026-09-04", sometimes with a time suffix) →
 *  "YYYY-MM-DD", else null. */
export function parseDateText(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
}

type ColumnCell = {
  id: string;
  text: string | null;
  column?: { title?: string | null; id?: string | null } | null;
};

/** Cell text by exact column id first, trimmed-lowercase title fallback;
 *  empty → null. */
export function colTextByIdOrTitle(
  cols: ColumnCell[],
  spec: { id: string; title: string },
): string | null {
  const byId = cols.find((c) => c.id === spec.id);
  const byTitle =
    byId ?? cols.find((c) => (c.column?.title || "").trim().toLowerCase() === spec.title);
  const t = (byTitle?.text || "").trim();
  return t === "" ? null : t;
}

/** Monday Collections item → report_collections row. */
export function buildCollectionRow(
  item: {
    id: unknown;
    name?: unknown;
    group?: { title?: unknown } | null;
    column_values?: ColumnCell[] | null;
  },
  boardId: string,
  boardName: string,
  collectionMonthISO: string,
): ReportCollectionRow {
  const cols = item.column_values ?? [];
  const text = (spec: { id: string; title: string }) => colTextByIdOrTitle(cols, spec);
  const name = item.name == null ? "" : String(item.name).trim();
  return {
    monday_item_id: String(item.id),
    board_id: boardId,
    board_name: boardName,
    collection_month: collectionMonthISO,
    group_title: item.group?.title == null ? null : String(item.group.title),
    office: text(COLLECTIONS_COLUMNS.office),
    customer_name: name === "" ? null : name,
    planned_amount: parseMoney(text(COLLECTIONS_COLUMNS.planned)) ?? 0,
    actual_amount: parseMoney(text(COLLECTIONS_COLUMNS.actual)) ?? 0,
    anticipated_date: parseDateText(text(COLLECTIONS_COLUMNS.anticipated)),
    collected_date: parseDateText(text(COLLECTIONS_COLUMNS.collected)),
    status: text(COLLECTIONS_COLUMNS.status),
    milestone: text(COLLECTIONS_COLUMNS.milestone),
    payment_type: text(COLLECTIONS_COLUMNS.paymentType),
    in_bank: text(COLLECTIONS_COLUMNS.inBank),
    date_deposited: parseDateText(text(COLLECTIONS_COLUMNS.dateDeposited)),
    notes: text(COLLECTIONS_COLUMNS.notes),
  };
}

// ── Aggregation ──────────────────────────────────────────────────────────

/** Status lanes that mean "the money landed" even when amounts are blank. */
const SETTLED_STATUSES = new Set(["collected", "processed", "funded"]);
const TROUBLE_STATUSES = new Set(["late", "urgent"]);

const statusKey = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** A row is settled when the money proves it (actual covers planned on a
 *  real plan) or the office marked it a settled lane (the fallback for rows
 *  settled without amounts entered). */
export function isSettledRow(row: {
  planned_amount: number;
  actual_amount: number;
  status: string | null;
}): boolean {
  if (row.planned_amount > 0 && row.actual_amount >= row.planned_amount) return true;
  return SETTLED_STATUSES.has(statusKey(row.status));
}

export type CollectionRowState = "collected" | "partial" | "overdue" | "pending";

/** Lane for badges and sorting. Late/Urgent force overdue; a Partial
 *  Collected row past its anticipated date is overdue on the remainder. */
export function rowCollectionState(
  row: {
    planned_amount: number;
    actual_amount: number;
    anticipated_date: string | null;
    status: string | null;
  },
  todayISO: string,
): CollectionRowState {
  if (isSettledRow(row)) return "collected";
  if (TROUBLE_STATUSES.has(statusKey(row.status))) return "overdue";
  if (row.anticipated_date !== null && row.anticipated_date < todayISO) return "overdue";
  return row.actual_amount > 0 ? "partial" : "pending";
}

export type CollectionsAgg = {
  rows: number;
  /** Σ planned_amount — the month's anticipated money. */
  anticipated: number;
  /** Σ actual_amount — the month's banked money (trusts the column). */
  collected: number;
  /** Σ per-row max(planned − actual, 0): one over-collection can never hide
   *  another customer's shortfall. May exceed anticipated − collected. */
  outstanding: number;
  /** collected / anticipated, null when nothing was anticipated. */
  pct: number | null;
  overdueCount: number;
  /** Σ uncollected remainder across overdue rows. */
  overdueAmount: number;
  byStatus: Array<{ status: string; count: number; planned: number; actual: number }>;
  /** Always both offices, filter-independent (Office War doctrine), plus an
   *  "Unassigned" lane when old boards carry rows with no office column. */
  byOffice: Array<{ office: string; anticipated: number; collected: number }>;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function aggregateCollections(
  rows: Array<
    Pick<
      ReportCollectionRow,
      "planned_amount" | "actual_amount" | "anticipated_date" | "status" | "office"
    >
  >,
  opts: { office?: string; todayISO: string },
): CollectionsAgg {
  const officeRows =
    opts.office === undefined ? rows : rows.filter((r) => r.office === opts.office);
  let anticipated = 0;
  let collected = 0;
  let outstanding = 0;
  let overdueCount = 0;
  let overdueAmount = 0;
  const byStatus = new Map<
    string,
    { status: string; count: number; planned: number; actual: number }
  >();
  for (const r of officeRows) {
    anticipated += r.planned_amount;
    collected += r.actual_amount;
    const remainder = Math.max(r.planned_amount - r.actual_amount, 0);
    outstanding += remainder;
    if (rowCollectionState(r, opts.todayISO) === "overdue") {
      overdueCount += 1;
      overdueAmount += remainder;
    }
    const label = (r.status ?? "").trim() || "No status";
    const slot = byStatus.get(statusKey(label)) ?? {
      status: label,
      count: 0,
      planned: 0,
      actual: 0,
    };
    slot.count += 1;
    slot.planned = round2(slot.planned + r.planned_amount);
    slot.actual = round2(slot.actual + r.actual_amount);
    byStatus.set(statusKey(label), slot);
  }
  // Office lanes come from ALL rows, never the office-filtered set.
  const byOffice: CollectionsAgg["byOffice"] = OFFICE_LOCATIONS.map((office) => {
    const mine = rows.filter((r) => r.office === office);
    return {
      office,
      anticipated: round2(mine.reduce((s, r) => s + r.planned_amount, 0)),
      collected: round2(mine.reduce((s, r) => s + r.actual_amount, 0)),
    };
  });
  const unassigned = rows.filter(
    (r) => r.office === null || !OFFICE_LOCATIONS.includes(r.office as never),
  );
  if (unassigned.length > 0) {
    byOffice.push({
      office: "Unassigned",
      anticipated: round2(unassigned.reduce((s, r) => s + r.planned_amount, 0)),
      collected: round2(unassigned.reduce((s, r) => s + r.actual_amount, 0)),
    });
  }
  return {
    rows: officeRows.length,
    anticipated: round2(anticipated),
    collected: round2(collected),
    outstanding: round2(outstanding),
    pct: anticipated > 0 ? collected / anticipated : null,
    overdueCount,
    overdueAmount: round2(overdueAmount),
    byStatus: [...byStatus.values()].sort((a, b) => b.planned - a.planned),
    byOffice,
  };
}

// ── Cash curve + forward outlook (God Mode v2, owner 2026-10-01) ─────────

type CurveRow = Pick<
  ReportCollectionRow,
  "planned_amount" | "actual_amount" | "anticipated_date" | "collected_date" | "office"
>;

export type CashCurve = {
  /** monthStart..monthEnd inclusive, ISO days. */
  days: string[];
  /** Cumulative Σ planned_amount bucketed by anticipated_date. */
  antCum: number[];
  /** Cumulative Σ actual_amount bucketed by collected_date. */
  colCum: number[];
  /** Index of todayISO in days; -1 when the month is entirely past/future. */
  todayIdx: number;
  /** colCum − antCum at today (current month) or at month end (past). */
  delta: number;
  /** Planned $ with no anticipated_date + collected $ with no collected
   *  date — bucketed into day 0 but called out so the chart can footnote. */
  undatedPlanned: number;
  undatedCollected: number;
};

const dayAddISO = (iso: string, n: number): string => {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
};

/** Day-by-day cumulative anticipated vs collected across one month.
 *  Bucketing: dates before the month (or missing) land on day 0, dates
 *  after it land on the last day — so BY CONSTRUCTION the curve endpoints
 *  equal aggregateCollections' anticipated/collected for the same rows
 *  (owner trust rule: the chart must reconcile with the hero numbers). */
export function buildCashCurve(
  rows: CurveRow[],
  opts: { monthStart: string; monthEnd: string; todayISO: string; office?: string },
): CashCurve {
  const mine = opts.office === undefined ? rows : rows.filter((r) => r.office === opts.office);
  const days: string[] = [];
  for (let d = opts.monthStart; d <= opts.monthEnd; d = dayAddISO(d, 1)) days.push(d);
  const n = days.length;
  const idxOf = (iso: string | null): number => {
    if (iso === null) return 0;
    if (iso < opts.monthStart) return 0;
    if (iso > opts.monthEnd) return n - 1;
    const i = days.indexOf(iso);
    return i < 0 ? 0 : i;
  };
  const ant = new Array<number>(n).fill(0);
  const col = new Array<number>(n).fill(0);
  let undatedPlanned = 0;
  let undatedCollected = 0;
  for (const r of mine) {
    if (r.planned_amount > 0) {
      ant[idxOf(r.anticipated_date)] += r.planned_amount;
      if (r.anticipated_date === null) undatedPlanned += r.planned_amount;
    }
    if (r.actual_amount > 0) {
      col[idxOf(r.collected_date)] += r.actual_amount;
      if (r.collected_date === null) undatedCollected += r.actual_amount;
    }
  }
  const round = (x: number) => Math.round(x * 100) / 100;
  const antCum: number[] = [];
  const colCum: number[] = [];
  let a = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    a += ant[i];
    c += col[i];
    antCum.push(round(a));
    colCum.push(round(c));
  }
  const todayIdx = days.indexOf(opts.todayISO);
  const at = todayIdx >= 0 ? todayIdx : n - 1;
  return {
    days,
    antCum,
    colCum,
    todayIdx,
    delta: round(colCum[at] - antCum[at]),
    undatedPlanned: round(undatedPlanned),
    undatedCollected: round(undatedCollected),
  };
}

export type ForwardOutlook = {
  /** Uncollected remainder due before today (the backlog to chase). */
  overdueBacklog: number;
  /** Remainder with anticipated_date in (today, today+7] / +30. */
  next7: number;
  next30: number;
  /** Remainder with no anticipated_date at all — unschedulable. */
  undated: number;
};

/** Expected cash ahead, from every open row's uncollected remainder
 *  (max(planned − actual, 0)). Feed it the CURRENT + NEXT month's rows —
 *  next month's payments live on next month's board. */
export function buildForwardOutlook(
  rows: CurveRow[],
  opts: { todayISO: string; office?: string },
): ForwardOutlook {
  const mine = opts.office === undefined ? rows : rows.filter((r) => r.office === opts.office);
  const round = (x: number) => Math.round(x * 100) / 100;
  let overdueBacklog = 0;
  let next7 = 0;
  let next30 = 0;
  let undated = 0;
  const d7 = dayAddISO(opts.todayISO, 7);
  const d30 = dayAddISO(opts.todayISO, 30);
  for (const r of mine) {
    const remaining = Math.max(r.planned_amount - r.actual_amount, 0);
    if (remaining <= 0) continue;
    const due = r.anticipated_date;
    if (due === null) {
      undated += remaining;
    } else if (due < opts.todayISO) {
      overdueBacklog += remaining;
    } else {
      if (due <= d7) next7 += remaining;
      if (due <= d30) next30 += remaining;
    }
  }
  return {
    overdueBacklog: round(overdueBacklog),
    next7: round(next7),
    next30: round(next30),
    undated: round(undated),
  };
}

/** Per-month anticipated/collected rollup for the 12-month Sparkbars strip.
 *  Rows span many collection_months; returns months sorted ascending. */
export function monthlyCollectionsTrend(
  rows: Array<
    Pick<ReportCollectionRow, "collection_month" | "planned_amount" | "actual_amount" | "office">
  >,
  opts: { office?: string } = {},
): Array<{ month: string; anticipated: number; collected: number }> {
  const mine = opts.office === undefined ? rows : rows.filter((r) => r.office === opts.office);
  const by = new Map<string, { anticipated: number; collected: number }>();
  for (const r of mine) {
    const slot = by.get(r.collection_month) ?? { anticipated: 0, collected: 0 };
    slot.anticipated += r.planned_amount;
    slot.collected += r.actual_amount;
    by.set(r.collection_month, slot);
  }
  const round = (x: number) => Math.round(x * 100) / 100;
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({
      month,
      anticipated: round(v.anticipated),
      collected: round(v.collected),
    }));
}

/** Quantile step (0–4) for the calendar heatmap ramp: 0 = zero/empty, then
 *  quartile buckets of the NON-ZERO values (robust to one monster day). */
export function heatStep(value: number, nonZeroSorted: number[]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || nonZeroSorted.length === 0) return 0;
  const q = (p: number) =>
    nonZeroSorted[Math.min(nonZeroSorted.length - 1, Math.floor(p * nonZeroSorted.length))];
  if (value <= q(0.25)) return 1;
  if (value <= q(0.5)) return 2;
  if (value <= q(0.75)) return 3;
  return 4;
}
