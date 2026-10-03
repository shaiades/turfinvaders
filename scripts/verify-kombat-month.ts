// Kombat Month verification suite — every contest rule as an executable
// check. Run:  npm run verify:kombat-month   (npx tsx scripts/verify-kombat-month.ts)
// Pure module in, assertions out — no network, no database, no browser.
//
// Model (owner 2026-10-02 rework): volume (1pt/$1k) SPLITS across the sale's
// reps; every other point is FULL to each rep. One type kicker per block
// card, never stacking (self-gen/referral sale 15, pitch-miss 10; reload 10;
// sale 5; sit 2; job walk → nothing). Marketing Home + Upsell removed.
// Advantage+ (3) is the only report bonus; a Rep Reset sale is just a sale
// (owner 2026-10-02 — not a behavior we reward). Dinner tier 175.

import {
  BELT_ACCENT,
  SALE_CATEGORIES,
  bountyMultiplier,
  buildCardCandidates,
  buildCardVolumeCandidates,
  buildMoneyCandidates,
  buildReloadPitchCandidates,
  buildScorecard,
  cardSource,
  companyWritten,
  computeProofAward,
  contestDaysLeft,
  DEFAULT_KOMBAT_RULES,
  eligibilityStatus,
  isSitCard,
  liveBlockVolumeDollars,
  kombatWeeks,
  mergeKombatRules,
  normalizeSalesCount,
  normalizeSource,
  projectPayouts,
  reportRowLockState,
  reportOnlyKicker,
  scoreReportCard,
  scoredCardKeys,
  tierFor,
  totalsFromLedger,
  type KombatBounty,
  type KombatReportRow,
  type LedgerRowLite,
} from "../src/lib/kombat-month";
import type { BlockCard } from "../src/lib/close-kombat";
import { SEPT_OC_ROWS, SEPT_SD_ROWS, type SeptRow } from "./fixtures/kombat-sept-2026";

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
const MID = "2026-10-20"; // mid-contest: everything still live (pending)

// ---- 1. Label normalization --------------------------------------------
eq("blank count = other", normalizeSalesCount(null), "other");
eq("count: Reload", normalizeSalesCount(" Reload "), "reload");
eq("count: canceled spelling", normalizeSalesCount("Canceled"), "cancelled");
eq("source: Self Gen", normalizeSource("Self Gen"), "self_gen");
eq("source: self-gen", normalizeSource("self-gen"), "self_gen");
eq("source: Referral", normalizeSource("Referral"), "referral");
eq("source: referal (1 r)", normalizeSource("referal"), "referral");
eq("source: Rep Reset is not a token (scores as a sale)", normalizeSource("Rep Reset"), null);
eq("source: job walk variants", normalizeSource("job walk"), "job_walk");
eq("source: Canvass is nothing", normalizeSource("Canvass"), null);
eq("cardSource reads source first", cardSource({ source: "Self Gen", agent: null }), "self_gen");
eq("cardSource falls back to agent", cardSource({ source: null, agent: "referral" }), "referral");

// ---- 2. Report money layer (volume split + flat bonuses) ----------------
{
  const parts = scoreReportCard(row({ sale_amt: 10000, sales_count: "Sale" }), R);
  eq("report row = volume only (no sale kicker here)", parts.length, 1);
  eq("volume = $/1000", parts[0].points, 10);
  eq("volume splits", parts[0].split, true);
}
eq(
  "cancelled report row earns nothing",
  scoreReportCard(row({ sale_amt: 5000, sales_count: "Cancelled" }), R).length,
  0,
);
eq(
  "Marketing Home no longer scores",
  scoreReportCard(row({ sale_amt: 0, marketing_home: "Marketing Home" }), R).length,
  0,
);
eq(
  "Upsell no longer kicks (volume only)",
  scoreReportCard(row({ sale_amt: 3000, sales_count: "Upsell" }), R).reduce(
    (s, p) => s + p.points,
    0,
  ),
  3,
);
{
  const parts = scoreReportCard(
    row({ sale_amt: 0, advantage_plus: "Advantage+", source: "Rep Reset" }),
    R,
  );
  const adv = parts.find((p) => p.category === "money.advantage_plus");
  eq("advantage+ bonus = 3, full per rep", adv?.points, 3);
  eq("advantage+ does not split", adv?.split, false);
  eq(
    "rep reset earns no special money bonus",
    parts.some((p) => p.category === "money.rep_reset"),
    false,
  );
}

