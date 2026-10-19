/** Assertions for the Dial Run vocabulary in src/lib/dialer.ts — run with
 *  `npm run verify:dialer`.
 *
 *  Pins the disposition→daily_logs delta table against the
 *  bump_daily_log_from_call trigger (migration 20261101120000) and the combo
 *  rule against ActiveRun's registerResult semantics. If the trigger's CASE
 *  arms change, this file and dialer.ts change together. */
import {
  CALL_COUNTER_DELTAS,
  CALL_DISPOSITIONS,
  CALL_RESULTS,
  CALL_TALK_TYPES,
  isCallDisposition,
  nextCombo,
} from "../src/lib/dialer";

let failures = 0;
function ok(label: string, got: unknown, want: unknown) {
  if (got !== want) {
    failures++;
    console.error(`✗ ${label}: want ${String(want)} got ${String(got)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// Every call is a dial, and a dial IS a knock (owner mandate 2026-10-19).
for (const d of CALL_DISPOSITIONS) {
  ok(`${d} counts exactly one door`, CALL_COUNTER_DELTAS[d].doors_knocked, 1);
}

// The trigger's conversation list: talked_to / go_back / lead / not_interested.
ok("bare dial is not a talk", CALL_COUNTER_DELTAS.knock.people_talked_to, 0);
ok("no answer is not a talk", CALL_COUNTER_DELTAS.not_home.people_talked_to, 0);
ok("talked_to counts a talk", CALL_COUNTER_DELTAS.talked_to.people_talked_to, 1);
ok("callback counts a talk", CALL_COUNTER_DELTAS.go_back.people_talked_to, 1);
ok("lead counts a talk", CALL_COUNTER_DELTAS.lead.people_talked_to, 1);
ok("not_interested counts a talk", CALL_COUNTER_DELTAS.not_interested.people_talked_to, 1);

// Bucket columns.
ok("not_interested fills its bucket", CALL_COUNTER_DELTAS.not_interested.not_interested, 1);
ok("no answer fills not_home", CALL_COUNTER_DELTAS.not_home.not_home, 1);
ok("lead never bumps not_home", CALL_COUNTER_DELTAS.lead.not_home, 0);

// Talk set drives combo + mystery-drop eligibility and must match the delta
// table — one source of truth, verified from both sides.
for (const d of CALL_DISPOSITIONS) {
  ok(
    `${d} talk-set membership matches delta table`,
    CALL_TALK_TYPES.has(d),
    CALL_COUNTER_DELTAS[d].people_talked_to === 1,
  );
}

// Combo semantics: conversations chain, a no-answer resets, and a bare dial
// holds the streak (its outcome isn't known yet).
ok("combo chains on a talk", nextCombo(2, "talked_to"), 3);
ok("combo chains on a lead", nextCombo(4, "lead"), 5);
ok("no answer breaks the combo", nextCombo(5, "not_home"), 0);
ok("bare dial holds the combo", nextCombo(3, "knock"), 3);

// Chip bar: the five owner-picked outcomes, no door-only results, no bare dial.
ok("five outcome chips", CALL_RESULTS.length, 5);
ok(
  "chips exclude bare dial",
  CALL_RESULTS.some((r) => (r.type as string) === "knock"),
  false,
);
ok(
  "chips exclude renter/appt (door-only)",
  CALL_RESULTS.some((r) => ["renter", "appt"].includes(r.type as string)),
  false,
);

// Guard helper.
ok("renter is not a call disposition", isCallDisposition("renter"), false);
ok("lead is a call disposition", isCallDisposition("lead"), true);

console.log(failures === 0 ? "\n✅ 0 failure(s)" : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
