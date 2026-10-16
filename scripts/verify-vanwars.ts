/** Assertions for the Van Wars scoring in src/lib/vanwars.ts — run with
 *  `npm run verify:vanwars`.
 *
 *  Pins the contracts of the 2026-10-15 rework the street race must never
 *  drift on:
 *   · war score = leads SET per ACTIVE knocker (doors logged in range),
 *   · leads from inactive crew members count in the total, never the divisor,
 *   · the Unassigned (null team) bucket and the Confirmation desk never race,
 *   · a crew needs MIN_CREW_TO_RANK (3) active knockers to rank or win —
 *     smaller crews still appear, sorted after every ranked crew,
 *   · ties break on total leads, then funnel sit rate,
 *   · the crew sit grade comes through. */
import {
  MIN_CREW_TO_RANK,
  isActiveKnocker,
  isDeskCrew,
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

const knocker = (
  teamId: string | null,
  label: string,
  teamName: string | null,
  ld: number,
  drs: number,
  extra: Partial<VanWarRowInput> = {},
): VanWarRowInput => ({
  teamId,
  label,
  teamName,
  teamColor: "#abc",
  ld,
  drs,
  pts: 0,
  vol: 0,
  sitSits: 0,
  sitLeads: 0,
  ...extra,
});

// ── gates ────────────────────────────────────────────────────────────────────
expectEq("min crew to rank is 3", MIN_CREW_TO_RANK, 3);
expectEq("doors logged = active", isActiveKnocker(1), true);
expectEq("no doors = inactive", isActiveKnocker(0), false);
expectEq("Confirmation is the desk", isDeskCrew("Confirmation"), true);
expectEq("case-insensitive desk match", isDeskCrew("CONFIRMATION CREW"), true);
expectEq("regular vans race", isDeskCrew("Van 2"), false);
expectEq("null team name races", isDeskCrew(null), false);

// ── exclusions ───────────────────────────────────────────────────────────────
const excluded = buildVanWarStandings([
  knocker(null, "Unassigned", null, 9, 50), // no van — never races
  knocker("desk", "Confirmation", "Confirmation", 9, 50), // desk — never races
  knocker("v1", "Arturo", "Van 1", 2, 40),
]);
expectEq("unassigned + desk dropped", excluded.length, 1);
expectEq("the real van survives", excluded[0].name, "Arturo");

// ── war = leads per ACTIVE knocker ──────────────────────────────────────────
const perHead = buildVanWarStandings([
  // Van 1: 3 active knockers, 6 leads → war 2.0
  knocker("v1", "Arturo", "Van 1", 4, 120),
  knocker("v1", "Arturo", "Van 1", 2, 80),
  knocker("v1", "Arturo", "Van 1", 0, 60),
  // Van 2: 4 active knockers, 4 leads → war 1.0 (bigger crew, worse rate)
  knocker("v2", "Kieran", "Van 2", 1, 90),
  knocker("v2", "Kieran", "Van 2", 1, 90),
  knocker("v2", "Kieran", "Van 2", 1, 90),
  knocker("v2", "Kieran", "Van 2", 1, 90),
]);
expectEq("converting crew #1", perHead[0].name, "Arturo");
expectEq("war = 6 leads / 3 knockers", perHead[0].war, 2);
expectEq("crew total leads", perHead[0].lds, 6);
expectEq("bigger crew war 1.0", perHead[1].war, 1);
expectEq(
  "both crews ranked",
  perHead.map((s) => s.ranked),
  [true, true],
);

// ── inactive members: leads count, divisor doesn't ──────────────────────────
const bench = buildVanWarStandings([
  knocker("v1", "Arturo", "Van 1", 2, 50),
  knocker("v1", "Arturo", "Van 1", 2, 50),
  knocker("v1", "Arturo", "Van 1", 2, 50),
  // Set 3 leads but logged zero doors — counts in lds, not in knockers.
  knocker("v1", "Arturo", "Van 1", 3, 0),
]);
expectEq("bench leads still count", bench[0].lds, 9);
expectEq("bench rider not a knocker", bench[0].knockers, 3);
expectEq("war divides by active only", bench[0].war, 3);

// ── minimum crew: under 3 active knockers shows but can't rank ──────────────
const small = buildVanWarStandings([
  // 2 active knockers, monster rate — still unranked.
  knocker("duo", "Logan", "Van 3", 8, 100),
  knocker("duo", "Logan", "Van 3", 6, 100),
  // 3 active knockers, modest rate — ranked, so it sorts FIRST.
  knocker("full", "Cris", "Van 4", 3, 80),
  knocker("full", "Cris", "Van 4", 2, 80),
  knocker("full", "Cris", "Van 4", 1, 80),
]);
expectEq("full crew ranks #1", small[0].name, "Cris");
expectEq("full crew is ranked", small[0].ranked, true);
expectEq("duo shows but unranked", small[1].ranked, false);
expectEq("duo keeps its score for display", small[1].war, 7);

// ── ties: total leads, then sit rate ────────────────────────────────────────
const tie = buildVanWarStandings([
  // Both crews war 1.0; A has 3 total leads, B has 6 → B wins on total leads.
  knocker("a", "A", "Van A", 1, 10),
  knocker("a", "A", "Van A", 1, 10),
  knocker("a", "A", "Van A", 1, 10),
  knocker("b", "B", "Van B", 1, 10),
  knocker("b", "B", "Van B", 1, 10),
  knocker("b", "B", "Van B", 1, 10),
  knocker("b", "B", "Van B", 1, 10),
  knocker("b", "B", "Van B", 1, 10),
  knocker("b", "B", "Van B", 1, 10),
]);
expectEq("equal war: more total leads wins", tie[0].name, "B");

const sitTie = buildVanWarStandings([
  // war and total leads equal; sit rate 75% vs 25% breaks it.
  knocker("hi", "High Sit", "Van H", 2, 10, { sitSits: 3, sitLeads: 4 }),
  knocker("hi", "High Sit", "Van H", 1, 10),
  knocker("hi", "High Sit", "Van H", 1, 10),
  knocker("lo", "Low Sit", "Van L", 2, 10, { sitSits: 1, sitLeads: 4 }),
  knocker("lo", "Low Sit", "Van L", 1, 10),
  knocker("lo", "Low Sit", "Van L", 1, 10),
]);
expectEq("full tie: higher sit rate wins", sitTie[0].name, "High Sit");
expectEq("grade comes through (S)", sitTie[0].sit.grade, "S");

console.log(failures === 0 ? "\n✅ 0 failure(s)" : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