// ---- 3. Volume splits, bonuses don't ------------------------------------
{
  const { candidates } = buildMoneyCandidates(
    [row({ sale_amt: 20000, advantage_plus: "Advantage+", reps: ["A", "B"] })],
    R,
    [],
    MID,
  );
  const a = candidates.filter((c) => c.rep_name === "A");
  const vol = a.find((c) => c.category === "money.volume");
  const adv = a.find((c) => c.category === "money.advantage_plus");
  eq("volume split: 20 / 2 = 10 each", vol?.points, 10);
  eq("advantage+ full to each rep: 3", adv?.points, 3);
  eq("both reps covered", new Set(candidates.map((c) => c.rep_name)).size, 2);
}
{
  const { candidates, deadSourceIds } = buildMoneyCandidates(
    [row({ monday_item_id: "dead", sale_amt: 0, sales_count: "Cancelled", wcc: "Cancelled" })],
    R,
    [],
    MID,
  );
  eq("dead row → no candidates", candidates.length, 0);
  eq("dead row → deadSourceIds", deadSourceIds.has("dead"), true);
}
eq(
  "other months stay out",
  buildMoneyCandidates([row({ report_month: "2026-09-01" })], R, [], MID).candidates.length,
  0,
);

// ---- 4. Locking (count live all month, lock after month-end window) -----
eq(
  "live through Oct 31",
  reportRowLockState(row({ date_sold: "2026-10-01" }), R, "2026-10-31"),
  "pending",
);
eq(
  "still live Nov 3",
  reportRowLockState(row({ date_sold: "2026-10-01" }), R, "2026-11-03"),
  "pending",
);
eq("final Nov 4", reportRowLockState(row({ date_sold: "2026-10-01" }), R, "2026-11-04"), "locked");
eq("dead WCC → cancelled", reportRowLockState(row({ wcc: "Turned Down" }), R, MID), "cancelled");

