/** Assertions for the sales-rep volume-goal math in src/lib/rep-goals.ts —
 *  run with `npm run verify:repgoals`. Pins down the null semantics that
 *  keep the tab honest: thin data means NO tiles, never an invented rate,
 *  and the take-home line is PROJECTED playbook math (~8% of volume). */
import {
  deriveRepRates,
  resolveRepRates,
  backSolveVolumeGoal,
  projectedPlaybookTakeHome,
  PLAYBOOK_PROFIT_PCT,
  PLAYBOOK_COMMISSION_PCT,
  type RepRates,
} from "../src/lib/rep-goals";

let failures = 0;
function expectEq(label: string, got: unknown, want: unknown) {
  const ok =
    typeof got === "number" && typeof want === "number"
      ? Math.abs(got - want) < 1e-9
      : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`✗ ${label}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

const solid = { sold: 3, reloads: 1, revenue: 40_000, sitPct: 0.5, closePct: 0.4 };

// ── deriveRepRates: gating ───────────────────────────────────────────────
expectEq("null input → null", deriveRepRates(null), null);
expectEq("zero sales → null", deriveRepRates({ ...solid, sold: 0, reloads: 0 }), null);
expectEq("zero revenue → null", deriveRepRates({ ...solid, revenue: 0 }), null);
expectEq("null sitPct → null", deriveRepRates({ ...solid, sitPct: null }), null);
expectEq("zero sitPct → null", deriveRepRates({ ...solid, sitPct: 0 }), null);
expectEq("null closePct → null", deriveRepRates({ ...solid, closePct: null }), null);
expectEq("zero closePct → null", deriveRepRates({ ...solid, closePct: 0 }), null);

const derived = deriveRepRates(solid);
expectEq("avgDealSize = revenue / (sold+reloads)", derived?.avgDealSize, 10_000);
expectEq("sitPct carried through", derived?.sitPct, 0.5);
expectEq("closePct carried through", derived?.closePct, 0.4);

// ── resolveRepRates: fallback ladder self → company → null ──────────────
const company = { sold: 20, reloads: 4, revenue: 360_000, sitPct: 0.6, closePct: 0.5 };
expectEq("self wins when usable", resolveRepRates(solid, company)?.source, "self");
expectEq(
  "company fallback when self thin",
  resolveRepRates({ ...solid, sold: 0, reloads: 0 }, company)?.source,
  "company",
);
expectEq("company fallback avgDealSize", resolveRepRates(null, company)?.rates.avgDealSize, 15_000);
expectEq("both thin → null", resolveRepRates(null, { ...company, revenue: 0 }), null);

// ── backSolveVolumeGoal ──────────────────────────────────────────────────
const rates: RepRates = { sitPct: 0.5, closePct: 0.4, avgDealSize: 10_000 };
const solve = backSolveVolumeGoal({ remainingVolume: 20_000, rates });
expectEq("salesNeeded = remaining/avgDeal", solve?.salesNeeded, 2);
expectEq("sitsNeeded = sales/closePct", solve?.sitsNeeded, 5);
expectEq("apptsNeeded = sits/sitPct", solve?.apptsNeeded, 10);
expectEq("goal met (remaining 0) → null", backSolveVolumeGoal({ remainingVolume: 0, rates }), null);
expectEq(
  "over goal (remaining < 0) → null",
  backSolveVolumeGoal({ remainingVolume: -5_000, rates }),
  null,
);
expectEq("no rates → null", backSolveVolumeGoal({ remainingVolume: 20_000, rates: null }), null);

// ── projected playbook take-home (~8% of volume, and ONLY that) ─────────
expectEq("playbook constants ≈ 8%", PLAYBOOK_PROFIT_PCT * PLAYBOOK_COMMISSION_PCT, 0.08);
expectEq("projection of $20k volume", projectedPlaybookTakeHome(20_000), 1_600);
expectEq("projection of $0", projectedPlaybookTakeHome(0), 0);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll rep-goals assertions passed.");
