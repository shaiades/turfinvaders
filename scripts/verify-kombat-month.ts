// Kombat Month verification suite — every contest rule as an executable
// check, plus the owner's September calibration (spec §6: the money rules
// over September's Sales Reports must land on the published figures ±1).
// Run:  npm run verify:kombat-month   (or: npx tsx scripts/verify-kombat-month.ts)
// Pure module in, assertions out — no network, no database, no browser.

import {
  bountyMultiplier,
  buildMoneyCandidates,
  buildReloadPitchCandidates,
  buildScorecard,
  buildSelfGenPitchCandidates,
  buildSitCandidates,
  companyWritten,
  computeProofAward,
  contestDaysLeft,
  DEFAULT_KOMBAT_RULES,
  eligibilityStatus,
  isSitCard,
  kombatWeeks,
  mergeKombatRules,
  normalizeSalesCount,
  normalizeSource,
  projectPayouts,
  reportRowLockState,
  scoreReportCard,
  tierFor,
  totalsFromLedger,
  type KombatBounty,
  type KombatReportRow,
  type LedgerRowLite,
} from "../src/lib/kombat-month";
import type { BlockCard } from "../src/lib/close-kombat";
import {
  SEPT_EXPECTED,
  SEPT_OC_ROWS,
  SEPT_SD_ROWS,
  type SeptRow,
} from "./fixtures/kombat-sept-2026";

const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = Math.abs(Number(got ?? NaN) - Number(want ?? NaN)) < 1e-9 || got === want;
  if (!ok) fails.push(`${label}: got ${String(got)}, want ${String(want)}`);
};
const near = (label: string, got: number, want: number, tol: number) => {
  if (Math.abs(got - want) > tol) fails.push(`${label}: got ${got}, want ${want} ±${tol}`);
};

const R = DEFAULT_KOMBAT_RULES;
let n = 0;
const row = (over: Partial<KombatReportRow>): KombatReportRow => ({
  monday_item_id: `r${n++}`,
  office: "San Diego",
  report_month: "2026-10-01",
  date_sold: "2026-10-05",
  sale_amt: 0,
  cancel_amt: 0,
  wcc: "Completed",
  sales_count: "Sale",
  reps: ["Rep A"],
  source: "Canvass",
  marketing_home: "Normal",
  advantage_plus: "Non Member",
  ...over,
});
const card = (over: Partial<BlockCard>): BlockCard => ({
  monday_item_id: `c${n++}`,
  board_id: "b",
  office_location: "San Diego",
  card_date: "2026-10-06",
  group_title: null,
  lead_name: `lead ${n}`,
  reps: ["Rep A"],
  iss: "Iss",
  bo: null,
  ol: null,
  rs: null,
  pm: "PM",
  sale: null,
  sale_price: null,
  products: null,
  canvass_stats: null,
  source: null,
  agent: null,
  wcc: null,
  comments: null,
  phone: null,
  report_reps: null,
  ...over,
});

// ---- 1. Label normalization --------------------------------------------
eq("blank count = sale", normalizeSalesCount(null, R), "sale");
eq(
  "blank count honours flag",
  normalizeSalesCount(null, mergeKombatRules({ money: { blank_count_is_sale: false } })),
  "other",
);
eq("count: Reload", normalizeSalesCount(" Reload ", R), "reload");
eq("count: canceled spelling", normalizeSalesCount("Canceled", R), "cancelled");
eq("source: Self Gen", normalizeSource("Self Gen"), "self_gen");
eq("source: self-gen", normalizeSource("self-gen"), "self_gen");
eq("source: Rep Reset", normalizeSource("Rep Reset"), "rep_reset");
eq("source: jobwalk variants", normalizeSource("jobwalk"), "job_walk");
eq("source: job walk variants", normalizeSource("job walk"), "job_walk");
eq("source: Canvass is no kicker", normalizeSource("Canvass"), null);
eq("source: Reload is no kicker", normalizeSource("Reload"), null);

