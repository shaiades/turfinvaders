// Tidal Activity Test — the single source of truth for the questionnaire
// (owner's Google Form run, Oct 2026, imported verbatim). 19 yes/no
// high-performer habits (1–2 pts, three reverse-scored) + 3 activity
// questions (2 pts each) = 30 points. Consumers never hard-code question
// copy, points, or correct answers — they import from here, and the pure
// scorer in src/lib/activity-test.ts is the only place scoring direction
// is applied. The 10 seeded responses live ONLY in the migration/DB —
// this module ships in the client bundle, individual sheets must not.

export type Pillar = "mind" | "craft" | "field" | "body";

/** Which Goals-tab money lever a habit feeds. `activity` = pace/energy
 *  levers that don't map to one FunnelTile (appts/day, weekly goal). */
export type FunnelLever = "closePct" | "sitPct" | "reloads" | "activity";

export type HabitDef = {
  key: string;
  /** Question copy verbatim from the form (typos and all — the seeded
   *  answers were given against THIS wording). */
  label: string;
  points: 1 | 2;
  /** Reverse-scored habits ("Eat out every day?") are correct on "no". */
  correctAnswer: "yes" | "no";
  pillar: Pillar;
  lever: FunnelLever;
  /** One-liner tying the habit to the money it moves. Rendered on
   *  forward-scored habits only — never on reverse-scored ones, so the
   *  retake sheet can't leak scoring direction. */
  leverNote: string;
};

/** Form order (the order reps saw). Grid total = 24 pts. */
export const HABITS: HabitDef[] = [
  {
    key: "gym_exercise",
    label: "Go to the gym/exercise?",
    points: 1,
    correctAnswer: "yes",
    pillar: "body",
    lever: "activity",
    leverNote: "Energy is pace — more gas for more appointments per day.",
  },
  {
    key: "role_play_weekly",
    label: "Do you practice role playing at least once a week?",
    points: 2,
    correctAnswer: "yes",
    pillar: "craft",
    lever: "closePct",
    leverNote: "Reps who drill close harder — this powers your CLOSE %.",
  },
  {
    key: "meditate",
    label: "Meditate in the morning or the evenings?",
    points: 1,
    correctAnswer: "yes",
    pillar: "mind",
    lever: "closePct",
    leverNote: "Composure in the home shows up in your CLOSE %.",
  },
  {
    key: "game_plan_day",
    label: "Do you game plan your day the the night before or morning of?",
    points: 1,
    correctAnswer: "yes",
    pillar: "mind",
    lever: "activity",
    leverNote: "A planned day packs more appointments into the same hours.",
  },
  {
    key: "read_books",
    label: "Do you read books in the mornings, evenings, or in your downtime between leads?",
    points: 1,
    correctAnswer: "yes",
    pillar: "craft",
    lever: "closePct",
    leverNote: "Students of the game out-close the naturals — CLOSE %.",
  },
  {
    key: "audiobooks_between_leads",
    label: "Listen to audiobooks between leads?",
    points: 2,
    correctAnswer: "yes",
    pillar: "craft",
    lever: "closePct",
    leverNote: "Windshield university — sharper in the next home. CLOSE %.",
  },
  {
    key: "meal_prep",
    label: "Meal prep and eating healthy?",
    points: 1,
    correctAnswer: "yes",
    pillar: "body",
    lever: "activity",
    leverNote: "Steady fuel keeps the afternoon appointments as sharp as the morning.",
  },
  {
    key: "eat_out_every_day",
    label: "Eat out every day?",
    points: 1,
    correctAnswer: "no",
    pillar: "body",
    lever: "activity",
    leverNote: "", // reverse-scored — never rendered
  },
  {
    key: "saturday_hungover",
    label: "Spend Saturday running leads hungover?",
    points: 1,
    correctAnswer: "no",
    pillar: "body",
    lever: "activity",
    leverNote: "", // reverse-scored — never rendered
  },
  {
    key: "appts_15_early",
    label: "Get to appointments 15 minutes early?",
    points: 1,
    correctAnswer: "yes",
    pillar: "field",
    lever: "sitPct",
    leverNote: "Early reps sit more of what they set — this is your SIT %.",
  },
  {
    key: "knock_neighbors_jips",
    label: "Knock neighbors doors around jobs in progress?",
    points: 1,
    correctAnswer: "yes",
    pillar: "field",
    lever: "reloads",
    leverNote: "The crowd effect — neighbor knocks turn one job into RELOADS.",
  },
  {
    key: "visualize_goals",
    label: "Visualize your goals each morning?",
    points: 2,
    correctAnswer: "yes",
    pillar: "mind",
    lever: "activity",
    leverNote: "The reps who see the number hit the number — your weekly goal.",
  },
  {
    key: "pipeline_reloads",
    label: "Looking at pipeline for possible reloads?",
    points: 1,
    correctAnswer: "yes",
    pillar: "field",
    lever: "reloads",
    leverNote: "Pipeline checks surface RELOADS nobody has to knock for.",
  },
  {
    key: "help_teammates_role_play",
    label: "Are you helping your teammates role play?",
    points: 1,
    correctAnswer: "yes",
    pillar: "craft",
    lever: "closePct",
    leverNote: "Teaching the close is the fastest way to own it — CLOSE %.",
  },
  {
    key: "morning_affirmations",
    label: "Go over your morning affirmations?",
    points: 1,
    correctAnswer: "yes",
    pillar: "mind",
    lever: "closePct",
    leverNote: "Confidence walks into the home with you — CLOSE %.",
  },
  {
    key: "go_home_between_leads",
    label: "Go home between leads?",
    points: 2,
    correctAnswer: "no",
    pillar: "field",
    lever: "activity",
    leverNote: "", // reverse-scored — never rendered
  },
  {
    key: "visit_jips_photos",
    label: "Visit jobs in progress and take photos?",
    points: 2,
    correctAnswer: "yes",
    pillar: "field",
    lever: "reloads",
    leverNote: "Jobs you show up to turn into RELOADS and referrals.",
  },
  {
    key: "notes_meetings",
    label: "Do you still take notes during meetings and trainings?",
    points: 1,
    correctAnswer: "yes",
    pillar: "craft",
    lever: "closePct",
    leverNote: "Written down beats remembered — it compounds into CLOSE %.",
  },
  {
    key: "review_numbers_ti",
    label: "Review your numbers in Turf Invaders",
    points: 1,
    correctAnswer: "yes",
    pillar: "craft",
    lever: "activity",
    leverNote: "You can't fix a rate you don't look at — know YOUR numbers.",
  },
];