// ---- 5. Card kicker — one per card, full per rep, no stacking ------------
const kickerOf = (c: BlockCard, today = MID) => {
  const out = buildCardCandidates([c], R, [], today);
  const cats = new Set(out.map((x) => x.category));
  return { cats: [...cats], points: out[0]?.points, rows: out.length, cat: out[0]?.category };
};
eq(
  "self-gen sale → 15",
  kickerOf(card({ source: "self gen", pm: null, sale: "Sold" })).cat,
  "card.selfgen_sale",
);
eq(
  "self-gen sale points 15",
  kickerOf(card({ source: "self gen", pm: null, sale: "Sold" })).points,
  15,
);
eq(
  "referral sale → 15",
  kickerOf(card({ source: "Referral", pm: null, sale: "Sold" })).cat,
  "card.referral_sale",
);
eq(
  "self-gen pitch miss → 10",
  kickerOf(card({ source: "self gen", pm: "PM", sale: null })).cat,
  "card.selfgen_miss",
);
eq(
  "self-gen miss points 10",
  kickerOf(card({ source: "self gen", pm: "PM", sale: null })).points,
  10,
);
eq(
  "referral pitch miss → 10",
  kickerOf(card({ source: "referral", pm: "PM", sale: null })).cat,
  "card.referral_miss",
);
eq(
  "reload sale → 10",
  kickerOf(card({ source: "Canvass", pm: null, sale: "Reload" })).cat,
  "card.reload",
);
eq(
  "normal sale → 5",
  kickerOf(card({ source: "Canvass", pm: null, sale: "Sold" })).cat,
  "card.sale",
);
eq("normal sit → 2", kickerOf(card({ source: "Canvass", pm: "PM", sale: null })).cat, "card.sit");
eq(
  "job walk sale → no kicker",
  kickerOf(card({ source: "Job Walk", pm: null, sale: "Sold" })).rows,
  0,
);
eq(
  "office appt → no kicker",
  kickerOf(card({ iss: "Office Appt", pm: null, sale: "Sold" })).rows,
  0,
);
eq("CTC excluded → no kicker", kickerOf(card({ iss: "CTC", pm: "PM" })).rows, 0);
eq("no-demo → no kicker", kickerOf(card({ pm: null, bo: "BO" })).rows, 0);
eq(
  "NO STACKING: self-gen sale emits exactly one category",
  kickerOf(card({ source: "self gen", pm: null, sale: "Sold" })).cats.length,
  1,
);
{
  // Full per rep: a 2-rep self-gen sale → 15 to EACH.
  const out = buildCardCandidates(
    [card({ source: "self gen", pm: null, sale: "Sold", reps: ["A", "B"] })],
    R,
    [],
    MID,
  );
  eq("self-gen sale is full per rep (2 rows)", out.length, 2);
  eq(
    "each rep gets the full 15",
    out.every((c) => c.points === 15),
    true,
  );
}
eq(
  "cancelled self-gen sale → sat credit (miss 10), money zeroed elsewhere",
  kickerOf(card({ source: "self gen", pm: null, sale: "Sold", wcc: "Cancelled" })).cat,
  "card.selfgen_miss",
);
eq(
  "agent-sourced self gen also counts",
  kickerOf(card({ source: null, agent: "Self Gen", pm: null, sale: "Sold" })).cat,
  "card.selfgen_sale",
);
// card candidates lock with the month, like the money layer.
eq(
  "card kicker live mid-month",
  buildCardCandidates([card({ pm: "PM" })], R, [], "2026-10-31")[0]?.status,
  "pending",
);
eq(
  "card kicker final after month-end window",
  buildCardCandidates([card({ pm: "PM" })], R, [], "2026-11-04")[0]?.status,
  "locked",
);
// isSitCard still classifies sits (PM/Sold) correctly.
eq("isSitCard: PM is a sit", isSitCard(card({ pm: "PM" })), true);
eq("isSitCard: no-demo is not", isSitCard(card({ pm: null, bo: "BO" })), false);

// ---- 6. Bounties --------------------------------------------------------
{
  const b: KombatBounty = {
    id: "b1",
    label: "Self Gen Week",
    categories: ["card.selfgen_sale"],
    multiplier: 2,
    starts_on: "2026-10-13",
    ends_on: "2026-10-19",
    active: true,
  };
  eq("bounty doubles inside window", bountyMultiplier("card.selfgen_sale", "2026-10-15", [b]), 2);
  eq("bounty off outside window", bountyMultiplier("card.selfgen_sale", "2026-10-25", [b]), 1);
  eq("bounty ignores other categories", bountyMultiplier("card.sale", "2026-10-15", [b]), 1);
  const out = buildCardCandidates(
    [card({ source: "self gen", pm: null, sale: "Sold", card_date: "2026-10-15" })],
    R,
    [b],
    MID,
  );
  eq("bounty applies at derivation: 15 × 2", out[0]?.points, 30);
}

// ---- 7. Proof caps (unchanged) ------------------------------------------
{
  eq("testimonial = 5", computeProofAward("testimonial", "2026-10-06", [], R).points, 5);
  eq(
    "gym 1/day cap",
    computeProofAward(
      "gym_checkin",
      "2026-10-06",
      [{ category: "gym_checkin", points: 1, on: "2026-10-06" }],
      R,
    ).points,
    0,
  );
  eq(
    "role play 3/week cap",
    computeProofAward(
      "role_play",
      "2026-10-08",
      ["2026-10-05", "2026-10-06", "2026-10-07"].map((on) => ({
        category: "role_play" as const,
        points: 2,
        on,
      })),
      R,
    ).points,
    0,
  );
  const total = computeProofAward(
    "testimonial",
    "2026-10-20",
    Array.from({ length: 7 }, () => ({
      category: "referral_sit" as const,
      points: 5,
      on: "2026-10-10",
    })),
    R,
  );
  eq("40/mo total cap: 35 spent → 5 fits", total.points, 5);
}