// ---- 2. Card scoring ----------------------------------------------------
{
  const parts = scoreReportCard(row({ sale_amt: 10000, sales_count: "Sale" }), R);
  eq(
    "sale card = volume + sale kicker",
    parts.reduce((s, p) => s + p.points, 0),
    15,
  );
}
{
  const parts = scoreReportCard(
    row({
      sale_amt: 1000,
      sales_count: "Sale",
      source: "Self Gen",
      marketing_home: "Marketing Home",
      advantage_plus: "Advantage+",
    }),
    R,
  );
  eq(
    "kickers stack: 1 + 5 + 15 + 3 + 3",
    parts.reduce((s, p) => s + p.points, 0),
    27,
  );
}
eq(
  "cancelled row earns NOTHING (not even MH)",
  scoreReportCard(
    row({ sale_amt: 5000, sales_count: "Cancelled", marketing_home: "Marketing Home" }),
    R,
  ).length,
  0,
);
eq(
  "job walk default = volume + count only",
  scoreReportCard(row({ sale_amt: 2000, sales_count: "Sale", source: "Job Walk" }), R).reduce(
    (s, p) => s + p.points,
    0,
  ),
  7,
);
eq(
  "job walk kicker is a config flag",
  scoreReportCard(
    row({ sale_amt: 2000, sales_count: "Sale", source: "Job Walk" }),
    mergeKombatRules({ money: { job_walk_kicker: 10 } }),
  ).reduce((s, p) => s + p.points, 0),
  17,
);
eq(
  "rep reset kicker",
  scoreReportCard(row({ sale_amt: 0, sales_count: "Sale", source: "Rep Reset" }), R).reduce(
    (s, p) => s + p.points,
    0,
  ),
  10,
);

eq(
  "blank-count utility row ($0, no dollars) mints nothing",
  scoreReportCard(row({ sale_amt: 0, cancel_amt: 0, sales_count: null, date_sold: null }), R)
    .length,
  0,
);
eq(
  "blank count with real money still scores as a Sale",
  scoreReportCard(row({ sale_amt: 2000, sales_count: null }), R).reduce((s, p) => s + p.points, 0),
  7,
);

// ---- 3. Split + lock ----------------------------------------------------
// Owner 2026-10-02 follow-up: points count RIGHT AWAY and stay revisable
// all month; the cancel window applies only after MONTH END (Oct + 3 days
// → final from Nov 4). Cancellations subtract immediately at any time.
{
  const { candidates } = buildMoneyCandidates(
    [row({ sale_amt: 10000, sales_count: "Sale", reps: ["A", "B"], date_sold: "2026-10-01" })],
    R,
    [],
    "2026-10-20",
  );
  eq("two reps → two rows per part", candidates.length, 4);
  const a = candidates.filter((c) => c.rep_name === "A").reduce((s, c) => s + c.points, 0);
  eq("even split", a, 7.5);
  eq(
    "mid-month: counts now, not final yet",
    candidates.every((c) => c.status === "pending"),
    true,
  );
}
eq(
  "all month long → live (pending)",
  reportRowLockState(row({ date_sold: "2026-10-01" }), R, "2026-10-31"),
  "pending",
);
eq(
  "month-end window still open → live",
  reportRowLockState(row({ date_sold: "2026-10-01" }), R, "2026-11-03"),
  "pending",
);
eq(
  "final once the month-end window passes",
  reportRowLockState(row({ date_sold: "2026-10-01" }), R, "2026-11-04"),
  "locked",
);
eq(
  "dead WCC → cancelled immediately",
  reportRowLockState(row({ wcc: "Cancelled" }), R, "2026-10-20"),
  "cancelled",
);
eq(
  "Turned Down → cancelled",
  reportRowLockState(row({ wcc: "Turned Down" }), R, "2026-10-20"),
  "cancelled",
);
eq("FTD → cancelled", reportRowLockState(row({ wcc: "FTD" }), R, "2026-10-20"), "cancelled");
eq(
  "LVM is alive",
  reportRowLockState(row({ wcc: "LVM", date_sold: "2026-10-01" }), R, "2026-11-10"),
  "locked",
);
eq(
  "no Date Sold rides the same month-end clock",
  reportRowLockState(row({ date_sold: null }), R, "2026-11-01"),
  "pending",
);
eq(
  "no Date Sold finalizes in November too",
  reportRowLockState(row({ date_sold: null }), R, "2026-11-04"),
  "locked",
);
{
  const { candidates, deadSourceIds } = buildMoneyCandidates(
    [row({ monday_item_id: "dead1", sale_amt: 0, sales_count: "Cancelled", wcc: "Cancelled" })],
    R,
    [],
    "2026-10-20",
  );
  eq("dead row emits no candidates", candidates.length, 0);
  eq("dead row lands in deadSourceIds", deadSourceIds.has("dead1"), true);
}
{
  const other = buildMoneyCandidates([row({ report_month: "2026-09-01" })], R, [], "2026-10-20");
  eq("other months stay out", other.candidates.length, 0);
}

