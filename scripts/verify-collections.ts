// Collections verification suite — every God Mode money rule as an
// executable check (owner directive 2026-09-30).
// Run:  npm run verify:collections   (or: npx tsx scripts/verify-collections.ts)
//
// Pure module in, assertions out — no network, no database, no browser.
// Exits non-zero on any failure. Extend it whenever a counting rule changes.

import {
  aggregateCollections,
  buildCollectionRow,
  colTextByIdOrTitle,
  isSettledRow,
  parseCollectionsBoardName,
  parseDateText,
  parseMoney,
  rowCollectionState,
  type ReportCollectionRow,
} from "../src/lib/collections";

const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = Math.abs(Number(got ?? NaN) - Number(want ?? NaN)) < 1e-9 || got === want;
  if (!ok) fails.push(`${label}: got ${String(got)}, want ${String(want)}`);
};

// ---- 1. Board-name matcher ----------------------------------------------
const MONTHS = [
  ["January", "01"],
  ["February", "02"],
  ["March", "03"],
  ["April", "04"],
  ["May", "05"],
  ["June", "06"],
  ["July", "07"],
  ["August", "08"],
  ["September", "09"],
  ["October", "10"],
  ["November", "11"],
  ["December", "12"],
] as const;
for (const [name, mm] of MONTHS) {
  eq(
    `board name: ${name}`,
    parseCollectionsBoardName(`${name} Collections 2026`)?.collectionMonthISO,
    `2026-${mm}-01`,
  );
}
eq(
  "board name: case-insensitive",
  parseCollectionsBoardName("september collections 2026")?.collectionMonthISO,
  "2026-09-01",
);
eq(
  "board name: trailing space trims",
  parseCollectionsBoardName("September Collections 2026 ")?.collectionMonthISO,
  "2026-09-01",
);
eq(
  "board name: 2023 history",
  parseCollectionsBoardName("July Collections 2023")?.collectionMonthISO,
  "2023-07-01",
);
eq(
  "board name: subitems rejected",
  parseCollectionsBoardName("Subitems of September Collections 2026"),
  null,
);
eq(
  "board name: 'Early 2026 collections' rejected",
  parseCollectionsBoardName("Early 2026 collections"),
  null,
);
eq("board name: missing year rejected", parseCollectionsBoardName("September Collections"), null);
eq(
  "board name: pre-2000 year rejected",
  parseCollectionsBoardName("September Collections 1999"),
  null,
);
eq(
  "board name: suffix noise rejected",
  parseCollectionsBoardName("September Collections 2026 copy"),
  null,
);

// ---- 2. Cell parsers -----------------------------------------------------
eq("money: $1,234.56", parseMoney("$1,234.56"), 1234.56);
eq("money: plain", parseMoney("7650"), 7650);
eq("money: blank", parseMoney(""), null);
eq("money: garbage", parseMoney("call office"), null);
eq("money: absurd guard", parseMoney("99999999999"), null);
eq("date: plain", parseDateText("2026-09-04"), "2026-09-04");
eq("date: with time", parseDateText("2026-09-04 14:00"), "2026-09-04");
eq("date: blank", parseDateText(""), null);
eq("date: junk", parseDateText("next week"), null);

// colTextByIdOrTitle: id wins, title fallback, "" -> null. The date vs
// date_1 pair is the whole reason reads go by id first.
const cols = [
  { id: "date", text: "2026-09-02", column: { title: "Collected", id: "date" } },
  { id: "date_1", text: "2026-09-01", column: { title: "Anticipated", id: "date_1" } },
  { id: "drifted", text: "Check", column: { title: "Payment Type", id: "drifted" } },
  { id: "numbers", text: "", column: { title: "Planned Amount", id: "numbers" } },
];
eq(
  "col: collected by id",
  colTextByIdOrTitle(cols, { id: "date", title: "collected" }),
  "2026-09-02",
);
eq(
  "col: anticipated by id",
  colTextByIdOrTitle(cols, { id: "date_1", title: "anticipated" }),
  "2026-09-01",
);
eq(
  "col: title fallback on drifted id",
  colTextByIdOrTitle(cols, { id: "dropdown", title: "payment type" }),
  "Check",
);
eq(
  "col: empty text is null",
  colTextByIdOrTitle(cols, { id: "numbers", title: "planned amount" }),
  null,
);
eq("col: both miss", colTextByIdOrTitle(cols, { id: "nope", title: "no such column" }), null);

