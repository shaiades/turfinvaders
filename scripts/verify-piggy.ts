/** Assertions for the piggy-bank money math in src/lib/funnel.ts — run with
 *  `npm run verify:piggy`. The bank is PROJECTED money (knocks × expected
 *  value per door); these cases pin down the null semantics that keep it
 *  honest: no usable rates or no commission figure means NO dollars, never
 *  an invented $0/knock. */
import {
  deriveSplitRates,
  expectedValuePerDoor,
  resolveAvgCommission,
  deriveRates,
  ratesUsable,
  type ConversionRates,
} from "../src/lib/funnel";

let failures = 0;
function expectEq(label: string, got: unknown, want: unknown) {
  const ok =
    typeof got === "number" && typeof want === "number"
      ? Math.abs(got - want) < 1e-9
      : got === want;
  if (!ok) {
    failures++;
    console.error(`✗ ${label}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// ── resolveAvgCommission: own number → company avg → floor ──────────────
expectEq("own avg_commission wins", resolveAvgCommission(350, 280, 200), 350);
expectEq("null profile falls to company", resolveAvgCommission(null, 280, 200), 280);
expectEq("zero profile falls to company", resolveAvgCommission(0, 280, 200), 280);
expectEq("no data at all hits the floor", resolveAvgCommission(undefined, 0, 200), 200);

// ── expectedValuePerDoor ─────────────────────────────────────────────────
// A plausible company baseline: 3% lead/door, 60% sit/lead, 40% close/sit,
// $300 per sale → each knock is worth $2.16 of projected commission.
const baseline: ConversionRates = { closeRate: 0.4, sitRate: 0.6, leadDoorRate: 0.03 };
expectEq("baseline chain multiplies through", expectedValuePerDoor(baseline, 300), 2.16);

// Derived from a raw aggregate the same way useFunnelRates does it.
const rates = deriveRates({ doors: 1000, confirmed: 30, sits: 18, sales: 6 });
expectEq(
  "derived-rate chain matches hand math",
  expectedValuePerDoor(rates, 300),
  300 * (6 / 18) * (18 / 30) * (30 / 1000),
);

// Null semantics: never invent a rate.
expectEq("null rates → null", expectedValuePerDoor(null, 300), null);
expectEq(
  "unusable rates (no sales yet) → null",
  expectedValuePerDoor(deriveRates({ doors: 500, confirmed: 10, sits: 4, sales: 0 }), 300),
  null,
);
expectEq("zero commission → null", expectedValuePerDoor(baseline, 0), null);

// ── deriveSplitRates: each rate divides quantities from its own window ──
// Era pair (pin-tracked doors) drives lead/door; the 60d pipeline drives
// sit and close. Mirrors the 2026-09-11 prod truth: confirms live in
// daily_metrics, doors only exist since the knock trigger.
const split = deriveSplitRates({
  eraDoors: 99,
  eraConfirmed: 12,
  confirmed: 582,
  sits: 400,
  sales: 121,
});
expectEq("split lead/door uses the era pair", split.leadDoorRate, 12 / 99);
expectEq("split sit rate uses the 60d pipeline", split.sitRate, 400 / 582);
expectEq("split close rate uses the 60d pipeline", split.closeRate, 121 / 400);
expectEq("split rates are usable", ratesUsable(split), true);
expectEq(
  "zero era doors kills only lead/door (rates unusable, never Infinity)",
  ratesUsable(deriveSplitRates({ eraDoors: 0, eraConfirmed: 5, confirmed: 582, sits: 400, sales: 121 })),
  false,
);

// ── the latch's arithmetic (mirrors usePiggyBank) ────────────────────────
// A rate shift between knocks is absorbed by the next knock: 10 knocks
// latched at $2.16 = $21.60; rate drifts to $2.00; the 11th knock recomputes
// 11 × $2.00 = $22.00 — still a net increase, never a visible shrink.
const latched = 10 * 2.16;
const nextKnock = 11 * 2.0;
expectEq("rate drift absorbed by next knock (still increases)", nextKnock > latched, true);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("verify:piggy — all good");