// ---- 8. Tiers + payouts + company bar (dinner = 175) --------------------
eq("below dinner", tierFor(174, R).current, null);
eq("dinner at 175", tierFor(175, R).current?.key, "steakhouse");
eq("King at 600", tierFor(600, R).current?.key, "king");
{
  const t = tierFor(200, R);
  eq("next tier is Bronze", t.next?.key, "bronze");
  eq("50 to Bronze", t.toNext, 50);
}
{
  const ledger: LedgerRowLite[] = [
    { rep_name: "A", category: "money.volume", points: 460, status: "locked" },
    { rep_name: "A", category: "card.selfgen_sale", points: 30, status: "pending" },
    { rep_name: "B", category: "money.volume", points: 260, status: "locked" },
    { rep_name: "C", category: "money.volume", points: 100, status: "locked" },
    { rep_name: "C", category: "card.sale", points: 50, status: "cancelled" },
  ];
  const totals = totalsFromLedger(ledger);
  eq("cancelled never counts", totals.find((t) => t.rep_name === "C")?.total, 100);
  eq("A total 490", totals.find((t) => t.rep_name === "A")?.total, 490);
  const eligible = new Map([
    ["A", true],
    ["B", true],
    ["C", false],
  ]);
  const proj = projectPayouts(totals, eligible, 2_000_000, R);
  eq("A at Gold (490 pts) → $2000", proj.rows.find((r) => r.rep_name === "A")?.cash, 2000);
  eq("B at Bronze (260) → $500", proj.rows.find((r) => r.rep_name === "B")?.cash, 500);
  eq("ineligible C gets nothing", proj.rows.find((r) => r.rep_name === "C")?.cash, 0);
  const unlocked = projectPayouts(totals, eligible, 3_100_000, R);
  eq("$3M unlock ×1.25", unlocked.rows.find((r) => r.rep_name === "A")?.cash, 2500);
}
eq(
  "company written sums the month net",
  companyWritten(
    [row({ sale_amt: 100 }), row({ sale_amt: 50, report_month: "2026-09-01" })],
    "2026-10-01",
  ),
  100,
);

// ---- 9. Scorecard reflects the new config -------------------------------
{
  const groups = buildScorecard(R);
  eq("four scorecard groups", groups.length, 4);
  const money = groups.find((g) => g.key === "money")!;
  eq("money has volume", money.moves.find((m) => m.label === "Written volume")?.points, 1);
  eq(
    "money has no Sale/Upsell/Marketing Home",
    money.moves.some((m) => /sale|upsell|marketing/i.test(m.label)),
    false,
  );
  const close = groups.find((g) => g.key === "close")!;
  eq("close: self-gen sale 15", close.moves.find((m) => m.label === "Self-gen sale")?.points, 15);
  eq("close: referral sale 15", close.moves.find((m) => m.label === "Referral sale")?.points, 15);
  const act = groups.find((g) => g.key === "activity")!;
  eq(
    "activity: self-gen pitch 10",
    act.moves.find((m) => m.label === "Self-gen pitch")?.points,
    10,
  );
  eq("activity: sit 2", act.moves.find((m) => m.label === "Sit")?.points, 2);
}
eq("SALE_CATEGORIES covers the four closes", SALE_CATEGORIES.length, 4);
eq("BELT_ACCENT has steakhouse", typeof BELT_ACCENT.steakhouse, "string");

