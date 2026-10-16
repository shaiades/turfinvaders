/** Assertions for the arcade ladder's ranking + bounty scoring in
 *  src/lib/arcade-rank.ts — run with `npm run verify:arcade-today`.
 *
 *  Pins the 2026-10-15 conversion-audit contracts:
 *   · TODAY ranks by leads set today → conversations → doors → points —
 *     a setter whose sits credit to tomorrow's appointment must NOT show 0,
 *   · Week/Month keep the points → $ → leads → doors order,
 *   · a bounty pays its multiplier only to leads set INSIDE the window,
 *   · overlapping bounties never stack (best single multiplier wins),
 *   · outside every window (or with a bogus multiplier) the answer is 1. */
import {
  dayLadderCompare,
  rangeLadderCompare,
  bestBountyMultiplier,
  type RankableRow,
} from "../src/lib/arcade-rank";

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

const row = (name: string, r: Partial<RankableRow>): RankableRow & { name: string } => ({
  name,
  pts: 0,
  vol: 0,
  lds: 0,
  ld: 0,
  drs: 0,
  tlk: 0,
  ...r,
});

// ── Today: the setter out-ranks the appointment-day points ───────────────────
// The audit's Arturo case: 10 leads set today, 0 points (his sits credit to
// the appointment day) vs a closer holding 3 points from leads set last week.
const setter = row("setter", { ld: 10, tlk: 40, drs: 170, pts: 0 });
const closer = row("closer", { ld: 0, tlk: 5, drs: 20, pts: 3, vol: 9000 });
expectEq(
  "today: leads set beat appointment-day points",
  [setter, closer].sort(dayLadderCompare)[0].name,
  "setter",
);
expectEq("week: points still rule", [setter, closer].sort(rangeLadderCompare)[0].name, "closer");

// Tiebreaks: equal leads → conversations; equal there too → doors.
const talker = row("talker", { ld: 2, tlk: 30, drs: 100 });
const grinder = row("grinder", { ld: 2, tlk: 12, drs: 300 });
expectEq(
  "today tie: conversations break it",
  [grinder, talker].sort(dayLadderCompare)[0].name,
  "talker",
);
const doorsA = row("doorsA", { ld: 2, tlk: 12, drs: 300 });
const doorsB = row("doorsB", { ld: 2, tlk: 12, drs: 100 });
expectEq("today tie: then doors", [doorsB, doorsA].sort(dayLadderCompare)[0].name, "doorsA");

// ── Bounties: window membership on the SET timestamp ─────────────────────────
const noon = Date.parse("2026-10-15T19:00:00Z"); // noon PT
const two = { startMs: noon, endMs: noon + 2 * 3_600_000, mult: 2 };
const three = { startMs: noon + 3_600_000, endMs: noon + 2 * 3_600_000, mult: 3 };
expectEq("inside the window → 2×", bestBountyMultiplier(noon + 60_000, [two]), 2);
expectEq("before the window → 1×", bestBountyMultiplier(noon - 60_000, [two]), 1);
expectEq("at ends_at → expired (half-open)", bestBountyMultiplier(two.endMs, [two]), 1);
expectEq(
  "overlap never stacks: best single wins",
  bestBountyMultiplier(noon + 90 * 60_000, [two, three]),
  3,
);
expectEq("no bounties → 1×", bestBountyMultiplier(noon, []), 1);
expectEq(
  "bogus multiplier can't shrink points",
  bestBountyMultiplier(noon + 60_000, [{ ...two, mult: 0.5 }]),
  1,
);

console.log(failures === 0 ? "\n✅ 0 failure(s)" : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