// ---- 4. Activity: sits, reload pitches, self gen ------------------------
eq("PM card is a sit", isSitCard(card({ pm: "PM" })), true);
eq("sold card is a sit", isSitCard(card({ pm: null, sale: "Sold" })), true);
eq("reload sale is NOT a sit", isSitCard(card({ pm: null, sale: "Reload" })), false);
eq("office appt is NOT a sit", isSitCard(card({ iss: "Office Appt" })), false);
eq("CTC card is NOT a sit", isSitCard(card({ iss: "CTC" })), false);
eq(
  "cancelled lead sale is a sit (PM bucket)",
  isSitCard(card({ pm: null, sale: "Sold", wcc: "Cancelled" })),
  true,
);
eq("no-demo card is NOT a sit", isSitCard(card({ pm: null, bo: "BO" })), false);
{
  const sits = buildSitCandidates(
    [card({ reps: ["A", "B"], card_date: "2026-10-06" })],
    R,
    [],
    "2026-10-07",
  );
  eq(
    "sit = 2 pts per rep on card, not split",
    sits.length === 2 && sits.every((s) => s.points === 2),
    true,
  );
  eq(
    "sit counts live during the month",
    sits.every((s) => s.status === "pending"),
    true,
  );
}
{
  const live = buildSitCandidates([card({ card_date: "2026-10-06" })], R, [], "2026-10-31");
  eq("sit stays live through Oct 31", live[0]?.status, "pending");
  const final = buildSitCandidates([card({ card_date: "2026-10-06" })], R, [], "2026-11-04");
  eq("sit finalizes with the month", final[0]?.status, "locked");
}
{
  const subs = buildReloadPitchCandidates(
    [
      {
        subitem_id: "s1",
        parent_item_id: "p1",
        report_month: "2026-10-01",
        name: "x",
        result: "Sold",
        date_went: "2026-10-08",
        reps: ["A"],
      },
      {
        subitem_id: "s2",
        parent_item_id: "p1",
        report_month: "2026-10-01",
        name: "x",
        result: "Waiting",
        date_went: "2026-10-08",
        reps: ["A"],
      },
      {
        subitem_id: "s3",
        parent_item_id: "p1",
        report_month: "2026-10-01",
        name: "x",
        result: "PM",
        date_went: "2026-09-20",
        reps: ["A"],
      },
      {
        subitem_id: "s4",
        parent_item_id: "p1",
        report_month: "2026-10-01",
        name: "x",
        result: "PM",
        date_went: "2026-10-09",
        reps: [],
      },
    ],
    new Map([["p1", ["B"]]]),
    R,
    [],
    "2026-10-20",
  );
  eq("only Sold/PM with an October Date Went score", subs.length, 2);
  eq("reload pitch = 3", subs[0]?.points, 3);
  eq("blank subitem rep falls back to the parent row's reps", subs[1]?.rep_name, "B");
}
{
  const sg = buildSelfGenPitchCandidates(
    [
      card({ source: "self gen", card_date: "2026-10-06" }),
      card({ agent: "Self Gen", card_date: "2026-10-06" }),
      card({ source: "Canvass", card_date: "2026-10-06" }),
      card({ source: "self gen", pm: null, bo: "BO", card_date: "2026-10-06" }),
    ],
    R,
    [],
    "2026-10-07",
  );
  eq("self gen pitched: source or agent says self gen AND the card sat", sg.length, 2);
  eq("self gen pitched = 5", sg[0]?.points, 5);
  const off = buildSelfGenPitchCandidates(
    [card({ source: "self gen" })],
    mergeKombatRules({ activity: { self_gen_pitch_enabled: false } }),
    [],
    "2026-10-07",
  );
  eq("self gen pitch flag off → nothing", off.length, 0);
}