// ---- 10. Countdown + eligibility ----------------------------------------
eq("Oct 1 → 31 days left", contestDaysLeft(R, "2026-10-01"), 31);
eq("Oct 31 → 1 day left", contestDaysLeft(R, "2026-10-31"), 1);
eq("November → 0", contestDaysLeft(R, "2026-11-02"), 0);
{
  const weeks = kombatWeeks("2026-10-01");
  eq("October spans 5 Mon–Sun weeks", weeks.length, 5);
  const s = eligibilityStatus(
    { purposeSubmitted: true, testDays: ["2026-10-02", "2026-10-06"], hasCountedSale: true },
    R,
    "2026-10-07",
  );
  eq("two weeks due by Oct 7, both hit", s.weeksHit, 2);
  eq("eligible", s.eligible, true);
  eq(
    "a Sep 30 take doesn't cover an October week",
    eligibilityStatus(
      { purposeSubmitted: true, testDays: ["2026-09-30"], hasCountedSale: true },
      R,
      "2026-10-03",
    ).testsOk,
    false,
  );
  eq(
    "no sale → not eligible",
    eligibilityStatus(
      { purposeSubmitted: true, testDays: ["2026-10-02"], hasCountedSale: false },
      R,
      "2026-10-03",
    ).eligible,
    false,
  );
}

// ---- 11. September fixture: volume splits correctly ---------------------
// The fixture is report rows only (no block cards), so under the new model
// it produces VOLUME (split) + the Advantage+ bonus. Validates the
// split mechanic against real data: total volume == Σ non-cancelled
// sale_amt / 1000, and a known two-rep deal halves.
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
  const volPts = candidates
    .filter((c) => c.category === "money.volume")
    .reduce((s, c) => s + c.points, 0);
  const expectedVol =
    all
      .filter((r) => normalizeSalesCount(r.sales_count) !== "cancelled")
      .reduce((s, r) => s + r.sale_amt, 0) / 1000;
  near("Sept total volume = Σ non-cancelled sale_amt / 1000", volPts, expectedVol, 0.5);
  // Every volume candidate for a 2-rep row is exactly half the card volume.
  const twoRep = all.find((r) => r.reps.length === 2 && r.sale_amt > 0 && r.wcc !== "Cancelled")!;
  const mine = candidates.filter(
    (c) => c.source_id === twoRep.monday_item_id && c.category === "money.volume",
  );
  eq("2-rep row → 2 volume candidates", mine.length, 2);
  near("each = half the volume", mine[0]?.points ?? 0, twoRep.sale_amt / 1000 / 2, 1e-6);
}

