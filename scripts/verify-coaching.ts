/** Assertions for the coaching-flag math in src/lib/coaching.ts — run with
 *  `npm run verify:coaching`.
 *
 *  Pins the Phase 2 §4 contracts:
 *   · "Knocks plenty, converts low" = 300+ doors AND talk→lead under 4%,
 *   · "Not logging doors" = leads landing with implausibly few doors, and it
 *     OUTRANKS every other flag (bad data first),
 *   · "Converts well, knock more" = at/above team talk→lead on a real sample
 *     but doors/day under 75% of team,
 *   · tiny samples never get flagged — they're "On track",
 *   · team baseline is a pooled rate (Σ/Σ), not an average of ratios,
 *   · ride-along partners = top 3 converters with a real sample, self
 *     excluded. */
import {
  computeCoachingFlag,
  computeTeamBaseline,
  talkLeadRate,
  doorsPerDay,
  topConverters,
  RIDE_ALONG_MIN_DOORS,
  RIDE_ALONG_MAX_TALK_LEAD,
  type CoachingStats,
  type ConverterRow,
} from "../src/lib/coaching";

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

const s = (drs: number, tlk: number, ld: number, activeDays = 10): CoachingStats => ({
  drs,
  tlk,
  ld,
  activeDays,
});

// Team: 2000 doors / 20 days = 100 doors/day; 500 talks; 25 leads → 5% talk→lead.
const team = computeTeamBaseline([s(1200, 300, 15, 12), s(800, 200, 10, 8)]);
expectEq("team talk→lead pooled (25/500)", team.talkLead, 0.05);
expectEq("team doors/day pooled (2000/20)", team.doorsPerDay, 100);
expectEq("team talk rate pooled (500/2000)", team.talkRate, 0.25);

// ── thresholds ────────────────────────────────────────────────────────────────
expectEq("threshold: 300 doors", RIDE_ALONG_MIN_DOORS, 300);
expectEq("threshold: 4% talk→lead", RIDE_ALONG_MAX_TALK_LEAD, 0.04);

// The audit's Arturo pattern: 340 doors, 90 talks, 2 leads (2.2% talk→lead).
expectEq(
  "grinder converting low → ride_along",
  computeCoachingFlag(s(340, 90, 2), team).key,
  "ride_along",
);
// 299 doors never trips the ride-along even at 0% conversion.
expectEq(
  "299 doors is not 'knocks plenty'",
  computeCoachingFlag(s(299, 80, 0, 10), team).key,
  "on_track",
);
// 340 doors at exactly 4% is NOT "converts low" (strict <).
expectEq(
  "4.0% talk→lead escapes the ride-along",
  computeCoachingFlag(s(340, 100, 4), team).key,
  "on_track",
);

// Leads with barely any doors → not_logging, even when doors would
// otherwise read "fine" — and it outranks ride_along maths entirely.
expectEq(
  "leads w/o doors → not_logging",
  computeCoachingFlag(s(40, 20, 5), team).key,
  "not_logging",
);
expectEq("not_logging needs 3+ leads", computeCoachingFlag(s(40, 20, 2), team).key, "on_track");

// Converts well (8% ≥ max(4%, team 5%)) on a real sample, but 60 doors/day
// against the team's 100 → knock_more.
expectEq(
  "high conversion, low volume → knock_more",
  computeCoachingFlag(s(600, 150, 12, 10), team).key,
  "knock_more",
);
// Same rates at team-level volume (100/day ≥ 75% of team) → on_track.
expectEq(
  "high conversion at team volume → on_track",
  computeCoachingFlag(s(1000, 250, 20, 10), team).key,
  "on_track",
);
// Tiny sample (under 50 doors, no leads) is never judged.
expectEq("tiny sample → on_track", computeCoachingFlag(s(30, 10, 1), team).key, "on_track");

// ── rates ─────────────────────────────────────────────────────────────────────
expectEq("talk→lead guards tlk=0", talkLeadRate({ tlk: 0, ld: 5 }), 0);
expectEq("doors/day guards 0 days", doorsPerDay({ drs: 100, activeDays: 0 }), 0);

// ── ride-along partners ───────────────────────────────────────────────────────
const c = (id: string, tlk: number, ld: number): ConverterRow => ({
  id,
  name: id,
  drs: 500,
  tlk,
  ld,
  activeDays: 10,
});
const partners = topConverters(
  [
    c("arturo", 100, 10),
    c("kieran", 100, 8),
    c("logan", 100, 6),
    c("low", 100, 4),
    c("me", 100, 9),
  ],
  "me",
);
expectEq(
  "top 3 by talk→lead, self excluded",
  partners.map((p) => p.id),
  ["arturo", "kieran", "logan"],
);
expectEq(
  "thin samples never coach (29 talks)",
  topConverters([c("thin", 29, 10), c("real", 100, 5)]).map((p) => p.id),
  ["real"],
);

console.log(failures === 0 ? "\n✅ 0 failure(s)" : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
