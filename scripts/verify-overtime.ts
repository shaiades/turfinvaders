/** Assertions for the CA overtime split mirrored in src/lib/pay.ts —
 *  run with `npm run verify:overtime`. These cases document the intended
 *  behavior of calc_weekly_paycheck v6; if the SQL changes, change pay.ts
 *  and these expectations in the same commit. */
import { splitWeekHours, overtimePremiumPay } from "../src/lib/pay";

let failures = 0;
function expectSplit(
  label: string,
  days: number[],
  want: { reg: number; ot: number; dt: number },
) {
  const got = splitWeekHours(days);
  const ok =
    Math.abs(got.reg - want.reg) < 1e-9 &&
    Math.abs(got.ot - want.ot) < 1e-9 &&
    Math.abs(got.dt - want.dt) < 1e-9;
  if (!ok) {
    failures++;
    console.error(`✗ ${label}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// Plain week, no OT: 5 × 7.5h
expectSplit("five 7.5h days", [7.5, 7.5, 7.5, 7.5, 7.5], { reg: 37.5, ot: 0, dt: 0 });

// Daily OT: one 10h day → 8 reg + 2 OT
expectSplit("one 10h day", [10], { reg: 8, ot: 2, dt: 0 });

// Daily DT: one 13h day → 8 reg + 4 OT + 1 DT
expectSplit("one 13h day", [13], { reg: 8, ot: 4, dt: 1 });

// The old auto-close shape: 7am–6pm (11h) five days — daily OT every day
expectSplit(
  "five 11h days",
  [11, 11, 11, 11, 11],
  { reg: 40, ot: 15, dt: 0 },
);

// Weekly OT without daily OT: six 7h days = 42h → 40 reg + 2 OT
expectSplit("six 7h days", [7, 7, 7, 7, 7, 7], { reg: 40, ot: 2, dt: 0 });

// No pyramiding: five 9h + one 5h = 50h worked; daily OT takes 5, weekly
// takes the straight-time excess only (45 - 40 = 5) → 40 reg, 10 OT.
expectSplit(
  "five 9h days + 5h Saturday",
  [9, 9, 9, 9, 9, 5],
  { reg: 40, ot: 10, dt: 0 },
);

// 7th consecutive day: all seven worked — Sunday 9h = 8 OT + 1 DT, and the
// 44 straight-time hours (5×8 + 4) shed their weekly excess into OT too.
expectSplit(
  "seven days, Sunday 9h",
  [8, 8, 8, 8, 8, 4, 9],
  { reg: 40, ot: 8 + 4, dt: 1 },
);

// A 6-day week where Sunday is idle never triggers the 7th-day rule
expectSplit(
  "six days + idle Sunday",
  [8, 8, 8, 8, 8, 8, 0],
  { reg: 40, ot: 8, dt: 0 },
);

// Premium math: $18/hr, 2 OT hours, no bonuses/commission → 0.5×18×2 = $18
{
  const prem = overtimePremiumPay({ reg: 40, ot: 2, dt: 0 }, 18, 0, 0);
  if (Math.abs(prem - 18) > 1e-9) {
    failures++;
    console.error(`✗ hourly premium: want 18 got ${prem}`);
  } else console.log("✓ hourly premium");
}

// Alvarado flat-sum: $100 sit bonus over 40 non-OT hours = $2.50/hr → 1.5 ×
// 2.50 × 2 OT hours = $7.50 premium on the bonus alone.
{
  const prem = overtimePremiumPay({ reg: 40, ot: 2, dt: 0 }, 18, 100, 0);
  const want = 18 + 7.5;
  if (Math.abs(prem - want) > 1e-9) {
    failures++;
    console.error(`✗ flat-sum premium: want ${want} got ${prem}`);
  } else console.log("✓ flat-sum premium (Alvarado)");
}

// Commission: $420 over 42 total hours = $10/hr → 0.5 × 10 × 2 OT = $10.
{
  const prem = overtimePremiumPay({ reg: 40, ot: 2, dt: 0 }, 18, 0, 420);
  const want = 18 + 10;
  if (Math.abs(prem - want) > 1e-9) {
    failures++;
    console.error(`✗ commission premium: want ${want} got ${prem}`);
  } else console.log("✓ commission premium (DLSE 49.2.4)");
}

if (failures > 0) {
  console.error(`\n${failures} overtime assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll overtime assertions pass.");
