/** Assertions for the "next dollar" engine in src/lib/money-thresholds.ts —
 *  run with `npm run verify:money`.
 *
 *  Pins the Phase 4 §2 ladder against the REAL pay constants (src/lib/pay.ts
 *  mirrors calc_weekly_paycheck v11):
 *   · tiers at 3 pts ($30/hr) and 7 pts ($35/hr), monster at 10 pts ($500),
 *   · sit bonus $50 from the 4th weekly sit ($75 for Sr. Gold+),
 *   · the $1,500 volume chase takes over within $10K of the next $100K step,
 *   · "one away" (gold + shake) at exactly 1 pt / 1 sit / inside the window,
 *   · progress rings measure the current segment, never the whole ladder. */
import { nextMoneyTarget, VOLUME_NEAR_WINDOW } from "../src/lib/money-thresholds";

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

const t = (
  weekPts: number,
  weekSits: number,
  monthVolume: number | null = null,
  rank: string | null = null,
) => nextMoneyTarget({ weekPts, weekSits, monthVolume, rank });

// ── tier ladder ───────────────────────────────────────────────────────────────
expectEq("0 pts → chase $30/hr", t(0, 0).kind, "tier_mid");
expectEq("0 pts needs 3", t(0, 0).needLabel, "3 pts");
expectEq("2 pts → ONE away, gold", t(2, 2).oneAway, true);
expectEq("2 pts prize", t(2, 2).prizeLabel, "$30/hr");
expectEq("3 pts → chase $35/hr", t(3, 3).kind, "tier_top");
expectEq("6 pts → one from $35", t(6, 5).oneAway, true);
expectEq("6 pts ring = 3/4 of the segment", t(6, 5).progress, 0.75);
expectEq("7 pts → chase the monster", t(7, 6).kind, "monster");
expectEq("9 pts → one from $500", t(9, 7).oneAway, true);
expectEq("9 pts prize", t(9, 7).prizeLabel, "$500 monster");

// ── past the monster: every sit is cash ──────────────────────────────────────
expectEq("10 pts, 8 sits → next sit pays", t(10, 8).kind, "sit_bonus");
expectEq("default sit bonus $50", t(10, 8).prizeLabel, "+$50");
expectEq("Sr. Gold sit bonus $75", t(10, 8, null, "Sr. Gold").prizeLabel, "+$75");
expectEq("rate-locked rank still shows sit cash", t(12, 9, null, "Captain").prizeLabel, "+$75");
expectEq("next-sit chip is always one away", t(10, 8).oneAway, true);

// ── the $1,500 chase overrides everything when close ─────────────────────────
expectEq("window matches the push trigger", VOLUME_NEAR_WINDOW, 10_000);
expectEq("$92K month → chase the $1,500", t(1, 1, 92_000).kind, "volume");
expectEq("$92K needs $8K", t(1, 1, 92_000).needLabel, "$8K");
expectEq("$92K is gold", t(1, 1, 92_000).oneAway, true);
expectEq("$192K → second chest chase", t(1, 1, 192_000).kind, "volume");
expectEq("$50K month → volume NOT close, tiers rule", t(1, 1, 50_000).kind, "tier_mid");
expectEq("no volume yet → tiers rule", t(1, 1, 0).kind, "tier_mid");
expectEq("exactly on the step → not 'close to' the next", t(4, 3, 100_000).kind, "tier_top");

console.log(failures === 0 ? "\n✅ 0 failure(s)" : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