// ---- 5. Bounties --------------------------------------------------------
{
  const b: KombatBounty = {
    id: "b1",
    label: "Self Gen Week",
    categories: ["money.self_gen"],
    multiplier: 2,
    starts_on: "2026-10-13",
    ends_on: "2026-10-19",
    active: true,
  };
  eq("bounty doubles inside the window", bountyMultiplier("money.self_gen", "2026-10-15", [b]), 2);
  eq("bounty off outside the window", bountyMultiplier("money.self_gen", "2026-10-20", [b]), 1);
  eq("bounty ignores other categories", bountyMultiplier("money.sale", "2026-10-15", [b]), 1);
  eq(
    "inactive bounty is dead",
    bountyMultiplier("money.self_gen", "2026-10-15", [{ ...b, active: false }]),
    1,
  );
  const { candidates } = buildMoneyCandidates(
    [row({ sale_amt: 0, sales_count: "Sale", source: "Self Gen", date_sold: "2026-10-15" })],
    R,
    [b],
    "2026-10-25",
  );
  const selfGen = candidates.find((c) => c.category === "money.self_gen");
  eq("bounty applies at derivation: 15 × 2", selfGen?.points, 30);
}

// ---- 6. Proof caps ------------------------------------------------------
{
  const no = computeProofAward("testimonial", "2026-10-06", [], R);
  eq("testimonial = 5", no.points, 5);
  const gymDay = computeProofAward(
    "gym_checkin",
    "2026-10-06",
    [{ category: "gym_checkin", points: 1, on: "2026-10-06" }],
    R,
  );
  eq("gym 1/day cap", gymDay.points, 0);
  const gymWeek = computeProofAward(
    "gym_checkin",
    "2026-10-09",
    ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-10"].map((on) => ({
      category: "gym_checkin" as const,
      points: 1,
      on,
    })),
    R,
  );
  eq("gym 5/week cap", gymWeek.points, 0);
  const rpWeek = computeProofAward(
    "role_play",
    "2026-10-08",
    ["2026-10-05", "2026-10-06", "2026-10-07"].map((on) => ({
      category: "role_play" as const,
      points: 2,
      on,
    })),
    R,
  );
  eq("role play 3/week cap", rpWeek.points, 0);
  const rpNextWeek = computeProofAward(
    "role_play",
    "2026-10-12",
    ["2026-10-05", "2026-10-06", "2026-10-07"].map((on) => ({
      category: "role_play" as const,
      points: 2,
      on,
    })),
    R,
  );
  eq("role play cap resets Monday", rpNextWeek.points, 2);
  const baMonth = computeProofAward(
    "before_after",
    "2026-10-20",
    Array.from({ length: 10 }, (_, i) => ({
      category: "before_after" as const,
      points: 1,
      on: `2026-10-${String(i + 1).padStart(2, "0")}`,
    })),
    R,
  );
  eq("before/after 10/month cap", baMonth.points, 0);
  const total = computeProofAward(
    "testimonial",
    "2026-10-20",
    Array.from({ length: 12 }, (_, i) => ({
      category: "referral_sit" as const,
      points: i < 7 ? 5 : 1,
      on: "2026-10-10",
    })),
    R,
  );
  // 7×5 + 5×1 = 40 already spent → clamp to 0.
  eq("40/month total cap clamps", total.points, 0);
  const clamp = computeProofAward(
    "testimonial",
    "2026-10-20",
    Array.from({ length: 7 }, () => ({
      category: "referral_sit" as const,
      points: 5,
      on: "2026-10-10",
    })),
    R,
  );
  // 35 spent → a 5-point testimonial still fits exactly.
  eq("total cap exact fit", clamp.points, 5);
  const clamp2 = computeProofAward(
    "testimonial",
    "2026-10-20",
    [
      ...Array.from({ length: 7 }, () => ({
        category: "referral_sit" as const,
        points: 5,
        on: "2026-10-10",
      })),
      { category: "before_after" as const, points: 1, on: "2026-10-11" },
    ],
    R,
  );
  // 36 spent → testimonial clamps to the remaining 4.
  eq("total cap partial clamp", clamp2.points, 4);
  eq("partial clamp flagged", clamp2.capped, true);
}