// ---- 12. Report-only sales carry a kicker (no double) -------------------
// reportOnlyKicker: the kicker a report sale earns on its own.
eq(
  "report-only: plain sale → 5",
  reportOnlyKicker(row({ sales_count: "Sale", source: "Canvass" }), R)?.points,
  5,
);
eq(
  "report-only: self-gen sale → 15",
  reportOnlyKicker(row({ sales_count: "Sale", source: "Self Gen" }), R)?.category,
  "card.selfgen_sale",
);
eq(
  "report-only: rep-reset sale scores as a plain sale",
  reportOnlyKicker(row({ sales_count: "Sale", source: "Rep Reset" }), R)?.category,
  "card.sale",
);
eq(
  "report-only: reload → 10",
  reportOnlyKicker(row({ sales_count: "Reload", source: "Reload" }), R)?.points,
  10,
);
eq("report-only: upsell → none", reportOnlyKicker(row({ sales_count: "Upsell" }), R), null);
eq(
  "report-only: job walk → none",
  reportOnlyKicker(row({ sales_count: "Sale", source: "Job Walk" }), R),
  null,
);
eq(
  "report-only: blank $0 utility row → none",
  reportOnlyKicker(row({ sales_count: null, sale_amt: 0 }), R),
  null,
);
eq(
  "report-only: blank row WITH money → sale",
  reportOnlyKicker(row({ sales_count: null, sale_amt: 8000 }), R)?.category,
  "card.sale",
);
// scoredCardKeys + the covered gate in buildMoneyCandidates.
{
  const soldCard = card({
    lead_name: "Smith, John",
    office_location: "San Diego",
    phone: "619-555-0001",
    source: "Canvass",
    pm: null,
    sale: "Sold",
  });
  const keys = scoredCardKeys([soldCard], R);
  eq("scoredCardKeys has the name key", keys.has("San Diego|n|smith john"), true);
  eq("scoredCardKeys has the phone key", keys.has("San Diego|p|6195550001"), true);
  eq(
    "a sit-only card still keys (covers the customer)",
    scoredCardKeys([card({ lead_name: "x", pm: "PM" })], R).size > 0,
    true,
  );

  // Covered report row (same customer as the sold block card) → NO report
  // kicker, just volume/bonus. The block card is the authority.
  const covRow = row({
    customer_name: "Smith, John (copy)",
    office: "San Diego",
    sale_amt: 10000,
    sales_count: "Sale",
  });
  const cov = buildMoneyCandidates([covRow], R, [], MID, keys).candidates;
  eq(
    "covered sale: no card.* kicker from the report",
    cov.some((c) => c.category.startsWith("card.")),
    false,
  );
  eq(
    "covered sale: still earns volume",
    cov.some((c) => c.category === "money.volume"),
    true,
  );

  // Report-only sale (not covered) → gets the kicker, FULL per rep.
  const onlyRow = row({
    customer_name: "Nguyen, Kim",
    office: "San Diego",
    sale_amt: 10000,
    sales_count: "Sale",
    reps: ["A", "B"],
  });
  const only = buildMoneyCandidates([onlyRow], R, [], MID, keys).candidates;
  const aKick = only.filter((c) => c.rep_name === "A" && c.category === "card.sale");
  eq("report-only sale: emits card.sale", aKick.length, 1);
  eq("report-only sale: full 5 to each rep (not split)", aKick[0]?.points, 5);
  eq(
    "report-only sale: both reps get it",
    only.filter((c) => c.category === "card.sale").length,
    2,
  );
  // and volume still splits
  const aVol = only.find((c) => c.rep_name === "A" && c.category === "money.volume");
  eq("report-only sale: volume still splits (10/2=5)", aVol?.points, 5);
}
// Name-order + no-phone dedup (the Edward/Mokan reload, owner 2026-10-02):
// the block card says "Ken and Katherine Mokan" with NO phone; the report
// says "Mokan, Ken & Katherine" with a phone. Order-sensitive name keys and
// the phone key both miss, so the report-only kicker used to stack on the
// block card's — double-counting the reload. The sorted-token tier must bind
// the two spellings so the report emits volume only, no second card.reload.
{
  const reloadCard = card({
    lead_name: "Ken and Katherine Mokan (copy) (copy)",
    office_location: "San Diego",
    phone: null,
    source: "Reload",
    pm: null,
    sale: "Reload",
  });
  const keys = scoredCardKeys([reloadCard], R);
  const reportRow = row({
    customer_name: "Mokan, Ken & Katherine (copy)",
    office: "San Diego",
    phone: "619-825-3779",
    sale_amt: 28500,
    sales_count: "Reload",
    reps: ["Edward Romero"],
  });
  const got = buildMoneyCandidates([reportRow], R, [], MID, keys).candidates;
  eq(
    "name-order reload: no second card.reload from the report",
    got.some((c) => c.category === "card.reload"),
    false,
  );
  eq(
    "name-order reload: report still earns volume",
    got.some((c) => c.category === "money.volume"),
    true,
  );
}
// Without a coveredKeys set, buildMoneyCandidates stays volume+bonus only.
eq(
  "no coveredKeys → no report kicker",
  buildMoneyCandidates([row({ sale_amt: 10000, sales_count: "Sale" })], R, [], MID).candidates.some(
    (c) => c.category.startsWith("card."),
  ),
  false,
);