export type ActivityQuestionDef = {
  key: string;
  label: string;
  points: number;
  /** Option values verbatim from the form. */
  options: string[];
  /** The options the form's answer key marks correct. */
  correct: string[];
};

export const ACTIVITY_QUESTIONS: ActivityQuestionDef[] = [
  {
    key: "jip_visits_week",
    label: "On average, how many jobs in progress do you visit each week?",
    points: 2,
    options: ["0", "1", "2", "3", "4", "5+"],
    correct: ["2", "3", "4", "5+"],
  },
  {
    key: "visits_per_jip",
    label: "Average number of times you visit a job in progress?",
    points: 2,
    options: ["1", "2", "3", "4", "5+"],
    correct: ["2", "3", "4", "5+"],
  },
  {
    key: "prev_customers_week",
    label: "On average, how many previous customers do you visit each week?",
    points: 2,
    options: ["0", "1", "2", "3", "4+"],
    correct: ["2", "3", "4+"],
  },
];

export const MAX_SCORE = 30;

/** The minimum "correct" thresholds — the high-performer standard the
 *  receipts gauge and JIP PATROL strip compare against. */
export const HIGH_PERFORMER = {
  jipVisitsPerWeek: 2,
  visitsPerJip: 2,
  prevCustomersPerWeek: 2,
} as const;

export const PILLAR_META: Record<Pillar, { label: string }> = {
  mind: { label: "Mind" },
  craft: { label: "Craft" },
  field: { label: "Field" },
  body: { label: "Body" },
};

export const PILLAR_ORDER: Pillar[] = ["mind", "craft", "field", "body"];
