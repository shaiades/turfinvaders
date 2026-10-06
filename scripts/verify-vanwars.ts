/** Assertions for the Van Wars scoring in src/lib/vanwars.ts — run with
 *  `npm run verify:vanwars`.
 *
 *  Pins the contracts the street race must never drift on:
 *   · war points with the (1,2) defaults equal the pay engine's `pts`,
 *   · retuned sit/sale weights recompute correctly (non-sale sits = pts − 2·sal),
 *   · per-head mode lets a small crew out-rank a bigger one,
 *   · total mode ranks by the summed war points,
 *   · ties break on sit rate, and the crew grade comes through. */
import {
  DEFAULT_VANWARS_CONFIG,
  warPointsFor,
  resolveVanWarsConfig,
  buildVanWarStandings,
  type VanWarRowInput,
} from "../src/lib/vanwars";

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

// ── war points ──────────────────────────────────────────────────────────────
expectEq("defaults: war == pts (3 sits, 1 sale)", warPointsFor(4, 1), 4);
expectEq("defaults: war == pts (pure sits)", warPointsFor(3, 0), 3);
expectEq("defaults: empty", warPointsFor(0, 0), 0);
// Retuned (sit 1, sale 3): pts=5,sal=1 → nonSaleSits = 5 − 2 = 3 → 1·3 + 3·1 = 6.
expectEq(
  "retuned sale weight 3",
  warPointsFor(5, 1, { mode: "per_head", sitWeight: 1, saleWeight: 3 }),
  6,
);

// ── config coercion ───────────────────────────────────────────────────────
expectEq("resolve defaults from null", resolveVanWarsConfig(null), DEFAULT_VANWARS_CONFIG);
expectEq(
  "resolve a full row",
  resolveVanWarsConfig({ mode: "total", sit_weight: 2, sale_weight: 5 }),
  {
    mode: "total",
    sitWeight: 2,
    saleWeight: 5,
  },
);
expectEq(
  "resolve rejects bad weights",
  resolveVanWarsConfig({ mode: "per_head", sit_weight: 0, sale_weight: -3 }),
  {
    mode: "per_head",
    sitWeight: 1,
    saleWeight: 2,
  },
);

// ── standings: per-head lets a small crew win ───────────────────────────────
const rows: VanWarRowInput[] = [
  // Big crew: 2 knockers, warTotal 6, per-head 3.
  { teamName: "Vipers", teamColor: "#a", pts: 4, sal: 1, vol: 100, sitSits: 2, sitLeads: 4 },
  { teamName: "Vipers", teamColor: "#a", pts: 2, sal: 0, vol: 0, sitSits: 1, sitLeads: 2 },
  // Small crew: 1 knocker, warTotal 5, per-head 5.
  { teamName: "Night Owls", teamColor: "#b", pts: 5, sal: 2, vol: 200, sitSits: 3, sitLeads: 4 },
];
const perHead = buildVanWarStandings(rows, { mode: "per_head", sitWeight: 1, saleWeight: 2 });
expectEq("per-head: small crew #1", perHead[0].name, "Night Owls");
expectEq("per-head: small crew war 5", perHead[0].war, 5);
expectEq("per-head: big crew war 3", perHead[1].war, 3);
expectEq("per-head: big crew knockers 2", perHead[1].knockers, 2);

const total = buildVanWarStandings(rows, { mode: "total", sitWeight: 1, saleWeight: 2 });
expectEq("total: big crew #1 (war 6)", total[0].name, "Vipers");
expectEq("total: big crew war 6", total[0].war, 6);

// ── ties break on sit rate ──────────────────────────────────────────────────
const tie: VanWarRowInput[] = [
  { teamName: "Low Sit", teamColor: "#c", pts: 4, sal: 0, vol: 0, sitSits: 1, sitLeads: 4 }, // 25%
  { teamName: "High Sit", teamColor: "#d", pts: 4, sal: 0, vol: 0, sitSits: 3, sitLeads: 4 }, // 75%
];
const broke = buildVanWarStandings(tie, DEFAULT_VANWARS_CONFIG);
expectEq("tie: equal war, higher sit rate wins", broke[0].name, "High Sit");
expectEq("tie: grade comes through (S)", broke[0].sit.grade, "S");

console.log(failures === 0 ? "\n✅ 0 failure(s)" : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