// ---- 13. Volume at BLOCK PRICE — Shark Tank parity (owner 2026-10-02) ----
// A sold card counts its $/1k immediately at the Block price, through the SAME
// rule Shark Tank's pending money uses: buildPendingReportCheck (missing ≠
// false AND no corroborated report row) + the shared volumeSplit (saves
// included). The report row is the authority and the estimate drops the
// instant it corroborates the sale. New signature: (cards, reportRows, …).
{
  // Fresh sold card, $3,250, not in the book yet → 3.25 volume, one rep.
  const fresh = buildCardVolumeCandidates(
    [card({ sale: "Sold", pm: null, sale_price: 3250, lead_name: "Yakup Test" })],
    [],
    R,
    [],
    MID,
  );
  eq("block volume: fresh sold card emits one money.volume", fresh.length, 1);
  eq("block volume: $3,250 → 3.25", fresh[0]?.points, 3.25);
  eq("block volume: category is money.volume", fresh[0]?.category, "money.volume");
  eq("block volume: tagged block_price", fresh[0]?.meta.block_price, true);
  eq("block volume: sourced on the card (sit)", fresh[0]?.source_kind, "sit");
  eq(
    "block volume: label is the full deal price",
    fresh[0]?.meta.label,
    "$3,250 written · block price",
  );

  // Two reps split the block volume, same board formula as report volume.
  const twoRep = buildCardVolumeCandidates(
    [card({ sale: "Sold", pm: null, sale_price: 10000, reps: ["A", "B"] })],
    [],
    R,
    [],
    MID,
  );
  eq("block volume: 2-rep card → 2 rows", twoRep.length, 2);
  eq("block volume: $10k / 2 reps = 5 each", twoRep[0]?.points, 5);

  // Blank Sale Price scores nothing (never guessed), and an unsold sit too.
  eq(
    "block volume: blank price = nothing",
    buildCardVolumeCandidates([card({ sale: "Sold", pm: null, sale_price: null })], [], R, [], MID)
      .length,
    0,
  );
  eq(
    "block volume: unsold sit earns no volume",
    buildCardVolumeCandidates([card({ sale: null, pm: "PM", sale_price: 5000 })], [], R, [], MID)
      .length,
    0,
  );

  // The report is the authority: a report row corroborating by AMOUNT (the
  // Shark Tank pending check) suppresses the block estimate — no double count.
  eq(
    "block volume: report row (amount match) → suppressed",
    buildCardVolumeCandidates(
      [
        card({
          sale: "Sold",
          pm: null,
          sale_price: 9000,
          lead_name: "Jane Q Customer",
          office_location: "San Diego",
        }),
      ],
      [row({ customer_name: "Jane Q Customer", office: "San Diego", sale_amt: 9000 })],
      R,
      [],
      MID,
    ).length,
    0,
  );
  // A bare name hit with NO date/amount corroboration does NOT suppress — this
  // is exactly where the old key-only gate went behind Shark Tank.
  eq(
    "block volume: bare name hit (no corroboration) still counts",
    buildCardVolumeCandidates(
      [
        card({
          sale: "Sold",
          pm: null,
          sale_price: 9000,
          lead_name: "Jane Q Customer",
          office_location: "San Diego",
          card_date: "2026-10-06",
        }),
      ],
      [
        row({
          customer_name: "Jane Q Customer",
          office: "San Diego",
          sale_amt: 1234, // different amount
          date_sold: "2026-01-01", // far outside the date window
        }),
      ],
      R,
      [],
      MID,
    ).length,
    1,
  );

  // The sync's authoritative "it's in the book" stamp also suppresses it.
  eq(
    "block volume: missing_from_report=false → suppressed",
    buildCardVolumeCandidates(
      [card({ sale: "Sold", pm: null, sale_price: 9000, missing_from_report: false })],
      [],
      R,
      [],
      MID,
    ).length,
    0,
  );

  // Save parity: a landed Can/Save re-prices the deal — saver 50%, original
  // 50% — at the SAVE price, identical to Shark Tank's standings (volumeSplit).
  {
    const original = card({
      lead_name: "Save Me",
      office_location: "San Diego",
      phone: "6195550000",
      sale: "Sold",
      pm: null,
      wcc: "Cancelled",
      sale_price: 5000,
      reps: ["Orig"],
    });
    const saveCard = card({
      lead_name: "Save Me",
      office_location: "San Diego",
      phone: "6195550000",
      comments: "Can Save",
      sale: null,
      pm: null,
      sale_price: 8000,
      reps: ["Saver"],
    });
    const out = buildCardVolumeCandidates([original, saveCard], [], R, [], MID);
    const byRep = new Map(out.map((c) => [c.rep_name, c.points]));
    eq("save: two credits (saver + original)", out.length, 2);
    eq("save: saver gets 50% of $8k → 4", byRep.get("Saver"), 4);
    eq("save: original gets 50% of $8k → 4", byRep.get("Orig"), 4);
    eq("save: label is the re-priced total", out[0]?.meta.label, "$8,000 written · block price");
  }

  // Locks on the same month-end clock as every other pending point.
  eq(
    "block volume: locks after finalize",
    buildCardVolumeCandidates(
      [card({ sale: "Sold", pm: null, sale_price: 1000 })],
      [],
      R,
      [],
      "2026-11-04",
    )[0]?.status,
    "locked",
  );
}

