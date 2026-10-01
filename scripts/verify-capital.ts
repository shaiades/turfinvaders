// Capital-math verification suite (God Mode v3, owner 2026-10-01): every
// Path-to-$100M formula, speed-of-cash stat, matched-span delta, completion
// curve, and concentration bucket as an executable check.
// Run: npm run verify:capital    Pure module in, assertions out.

import {
  agingBuckets,
  buildCompletionCurve,
  daysBetween,
  financingMix,
  leverSensitivities,
  matchedSpanCollected,
  median,
  projectFromCurve,
  slipStats,
  topShare,
} from "../src/lib/capital";

const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = Math.abs(Number(got ?? NaN) - Number(want ?? NaN)) < 1e-6 || got === want;
  if (!ok) fails.push(`${label}: got ${String(got)}, want ${String(want)}`);
};
const near = (label: string, got: number, want: number, tol = 0.5) => {
  if (Math.abs(got - want) > tol) fails.push(`${label}: got ${got}, want ~${want}`);
};

// ---- 1. Lever sensitivities ----------------------------------------------
{
  // Round numbers so every row is hand-checkable:
  // perDoor = 0.04 × 0.5 × 0.25 × 20000 × 0.9 = $90/door
  const i = {
    annualGoal: 100_000_000,
    doorsPerDay: 400,
    workingDaysPerYear: 300,
    leadPerDoor: 0.04,
    sitRate: 0.5,
    closeRate: 0.25,
    grossTicket: 20_000,
    cancelRate: 0.1,
    medianVanLeadsPerMonth: 100,
    annualSits: 2_400,
    annualSold: 600,
    annualGrossBook: 13_000_000,
  };
  const { modeledNetPerYear, rows } = leverSensitivities(i);
  eq("lever: modeled net", modeledNetPerYear, 400 * 300 * 90); // $10.8M
  const row = (k: string) => rows.find((r) => r.key === k)!;
  near("lever: doors/day needed", row("doors").figure, 100_000_000 / (300 * 90), 0.01); // ≈3703.7
  eq("lever: doors gap $", row("doors").dollars, 100_000_000 - 10_800_000);
  eq("lever: +1pt close", row("close").dollars, 2_400 * 0.01 * 20_000 * 0.9); // $432K
  eq("lever: ticket +1K", row("ticket").dollars, 600 * 1000 * 0.9); // $540K
  eq("lever: cancel at 10% is exhausted", row("cancel").dollars, 0);
  eq("lever: +1 van", row("van").dollars, 100 * 12 * 0.5 * 0.25 * 20_000 * 0.9); // $2.7M
  const hot = leverSensitivities({ ...i, cancelRate: 0.158 });
  near(
    "lever: cancel 15.8→10",
    hot.rows.find((r) => r.key === "cancel")!.dollars,
    13_000_000 * 0.058,
    1,
  );
}

// ---- 2. Speed of cash ------------------------------------------------------
eq("days: simple", daysBetween("2026-09-01", "2026-09-10"), 9);
eq("days: negative (early)", daysBetween("2026-09-10", "2026-09-08"), -2);
eq("median: even set", median([1, 3, 5, 7]), 4);
eq("median: empty", median([]), null);
{
  const rows = [
    {
      planned_amount: 100,
      actual_amount: 100,
      anticipated_date: "2026-09-01",
      collected_date: "2026-09-10",
    }, // +9
    {
      planned_amount: 100,
      actual_amount: 100,
      anticipated_date: "2026-09-05",
      collected_date: "2026-09-04",
    }, // -1
    {
      planned_amount: 100,
      actual_amount: 100,
      anticipated_date: "2026-09-01",
      collected_date: "2026-09-04",
    }, // +3
    // Unsettled / undated rows never teach slip:
    {
      planned_amount: 100,
      actual_amount: 40,
      anticipated_date: "2026-09-01",
      collected_date: "2026-09-02",
    },
    {
      planned_amount: 100,
      actual_amount: 100,
      anticipated_date: null,
      collected_date: "2026-09-02",
    },
  ];
  const s = slipStats(rows);
  eq("slip: count", s.count, 3);
  eq("slip: median", s.medianDays, 3);

  const aging = agingBuckets(
    [
      {
        planned_amount: 500,
        actual_amount: 100,
        anticipated_date: "2026-09-20",
        collected_date: null,
      }, // 10d late → 0-30
      {
        planned_amount: 300,
        actual_amount: 0,
        anticipated_date: "2026-08-15",
        collected_date: null,
      }, // 46d → 31-60
      {
        planned_amount: 900,
        actual_amount: 200,
        anticipated_date: "2026-06-01",
        collected_date: null,
      }, // 121d → 61+
      {
        planned_amount: 100,
        actual_amount: 100,
        anticipated_date: "2026-01-01",
        collected_date: null,
      }, // settled
      {
        planned_amount: 100,
        actual_amount: 0,
        anticipated_date: "2026-10-15",
        collected_date: null,
      }, // not yet due
    ],
    "2026-09-30",
  );
  eq("aging: 0-30", aging.b0_30, 400);
  eq("aging: 31-60", aging.b31_60, 300);
  eq("aging: 61+", aging.b61, 700);
}

