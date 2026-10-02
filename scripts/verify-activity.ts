/** Assertions for the Tidal Activity Test scorer in src/lib/activity-test.ts
 *  — run with `npm run verify:activity`. The gold standard is the Google
 *  Form's OWN grading of the 10 round-1 responses (Oct 2026): the scorer
 *  must reproduce every one of those scores from the raw answers, or the
 *  rep card / reveal / leadership board would disagree with the seeded
 *  numbers (never-invent-numbers). Also pins the structural invariants:
 *  points sum to exactly 30, reverse-scored habits score on "no", and
 *  unanswered means incorrect — never NaN, never a crash. */
import {
  ACTIVITY_QUESTIONS,
  HABITS,
  MAX_SCORE,
  PILLAR_ORDER,
} from "../src/data/activity-test-content";
import {
  BOSS_NAMES,
  TEST_TIERS,
  claimedJipVisitsPerWeek,
  nextTier,
  scoreActivityTest,
  tierForScore,
  type ActivityAnswers,
} from "../src/lib/activity-test";

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

// ── structure ────────────────────────────────────────────────────────────
expectEq("19 habits", HABITS.length, 19);
expectEq("3 activity questions", ACTIVITY_QUESTIONS.length, 3);
expectEq("habit keys unique", new Set(HABITS.map((h) => h.key)).size, 19);
expectEq(
  "activity keys unique + disjoint from habits",
  new Set([...HABITS.map((h) => h.key), ...ACTIVITY_QUESTIONS.map((q) => q.key)]).size,
  22,
);
const gridPoints = HABITS.reduce((s, h) => s + h.points, 0);
const activityPoints = ACTIVITY_QUESTIONS.reduce((s, q) => s + q.points, 0);
expectEq("grid points = 24", gridPoints, 24);
expectEq("activity points = 6", activityPoints, 6);
expectEq("total = MAX_SCORE", gridPoints + activityPoints, MAX_SCORE);
expectEq(
  "3 reverse-scored habits",
  HABITS.filter((h) => h.correctAnswer === "no")
    .map((h) => h.key)
    .sort(),
  ["eat_out_every_day", "go_home_between_leads", "saturday_hungover"],
);
expectEq(
  "reverse-scored habits carry no lever note (direction leak)",
  HABITS.filter((h) => h.correctAnswer === "no").every((h) => h.leverNote === ""),
  true,
);
expectEq(
  "every activity option set contains its correct set",
  ACTIVITY_QUESTIONS.every((q) => q.correct.every((c) => q.options.includes(c))),
  true,
);
expectEq(
  "a boss name for every habit",
  HABITS.every((h) => !!BOSS_NAMES[h.key]),
  true,
);
expectEq(
  "tiers cover 0..30 with no gaps",
  TEST_TIERS.every((t, i) => (i === 0 ? t.min === 0 : t.min === TEST_TIERS[i - 1].max + 1)) &&
    TEST_TIERS[TEST_TIERS.length - 1].max === MAX_SCORE,
  true,
);

// ── scorer basics ────────────────────────────────────────────────────────
const perfect: ActivityAnswers = Object.fromEntries([
  ...HABITS.map((h) => [h.key, h.correctAnswer]),
  ...ACTIVITY_QUESTIONS.map((q) => [q.key, q.correct[0]]),
]);
expectEq("perfect sheet = 30", scoreActivityTest(perfect).score, MAX_SCORE);
expectEq("empty sheet = 0", scoreActivityTest({}).score, 0);
expectEq("null sheet = 0, all missed", scoreActivityTest(null).missed.length, 19);
expectEq("undefined sheet never NaN", Number.isNaN(scoreActivityTest(undefined).score), false);
expectEq("reverse habit scores on no", scoreActivityTest({ eat_out_every_day: "no" }).score, 1);
expectEq("reverse habit loses on yes", scoreActivityTest({ eat_out_every_day: "yes" }).score, 0);
expectEq(
  "garbage answer = incorrect, no crash",
  scoreActivityTest({ gym_exercise: "maybe" }).score,
  0,
);
const p = scoreActivityTest(perfect);
expectEq(
  "byPillar sums = grid score",
  PILLAR_ORDER.reduce((s, k) => s + p.byPillar[k].earned, 0),
  p.gridScore,
);
expectEq(
  "byPillar possible = 24",
  PILLAR_ORDER.reduce((s, k) => s + p.byPillar[k].possible, 0),
  24,
);
expectEq("grid + activity = total", p.gridScore + p.activityScore, p.score);

// ── tiers ────────────────────────────────────────────────────────────────
expectEq("7 → CONTENDER", tierForScore(7).key, "contender");
expectEq("20.3 avg sits in ELITE", tierForScore(20).key, "elite");
expectEq("29 → GRANDMASTER", tierForScore(29).key, "grandmaster");
expectEq("next tier above 24 is MASTER", nextTier(24)?.key, "master");
expectEq("no tier above 30", nextTier(30), null);