// ---- 7. Tiers, payouts, company bar -------------------------------------
{
  eq("no tier below Steakhouse", tierFor(124, R).current, null);
  eq("Steakhouse at 125", tierFor(125, R).current?.key, "steakhouse");
  eq("King at 500", tierFor(500, R).current?.key, "king");
  const t = tierFor(130, R);
  eq("next tier is Bronze", t.next?.key, "bronze");
  eq("70 to Bronze", t.toNext, 70);
}
{
  const ledger: LedgerRowLite[] = [
    { rep_name: "A", category: "money.volume", points: 300, status: "locked" },
    { rep_name: "A", category: "money.sale", points: 80, status: "pending" },
    { rep_name: "B", category: "money.volume", points: 210, status: "locked" },
    { rep_name: "C", category: "money.volume", points: 100, status: "locked" },
    { rep_name: "C", category: "money.sale", points: 50, status: "cancelled" },
  ];
  const totals = totalsFromLedger(ledger);
  eq("cancelled rows never count", totals.find((t) => t.rep_name === "C")?.total, 100);
  eq("locked + pending split", totals.find((t) => t.rep_name === "A")?.pending, 80);
  const eligible = new Map([
    ["A", true],
    ["B", true],
    ["C", false],
  ]);
  const proj = projectPayouts(totals, eligible, 2_000_000, R);
  eq("A at Gold (380 pts) → $2000", proj.rows.find((r) => r.rep_name === "A")?.cash, 2000);
  eq("B at Bronze (210) → $500", proj.rows.find((r) => r.rep_name === "B")?.cash, 500);
  eq("ineligible C gets nothing", proj.rows.find((r) => r.rep_name === "C")?.cash, 0);
  eq("under budget", proj.overBudget, false);
  const unlocked = projectPayouts(totals, eligible, 3_100_000, R);
  eq("$3M unlock ×1.25", unlocked.rows.find((r) => r.rep_name === "A")?.cash, 2500);
  const tight = projectPayouts(
    totals,
    eligible,
    3_100_000,
    mergeKombatRules({ prizes: { budget_cap: 1500 } }),
  );
  eq("over budget flagged", tight.overBudget, true);
  near("cash pro-rated to the cap", tight.prorate, 1500 / 3125, 1e-9);
}
eq(
  "company written sums the month net",
  companyWritten(
    [row({ sale_amt: 100 }), row({ sale_amt: 50, report_month: "2026-09-01" })],
    "2026-10-01",
  ),
  100,
);

// ---- 8. Eligibility -----------------------------------------------------
{
  const weeks = kombatWeeks("2026-10-01");
  eq("October 2026 spans 5 Mon–Sun weeks", weeks.length, 5);
  eq("first week clips to Oct 1", weeks[0]?.octStart, "2026-10-01");
  eq("last week clips to Oct 31", weeks[4]?.octEnd, "2026-10-31");
  const s = eligibilityStatus(
    { purposeSubmitted: true, testDays: ["2026-10-02", "2026-10-06"], hasCountedSale: true },
    R,
    "2026-10-07",
  );
  eq("two weeks due by Oct 7", s.weeksDue, 2);
  eq("both weeks hit", s.weeksHit, 2);
  eq("eligible", s.eligible, true);
  const miss = eligibilityStatus(
    { purposeSubmitted: true, testDays: ["2026-09-30"], hasCountedSale: true },
    R,
    "2026-10-03",
  );
  eq("a Sep 30 take does not cover an October week", miss.testsOk, false);
  const noPurpose = eligibilityStatus(
    { purposeSubmitted: false, testDays: ["2026-10-02"], hasCountedSale: true },
    R,
    "2026-10-03",
  );
  eq("purpose required", noPurpose.eligible, false);
}