// ---- 3. Matched-span deltas (the MoM bug) ----------------------------------
{
  const aug = [
    { actual_amount: 100, collected_date: "2026-08-05" },
    { actual_amount: 200, collected_date: "2026-08-20" },
    { actual_amount: 50, collected_date: null }, // undated counts from day 1
  ];
  eq("span: through day 10", matchedSpanCollected(aug, "2026-08-01", 10), 150);
  eq("span: through day 31", matchedSpanCollected(aug, "2026-08-01", 31), 350);
  // Feb cap: day 31 clamps to the month's real end.
  eq(
    "span: short month clamps",
    matchedSpanCollected([{ actual_amount: 10, collected_date: "2026-02-28" }], "2026-02-01", 31),
    10,
  );
}

// ---- 4. Completion curve ----------------------------------------------------
{
  // 7 identical months: half the money lands day 10, the rest day 20.
  const rows = Array.from({ length: 7 }, (_, m) => {
    const month = `2026-0${m + 1}-01`.slice(0, 10);
    return [
      { collection_month: month, actual_amount: 500, collected_date: `${month.slice(0, 8)}10` },
      { collection_month: month, actual_amount: 500, collected_date: `${month.slice(0, 8)}20` },
    ];
  }).flat();
  const curve = buildCompletionCurve(rows)!;
  eq("curve: exists with ≥6 months", curve === null, false);
  eq("curve: day 9 fraction", curve[8], 0);
  eq("curve: day 10 fraction", curve[9], 0.5);
  eq("curve: day 31 fraction", curve[30], 1);
  eq("curve: projection at day 10", projectFromCurve(700_000, 10, curve), 1_400_000);
  eq("curve: floor stops absurd day-1 projections", projectFromCurve(1000, 1, curve), 1000 / 0.05);
  eq("curve: too little history → null", buildCompletionCurve(rows.slice(0, 6)), null);
}

// ---- 5. Financing mix --------------------------------------------------------
{
  const mix = financingMix([
    { actual_amount: 500, payment_type: "Service Finance" },
    { actual_amount: 100, payment_type: "service finance" },
    { actual_amount: 200, payment_type: "Check" },
    { actual_amount: 100, payment_type: "Cash" },
    { actual_amount: 50, payment_type: "Synchrony, Check" }, // comma → Mixed
    { actual_amount: 50, payment_type: null },
    { actual_amount: 0, payment_type: "GAF" }, // $0 ignored
  ]);
  const b = (l: string) => mix.buckets.find((x) => x.label === l)?.amount;
  eq("mix: lender normalized+merged", b("Service Finance"), 600);
  eq("mix: cash-like merged", b("Cash/Check/Card"), 300);
  eq("mix: comma → Mixed", b("Mixed"), 50);
  eq("mix: unlabeled", b("Unlabeled"), 50);
  near("mix: top lender share", mix.topLenderShare, 600 / 1000, 0.001);
  eq("mix: top lender label", mix.topLenderLabel, "Service Finance");
}

// ---- 6. Top share -------------------------------------------------------------
{
  const t = topShare(
    [
      { name: "A", amount: 400 },
      { name: "B", amount: 300 },
      { name: "C", amount: 100 },
    ],
    1000, // denominator includes $200 of repless revenue
    2,
  );
  near("topShare: share", t.share, 0.7, 0.001);
  eq("topShare: names", t.names.join(","), "A,B");
}

console.log(`checks run, ${fails.length} failure(s)`);
for (const f of fails) console.log("  FAIL " + f);
process.exit(fails.length === 0 ? 0 : 1);