// ── claimed JIP parsing ──────────────────────────────────────────────────
expectEq("'5+' parses to 5", claimedJipVisitsPerWeek({ jip_visits_week: "5+" }), 5);
expectEq("'2' parses to 2", claimedJipVisitsPerWeek({ jip_visits_week: "2" }), 2);
expectEq("absent → null", claimedJipVisitsPerWeek({}), null);

// ── the 10 round-1 responses: scorer must reproduce Google's grading ─────
// (Same answers as the migration seed — dev-only script, not bundled.)
const h = (vals: string) => {
  // vals = 19 chars y/n in the extraction order used by the plan table:
  // visualize, affirmations, game_plan, meditate, role_play, teammates,
  // pipeline, notes, audiobooks, read_books, 15early, visit_jips,
  // knock_neighbors, review_ti, gym, meal_prep, go_home, eat_out, hungover
  const order = [
    "visualize_goals",
    "morning_affirmations",
    "game_plan_day",
    "meditate",
    "role_play_weekly",
    "help_teammates_role_play",
    "pipeline_reloads",
    "notes_meetings",
    "audiobooks_between_leads",
    "read_books",
    "appts_15_early",
    "visit_jips_photos",
    "knock_neighbors_jips",
    "review_numbers_ti",
    "gym_exercise",
    "meal_prep",
    "go_home_between_leads",
    "eat_out_every_day",
    "saturday_hungover",
  ];
  return Object.fromEntries(order.map((k, i) => [k, vals[i] === "y" ? "yes" : "no"]));
};
const ROUND_1: Array<{ name: string; score: number; answers: ActivityAnswers }> = [
  {
    name: "Jovanny Paz",
    score: 23,
    answers: {
      ...h("nnynyyyyynyyynnynnn"),
      jip_visits_week: "2",
      visits_per_jip: "2",
      prev_customers_week: "2",
    },
  },
  {
    name: "Jonathan Paz",
    score: 16,
    answers: {
      ...h("nnnnnnyynnyynnnynnn"),
      jip_visits_week: "5+",
      visits_per_jip: "3",
      prev_customers_week: "2",
    },
  },
  {
    name: "Yakup Sancakli",
    score: 29,
    answers: {
      ...h("yyyyyyyyyyyyynyynnn"),
      jip_visits_week: "5+",
      visits_per_jip: "5+",
      prev_customers_week: "2",
    },
  },
  {
    name: "Josiah Haas",
    score: 23,
    answers: {
      ...h("nyyynnyyyynyynyynnn"),
      jip_visits_week: "3",
      visits_per_jip: "4",
      prev_customers_week: "4+",
    },
  },
  {
    name: "Jaxon Heilman",
    score: 7,
    answers: {
      ...h("nnnnnnynnnnnnnyynnn"),
      jip_visits_week: "1",
      visits_per_jip: "1",
      prev_customers_week: "0",
    },
  },
  {
    name: "Bergan Lundak",
    score: 15,
    answers: {
      ...h("nnynnnyynnyyynynnyn"),
      jip_visits_week: "1",
      visits_per_jip: "2",
      prev_customers_week: "4+",
    },
  },
  {
    name: "Bradley Crouse",
    score: 19,
    answers: {
      ...h("nnynyyyyyyyynynnnnn"),
      jip_visits_week: "1",
      visits_per_jip: "4",
      prev_customers_week: "0",
    },
  },
  {
    name: "Alfredo Castro",
    score: 18,
    answers: {
      ...h("nynyyyyynnyynnnnnnn"),
      jip_visits_week: "2",
      visits_per_jip: "5+",
      prev_customers_week: "1",
    },
  },
  {
    name: "Curtis Westergard",
    score: 29,
    answers: {
      ...h("yyyyyyyyyyyyyyynnnn"),
      jip_visits_week: "3",
      visits_per_jip: "5+",
      prev_customers_week: "4+",
    },
  },
  {
    name: "Samuel Corona",
    score: 24,
    answers: {
      ...h("ynyyyyyynyyynynnnnn"),
      jip_visits_week: "3",
      visits_per_jip: "2",
      prev_customers_week: "2",
    },
  },
];
for (const r of ROUND_1) {
  expectEq(`${r.name} reproduces ${r.score}/30`, scoreActivityTest(r.answers).score, r.score);
}
// Team shape from round 1 (matches the form's own summary page).
const scores = ROUND_1.map((r) => scoreActivityTest(r.answers).score);
expectEq(
  "team avg 20.3",
  Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
  20.3,
);
expectEq("team best 29", Math.max(...scores), 29);
expectEq(
  "visualize adoption 3/10",
  ROUND_1.filter((r) => r.answers["visualize_goals"] === "yes").length,
  3,
);
expectEq(
  "pipeline adoption 10/10",
  ROUND_1.filter((r) => r.answers["pipeline_reloads"] === "yes").length,
  10,
);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll activity-test assertions passed.");