// ---- 3. buildCollectionRow ----------------------------------------------
const item = {
  id: 12495493441,
  name: "  Del Ville, Janette  ",
  group: { title: "09/01 - 09/06" },
  column_values: [
    { id: "numbers", text: "7650", column: { title: "Planned Amount", id: "numbers" } },
    { id: "numeric", text: "7,650", column: { title: "Actual Amount", id: "numeric" } },
    { id: "date_1", text: "2026-09-01", column: { title: "Anticipated", id: "date_1" } },
    { id: "date", text: "2026-09-02", column: { title: "Collected", id: "date" } },
    { id: "status2", text: "Collected", column: { title: "Status", id: "status2" } },
    { id: "status4", text: "Completion", column: { title: "Milestone", id: "status4" } },
    { id: "color_mm32n26w", text: "San Diego", column: { title: "Office", id: "color_mm32n26w" } },
    { id: "dropdown", text: "Check", column: { title: "Payment Type", id: "dropdown" } },
  ],
};
const row = buildCollectionRow(item, "18419836536", "September Collections 2026", "2026-09-01");
eq("row: id stringified", row.monday_item_id, "12495493441");
eq("row: name trimmed", row.customer_name, "Del Ville, Janette");
eq("row: planned", row.planned_amount, 7650);
eq("row: actual comma-parsed", row.actual_amount, 7650);
eq("row: anticipated", row.anticipated_date, "2026-09-01");
eq("row: collected", row.collected_date, "2026-09-02");
eq("row: office", row.office, "San Diego");
eq("row: month from board", row.collection_month, "2026-09-01");
eq("row: group verbatim", row.group_title, "09/01 - 09/06");

const bare = buildCollectionRow(
  { id: 1, name: "", group: { title: "Needs Assignment" }, column_values: [] },
  "b",
  "September Collections 2026",
  "2026-09-01",
);
eq("bare row: blank money is $0, never guessed", bare.planned_amount, 0);
eq("bare row: actual $0", bare.actual_amount, 0);
eq("bare row: empty name is null", bare.customer_name, null);
eq("bare row: Needs Assignment kept", bare.group_title, "Needs Assignment");
eq("bare row: no office is null (never defaulted)", bare.office, null);

// ---- 4. Row state --------------------------------------------------------
const TODAY = "2026-09-30";
const state = (over: Partial<ReportCollectionRow>) =>
  rowCollectionState(
    {
      planned_amount: 0,
      actual_amount: 0,
      anticipated_date: null,
      status: null,
      ...over,
    },
    TODAY,
  );
eq(
  "state: funded",
  state({ planned_amount: 100, actual_amount: 100, status: "Funded" }),
  "collected",
);
eq(
  "state: money covers plan regardless of label",
  state({ planned_amount: 100, actual_amount: 100, status: "Run Card" }),
  "collected",
);
eq(
  "state: settled by status alone (no amounts entered)",
  state({ status: "Collected" }),
  "collected",
);
eq(
  "state: partial before due date",
  state({ planned_amount: 100, actual_amount: 40, anticipated_date: "2026-10-05" }),
  "partial",
);
eq(
  "state: Partial Collected past due is overdue on the remainder",
  state({
    planned_amount: 100,
    actual_amount: 40,
    anticipated_date: "2026-09-20",
    status: "Partial Collected",
  }),
  "overdue",
);
eq(
  "state: Late forces overdue even undated",
  state({ planned_amount: 50, status: "Late" }),
  "overdue",
);
eq("state: Urgent forces overdue", state({ planned_amount: 50, status: "Urgent" }), "overdue");
eq(
  "state: run card future-dated is pending",
  state({ planned_amount: 50, anticipated_date: "2026-10-02", status: "Run Card" }),
  "pending",
);
eq(
  "state: zero-planned zero-actual past due is overdue (status rules it)",
  state({ anticipated_date: "2026-09-01", status: "On Time" }),
  "overdue",
);
eq(
  "settled: zero-planned needs a settled status (0 >= 0 must not auto-settle)",
  isSettledRow({ planned_amount: 0, actual_amount: 0, status: "On Time" }),
  false,
);
eq(
  "state: over-collection settles",
  state({ planned_amount: 100, actual_amount: 120, status: "On Time" }),
  "collected",
);