// ---- 14. $3M TEAM GOAL counts live block volume (owner 2026-10-02) --------
// The team-goal bar used to read the monthly report only, so a sale sat a day
// behind the belt points until the Sales Report synced. liveBlockVolumeDollars
// adds the SAME uncovered sold cards the points count — through the shared
// pending rule (pendingCardDollars → buildPendingReportCheck) — each card's
// whole price once (team total), so the bar and the belt points never diverge.
{
  // Two fresh sold cards not yet in the book → their full prices, summed once
  // each regardless of rep count (a 2-rep card still adds its whole price).
  eq(
    "team goal: uncovered sold cards sum their full prices",
    liveBlockVolumeDollars(
      [
        card({ sale: "Sold", pm: null, sale_price: 3250, lead_name: "Yakup Test" }),
        card({ sale: "Sold", pm: null, sale_price: 10000, reps: ["A", "B"], lead_name: "Leo" }),
      ],
      [],
      R,
    ),
    13250,
  );

  // Blank price = $0 (never guessed); an unsold sit adds nothing.
  eq(
    "team goal: blank price and unsold sit add nothing",
    liveBlockVolumeDollars(
      [
        card({ sale: "Sold", pm: null, sale_price: null, lead_name: "No Price" }),
        card({ sale: null, pm: "PM", sale_price: 5000, lead_name: "Just A Sit" }),
      ],
      [],
      R,
    ),
    0,
  );

  // Once a report row corroborates the customer (amount match), the block
  // estimate drops (no double count) — the book's sale_amt is the authority.
  eq(
    "team goal: covered-by-report card is not added again",
    liveBlockVolumeDollars(
      [
        card({
          sale: "Sold",
          pm: null,
          sale_price: 9000,
          lead_name: "Jane Q Customer",
          office_location: "San Diego",
        }),
      ],
      [row({ customer_name: "Jane Q Customer", office: "San Diego", sale_amt: 9000 })],
      R,
    ),
    0,
  );

  // The sync's authoritative "in the book" stamp also drops the estimate.
  eq(
    "team goal: missing_from_report=false card is not added",
    liveBlockVolumeDollars(
      [card({ sale: "Sold", pm: null, sale_price: 9000, missing_from_report: false })],
      [],
      R,
    ),
    0,
  );
}

console.log(`checks run, ${fails.length} failure(s)`);
for (const f of fails) console.log("  FAIL " + f);
process.exit(fails.length === 0 ? 0 : 1);
