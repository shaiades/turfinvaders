// Tidal Activity Test — the ONE shared scoring module. Reverse-scored
// habits flip here and nowhere else, so the rep card, the retake reveal,
// the plan strip and the leadership board can never disagree on a score
// (never-invent-numbers doctrine). Tier thresholds and boss names are
// frozen constants, versioned with the questionnaire: editing questions
// later must bump TEST_VERSION, never mutate history — takes of different
// versions are never compared.

import {
  ACTIVITY_QUESTIONS,
  HABITS,
  MAX_SCORE,
  PILLAR_ORDER,
  type HabitDef,
  type ActivityQuestionDef,
  type Pillar,
} from "@/data/activity-test-content";

/** Bump when the questionnaire changes. Stored per take. */
export const TEST_VERSION = 1;

// ---------------------------------------------------------------------------
// Tiers (frozen 2026-10-01 against the round-1 distribution: avg 20.3 lands
// just inside ELITE, the lowest scorer sits 3 pts from his first rank-up).
// Tier colors appear ONLY in the tier pill + its popover, never on chrome.
// ---------------------------------------------------------------------------

export type TestTier = {
  key: string;
  label: string;
  min: number;
  max: number;
  /** CSS color — a token var where one exists. */
  color: string;
  /** Lucide icon name; components resolve it to the component. */
  icon: "Shield" | "Star" | "Swords" | "Sparkles" | "Trophy" | "Crown";
};

export const TEST_TIERS: TestTier[] = [
  { key: "contender", label: "CONTENDER", min: 0, max: 9, color: "#94a3b8", icon: "Shield" },
  { key: "brawler", label: "BRAWLER", min: 10, max: 14, color: "#cbd5e1", icon: "Star" },
  {
    key: "warrior",
    label: "WARRIOR",
    min: 15,
    max: 19,
    color: "var(--kombat-red)",
    icon: "Swords",
  },
  { key: "elite", label: "ELITE", min: 20, max: 24, color: "var(--turf-cyan)", icon: "Sparkles" },
  { key: "master", label: "MASTER", min: 25, max: 28, color: "var(--kombat-gold)", icon: "Trophy" },
  {
    key: "grandmaster",
    label: "GRANDMASTER",
    min: 29,
    max: 30,
    color: "var(--neon)",
    icon: "Crown",
  },
];

export function tierForScore(score: number): TestTier {
  const clamped = Math.max(0, Math.min(MAX_SCORE, Math.floor(score)));
  return TEST_TIERS.find((t) => clamped >= t.min && clamped <= t.max) ?? TEST_TIERS[0];
}

/** The next rung up, or null at the top. */
export function nextTier(score: number): TestTier | null {
  const cur = tierForScore(score);
  const i = TEST_TIERS.findIndex((t) => t.key === cur.key);
  return i >= 0 && i < TEST_TIERS.length - 1 ? TEST_TIERS[i + 1] : null;
}

// ---------------------------------------------------------------------------
// Boss names — one per HABIT, stable forever (the displayed three rotate
// with team adoption, but a boss's name belongs to its habit and never
// changes out from under the floor's trash talk).
// ---------------------------------------------------------------------------

export const BOSS_NAMES: Record<string, string> = {
  visualize_goals: "THE MORNING VOID",
  morning_affirmations: "THE SILENT MIRROR",
  game_plan_day: "THE DRIFTER",
  meditate: "THE STATIC",
  role_play_weekly: "THE RUSTY BLADE",
  help_teammates_role_play: "THE LONE WOLF",
  pipeline_reloads: "THE DRY WELL",
  notes_meetings: "THE GOLDFISH",
  audiobooks_between_leads: "THE DEAD AIR",
  read_books: "THE CLOSED BOOK",
  appts_15_early: "THE LATE SHOW",
  visit_jips_photos: "THE GHOST CREW",
  knock_neighbors_jips: "THE COLD STREET",
  review_numbers_ti: "THE BLIND SPOT",
  gym_exercise: "THE SOFT SEASON",
  meal_prep: "THE DRIVE-THRU",
  go_home_between_leads: "THE COUCH",
  eat_out_every_day: "THE MONEY LEAK",
  saturday_hungover: "THE SATURDAY FOG",
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type ActivityAnswers = Record<string, string>;

export type ActivityScore = {
  /** Total out of MAX_SCORE (grid + activity questions). */
  score: number;
  /** The 19-habit grid portion (out of 24). */
  gridScore: number;
  /** The 3 activity questions' portion (out of 6). */
  activityScore: number;
  /** Habits answered wrong OR unanswered (unanswered = incorrect, never a crash). */
  missed: HabitDef[];
  /** Activity questions answered wrong or unanswered. */
  missedActivity: ActivityQuestionDef[];
  byPillar: Record<Pillar, { earned: number; possible: number }>;
};

/** Did this answer earn the habit's points? The reverse-flip lives HERE —
 *  "no" on "Eat out every day?" is the high-performer answer. */
export function habitEarned(habit: HabitDef, answer: string | undefined): boolean {
  if (answer !== "yes" && answer !== "no") return false;
  return answer === habit.correctAnswer;
}

export function activityEarned(q: ActivityQuestionDef, answer: string | undefined): boolean {
  return answer !== undefined && q.correct.includes(answer);
}

export function scoreActivityTest(answers: ActivityAnswers | null | undefined): ActivityScore {
  const a = answers ?? {};
  const byPillar = Object.fromEntries(
    PILLAR_ORDER.map((p) => [p, { earned: 0, possible: 0 }]),
  ) as Record<Pillar, { earned: number; possible: number }>;

  let gridScore = 0;
  const missed: HabitDef[] = [];
  for (const h of HABITS) {
    byPillar[h.pillar].possible += h.points;
    if (habitEarned(h, a[h.key])) {
      gridScore += h.points;
      byPillar[h.pillar].earned += h.points;
    } else {
      missed.push(h);
    }
  }

  let activityScore = 0;
  const missedActivity: ActivityQuestionDef[] = [];
  for (const q of ACTIVITY_QUESTIONS) {
    if (activityEarned(q, a[q.key])) activityScore += q.points;
    else missedActivity.push(q);
  }

  return {
    score: gridScore + activityScore,
    gridScore,
    activityScore,
    missed,
    missedActivity,
    byPillar,
  };
}

/** Gap habits for the power-up queue: missed, highest points first, then
 *  highest team adoption first (social proof). `adoptionOf` returns the
 *  count of teammates whose latest take earned the habit, or null when
 *  team stats aren't loaded. */
export function rankGapHabits(
  missed: HabitDef[],
  adoptionOf: (key: string) => number | null,
): HabitDef[] {
  return [...missed].sort((x, y) => {
    if (y.points !== x.points) return y.points - x.points;
    return (adoptionOf(y.key) ?? -1) - (adoptionOf(x.key) ?? -1);
  });
}

/** Parse the claimed weekly JIP visits from a take's answer ("5+" → 5). */
export function claimedJipVisitsPerWeek(
  answers: ActivityAnswers | null | undefined,
): number | null {
  const v = answers?.["jip_visits_week"];
  if (v === undefined) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