// ---- 5. Month rollup -----------------------------------------------------
const r = (over: Partial<ReportCollectionRow>): ReportCollectionRow => ({
  monday_item_id: "x",
  board_id: "b",
  board_name: "September Collections 2026",
  collection_month: "2026-09-01",
  group_title: null,
  office: "San Diego",
  customer_name: "C",
  planned_amount: 0,
  actual_amount: 0,
  anticipated_date: null,
  collected_date: null,
  status: null,
  milestone: null,
  payment_type: null,
  in_bank: null,
  date_deposited: null,
  notes: null,
  ...over,
});
const rows = [
  r({ planned_amount: 1000, actual_amount: 1000, status: "Collected" }),
  // Over-collection: +200 collected, but it must NOT offset the shortfall below.
  r({ planned_amount: 500, actual_amount: 700, status: "Funded" }),
  // Overdue remainder of 600.
  r({
    planned_amount: 800,
    actual_amount: 200,
    anticipated_date: "2026-09-10",
    status: "Partial Collected",
    office: "Orange County",
  }),
  // Pending, not yet due.
  r({ planned_amount: 300, anticipated_date: "2026-10-15", status: "Run Card" }),
  // Old board row with no office.
  r({ planned_amount: 100, actual_amount: 100, status: "Collected", office: null }),
];
const agg = aggregateCollections(rows, { todayISO: TODAY });
eq("agg: anticipated", agg.anticipated, 2700);
eq("agg: collected", agg.collected, 2000);
eq("agg: outstanding floors per row", agg.outstanding, 900); // 0 + 0 + 600 + 300 + 0
eq("agg: overdue count", agg.overdueCount, 1);
eq("agg: overdue amount is the remainder", agg.overdueAmount, 600);
eq("agg: pct", agg.pct, 2000 / 2700);
eq("agg: row count", agg.rows, 5);
const sd = agg.byOffice.find((o) => o.office === "San Diego");
const oc = agg.byOffice.find((o) => o.office === "Orange County");
const un = agg.byOffice.find((o) => o.office === "Unassigned");
eq("agg: SD lane", sd?.anticipated, 1800);
eq("agg: OC lane", oc?.anticipated, 800);
eq("agg: unassigned lane appears", un?.collected, 100);

// Office filter narrows the headline but NEVER the office lanes.
const sdOnly = aggregateCollections(rows, { todayISO: TODAY, office: "San Diego" });
eq("agg SD: anticipated", sdOnly.anticipated, 1800);
eq("agg SD: collected", sdOnly.collected, 1700);
eq("agg SD: overdue elsewhere excluded", sdOnly.overdueCount, 0);
eq(
  "agg SD: office lanes stay company-wide",
  sdOnly.byOffice.find((o) => o.office === "Orange County")?.anticipated,
  800,
);

const empty = aggregateCollections([], { todayISO: TODAY });
eq("agg empty: pct null when nothing anticipated", empty.pct, null);
eq("agg empty: zero rows", empty.rows, 0);

console.log(`checks run, ${fails.length} failure(s)`);
for (const f of fails) console.log("  FAIL " + f);
process.exit(fails.length === 0 ? 0 : 1);