// ---- 9. September calibration (owner's figures, ±1) ---------------------
{
  const septRules = mergeKombatRules({ contest: { month: "2026-09-01" } });
  const toRows = (rows: SeptRow[], office: string): KombatReportRow[] =>
    rows.map(([amt, count, source, mh, ap, wcc, reps], i) => ({
      monday_item_id: `${office}-${i}`,
      office,
      report_month: "2026-09-01",
      date_sold: "2026-09-15",
      sale_amt: amt,
      cancel_amt: 0,
      wcc,
      sales_count: count,
      reps,
      source,
      marketing_home: mh,
      advantage_plus: ap,
    }));
  const all = [...toRows(SEPT_SD_ROWS, "San Diego"), ...toRows(SEPT_OC_ROWS, "Orange County")];
  const { candidates } = buildMoneyCandidates(all, septRules, [], "2026-12-01");
  const totals = totalsFromLedger(candidates.map((c) => ({ ...c })));
  for (const [rep, want] of Object.entries(SEPT_EXPECTED)) {
    const got = totals.find((t) => t.rep_name === rep)?.total ?? 0;
    near(`calibration: ${rep}`, Math.round(got), want, 1);
  }
  eq("calibration covers every rep exactly once", totals.length, Object.keys(SEPT_EXPECTED).length);
}

// ---- 10. Scorecard + countdown (presentation helpers) ------------------
{
  const groups = buildScorecard(R);
  const money = groups.find((g) => g.key === "money")!;
  eq("scorecard money reads config", money.moves.find((m) => m.label === "Self Gen")?.points, 15);
  eq(
    "Job Walk dropped at the default 0 weight",
    money.moves.some((m) => m.label === "Job Walk"),
    false,
  );
  const jwOn = buildScorecard(mergeKombatRules({ money: { job_walk_kicker: 7 } }));
  eq(
    "Job Walk appears when the owner sets a weight",
    jwOn.find((g) => g.key === "money")!.moves.find((m) => m.label === "Job Walk")?.points,
    7,
  );
  const activity = groups.find((g) => g.key === "activity")!;
  eq("scorecard activity has the sit", activity.moves.find((m) => m.label === "Sit")?.points, 2);
  const sgOff = buildScorecard(mergeKombatRules({ activity: { self_gen_pitch_enabled: false } }));
  eq(
    "self gen pitched drops when detection is off",
    sgOff.find((g) => g.key === "activity")!.moves.some((m) => m.label === "Self gen pitched"),
    false,
  );
  const proofs = groups.find((g) => g.key === "proofs")!;
  eq(
    "scorecard proofs read config",
    proofs.moves.find((m) => m.label === "Video testimonial")?.points,
    5,
  );
  eq(
    "before/after carries its cap note",
    proofs.moves.find((m) => m.label === "Before/after set")?.note,
    "10/mo",
  );
}
eq("countdown: Oct 1 → 31 days left", contestDaysLeft(R, "2026-10-01"), 31);
eq("countdown: Oct 31 → 1 day left", contestDaysLeft(R, "2026-10-31"), 1);
eq("countdown: November → 0", contestDaysLeft(R, "2026-11-02"), 0);
eq("countdown clamps a pre-month date to the full month", contestDaysLeft(R, "2026-09-20"), 31);

console.log(`checks run, ${fails.length} failure(s)`);
for (const f of fails) console.log("  FAIL " + f);
process.exit(fails.length === 0 ? 0 : 1);
