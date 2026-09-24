// My Purpose — workshop content + branch-logic data (V1, sales reps only).
//
// This file is the SINGLE SOURCE OF TRUTH for every screen, question, option
// list, helper, example, chip set, reflection card and branch predicate in the
// guided workshop. Copy is transcribed VERBATIM from the build specification
// (Turf_Invaders_My_Purpose_V1_Claude_Build_Specification.md, sections 10–17;
// branch minimums from section 20). Consumers — the pure engine and the step
// components — import from here and never hard-code copy.
//
// Rules honored here:
// - No React imports. No side effects. Pure data + pure functions only.
// - Every Dyn<T> function returns a sane default on an empty/partial
//   AnswerMap, so no branch can dead-end (spec §24.8).
// - Answer value shapes are the canonical ones documented on each step.

import type {
  AnswerMap,
  AnswerValue,
  CeilingBand,
  ConfidenceBand,
  ConstraintCategory,
  DirectionKind,
  LifeArea,
  ModuleMeta,
  ObstacleKey,
  Option,
  StepDef,
  StepIssue,
} from "@/lib/purpose/types";
import { LIFE_AREAS, OBSTACLE_KEYS } from "@/lib/purpose/types";
import { QK } from "@/lib/purpose/questionKeys";
import {
  detectPredictiveIdentity,
  detectVague,
  detectExternalOnly,
  detectMaterialOnly,
  detectNonObservable,
  hasRecognizableEvidence,
  detectRepeatsGoal,
  detectIDontKnow,
} from "@/lib/purpose/validators";
import { quoteAnswer, whyQuote, answerDisplayText } from "@/lib/purpose/interpolate";

// ---------------------------------------------------------------------------
// A) Modules
// ---------------------------------------------------------------------------

export const MODULES: ModuleMeta[] = [
  {
    key: "clear_board",
    index: 1,
    label: "Clear the Board",
    rationale:
      "Before setting a goal, separate what has happened from what you have decided it means about your future.",
    weight: 10,
  },
  {
    key: "ceiling",
    index: 2,
    label: "The Ceiling",
    rationale:
      "Everyone has a number, role, or life outcome that feels possible—and another that feels “not for someone like me.” Let’s understand where that line came from.",
    weight: 25,
  },
  {
    key: "build_future",
    index: 3,
    label: "Build the Future",
    rationale: "Now that you have named the ceiling, create a future worth working through discomfort for.",
    weight: 20,
  },
  {
    key: "make_real",
    index: 4,
    label: "Make It Real",
    rationale:
      "A possibility becomes useful when it turns into a specific target and a direction for the next 90 days.",
    weight: 25,
  },
  {
    key: "keep_promise",
    index: 5,
    label: "Why It Matters and Keep the Promise",
    rationale:
      "A goal can sound good on paper. A core reason helps it survive the days when comfort, fear, and distraction show up.",
    weight: 20,
  },
];

// ---------------------------------------------------------------------------
// Small internal utilities (pure)
// ---------------------------------------------------------------------------

/** Safe string[] out of an AnswerValue.json multi-select payload. */
function stringArray(json: unknown): string[] {
  return Array.isArray(json) ? json.filter((s): s is string => typeof s === "string") : [];
}

function isLifeArea(v: unknown): v is LifeArea {
  return typeof v === "string" && (LIFE_AREAS as readonly string[]).includes(v);
}

function isObstacleKey(v: unknown): v is ObstacleKey {
  return typeof v === "string" && (OBSTACLE_KEYS as readonly string[]).includes(v);
}

/** Whole-dollar USD for review/summary rows. */
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

// ---------------------------------------------------------------------------
// B) Derivation helpers (pure; every one defaults sanely on a partial map)
// ---------------------------------------------------------------------------

/** §13 2.1: ≤ $75k low, ≤ $200k mid, > $200k high. Missing → "mid". */
export function ceilingBand(a: AnswerMap): CeilingBand {
  const amount = a[QK.m2_ceiling_amount]?.number;
  if (amount == null || Number.isNaN(amount)) return "mid";
  if (amount <= 75_000) return "low";
  if (amount <= 200_000) return "mid";
  return "high";
}

/** §15 4.3: 1–3 low, 4–7 mid, 8–10 high. Missing → "mid". */
export function confidenceBand(a: AnswerMap): ConfidenceBand {
  const n = a[QK.m4_confidence]?.number;
  if (n == null || Number.isNaN(n)) return "mid";
  if (n <= 3) return "low";
  if (n <= 7) return "mid";
  return "high";
}

/** §12 1.2: option value = DirectionKind slug. Missing/unknown → "vague". */
export function directionKind(a: AnswerMap): DirectionKind {
  const v = a[QK.m1_direction]?.text;
  const kinds: readonly DirectionKind[] = ["clear", "stuck", "inconsistent", "vague", "week_focus", "unsure"];
  return kinds.includes(v as DirectionKind) ? (v as DirectionKind) : "vague";
}

/** §13 2.3 mapped through BELIEF_OPTION_TO_CONSTRAINT; first selection wins.
 *  One bias per §12 branch rules ("not consistently doing what it takes"
 *  pre-flags the consistency/avoidance branch): when the direction answer is
 *  "inconsistent" and any selection maps to consistency or rejection_avoidance,
 *  prefer that one. Missing/empty → "unclear". */
export function primaryConstraint(a: AnswerMap): ConstraintCategory {
  const selections = stringArray(a[QK.m2_belief_categories]?.json);
  const constraints = selections
    .map((slug) => BELIEF_OPTION_TO_CONSTRAINT[slug])
    .filter((c): c is ConstraintCategory => c != null);
  if (constraints.length === 0) return "unclear";
  if (directionKind(a) === "inconsistent") {
    const flagged = constraints.find((c) => c === "consistency" || c === "rejection_avoidance");
    if (flagged) return flagged;
  }
  return constraints[0];
}

/** §14 3.2: first selection = primary life area. Missing → "other". */
export function primaryLifeArea(a: AnswerMap): LifeArea {
  const first = stringArray(a[QK.m3_life_areas]?.json)[0];
  return isLifeArea(first) ? first : "other";
}

/** §14 3.2: second selection, or null. */
export function secondaryLifeArea(a: AnswerMap): LifeArea | null {
  const second = stringArray(a[QK.m3_life_areas]?.json)[1];
  return isLifeArea(second) ? second : null;
}

/** §16 5.3: first selection = primary obstacle. Missing → "dont_know". */
export function primaryObstacle(a: AnswerMap): ObstacleKey {
  const first = stringArray(a[QK.m5_obstacles]?.json)[0];
  return isObstacleKey(first) ? first : "dont_know";
}

/** why_2's fallback chips appear when the rep's draft reads as "I don't know"
 *  (§16 Level 2). Component behavior — the chips themselves live on the step. */
/** §20.6: chips seed an answer, they never ARE the answer — "offer relevant
 *  choice chips and require one original sentence." Blocks when the text is
 *  chip labels (one or several) with fewer than ~a dozen characters of the
 *  rep's own words around them; text containing no chip label at all is
 *  someone writing freely and passes untouched. */
export function chipOnlyIssue(
  text: string | undefined,
  chips: Option[],
): { level: "block"; message: string } | null {
  const t = (text ?? "").trim().toLowerCase().replace(/[.!\s]+$/, "");
  if (!t) return null;
  let rest = t;
  for (const c of chips) {
    const label = c.label.toLowerCase().replace(/[.!\s]+$/, "");
    if (label) rest = rest.split(label).join(" ");
  }
  if (rest === t) return null; // no chip label present — their own words
  const original = rest.replace(/[,\s]+/g, " ").trim();
  if (original.length >= 12) return null;
  return {
    level: "block",
    message: "Take the chip one step further — one sentence in your own words.",
  };
}

export function shouldOfferWhyFallbackChips(draft: string): boolean {
  return detectIDontKnow(draft);
}

// ---------------------------------------------------------------------------
// C) Label tables (review, Purpose Home, leadership dashboard)
// ---------------------------------------------------------------------------

/** §14 3.2 — the 14 life-area labels, verbatim. */
export const LIFE_AREA_LABELS: Record<LifeArea, string> = {
  income: "Income / financial security",
  debt: "Paying off debt",
  home: "Buying or improving a home",
  family: "Supporting my family",
  health: "Health and energy",
  confidence: "Confidence and discipline",
  sales_skill: "Becoming better at sales",
  leadership: "Becoming a leader",
  freedom: "Freedom, travel, or control of my time",
  business: "Starting or building a future business",
  education: "Education or career development",
  relationships: "Relationships",
  giving_back: "Giving back / helping others",
  other: "Other",
};

/** Human labels for the §13 constraint slugs (spec names the slugs, not display
 *  labels; wording follows §4.3's plain-English list). */
export const CONSTRAINT_LABELS: Record<ConstraintCategory, string> = {
  sales_skill: "Sales skill",
  consistency: "Consistency",
  rejection_avoidance: "Rejection avoidance",
  opportunity_belief: "Opportunity belief",
  identity_ceiling: "Identity ceiling",
  fear_of_success: "Fear of success",
  fear_of_failure: "Fear of failure",
  lack_of_purpose: "Unclear purpose",
  unclear: "Unclear",
  other: "Other",
};

/** §16 5.3 — the 13 obstacle options, verbatim, in spec order. */
export const OBSTACLE_LABELS: Record<ObstacleKey, string> = {
  wait_for_motivation: "I wait until I feel motivated.",
  avoid_rejection: "I avoid rejection or uncomfortable conversations.",
  distracted: "I get distracted.",
  tired: "I get tired or do not protect my energy.",
  no_plan: "I do not plan.",
  discouraged: "I get discouraged after a bad day.",
  blame_circumstances: "I start blaming leads, timing, territory, or circumstances.",
  dont_ask_help: "I do not ask for help.",
  avoid_problem: "I feel behind, so I avoid looking at the problem.",
  doubt_payoff: "I do not actually believe the effort will pay off.",
  overcommitted: "I say yes to too many things and lose focus.",
  dont_know: "I do not know.",
  other: "Other.",
};

export const OBSTACLE_OPTIONS: Option[] = OBSTACLE_KEYS.map((value) => ({
  value,
  label: OBSTACLE_LABELS[value],
}));

/** §16 Level 6 — the 17 core-value chips. */
export const CORE_VALUE_CHIPS: Option[] = [
  { value: "security", label: "Security" },
  { value: "freedom", label: "Freedom" },
  { value: "family", label: "Family" },
  { value: "self_respect", label: "Self-respect" },
  { value: "peace", label: "Peace" },
  { value: "growth", label: "Growth" },
  { value: "pride", label: "Pride" },
  { value: "stability", label: "Stability" },
  { value: "courage", label: "Courage" },
  { value: "contribution", label: "Contribution" },
  { value: "belonging", label: "Belonging" },
  { value: "mastery", label: "Mastery" },
  { value: "responsibility", label: "Responsibility" },
  { value: "independence", label: "Independence" },
  { value: "health", label: "Health" },
  { value: "legacy", label: "Legacy" },
  { value: "other", label: "Other" },
];

/** §15 4.5 — the 11 professional-focus options, verbatim. */
export const PRO_FOCUS_OPTIONS: Option[] = [
  { value: "consistency", label: "Become more consistent." },
  { value: "sales_skill", label: "Improve my sales skill." },
  { value: "follow_up", label: "Get better at follow-up." },
  { value: "customer_relationships", label: "Get better at customer relationships and long-term ownership." },
  { value: "rejection", label: "Handle rejection and discomfort better." },
  { value: "planning", label: "Plan and prepare more intentionally." },
  { value: "feedback", label: "Ask for feedback and coaching sooner." },
  { value: "confidence", label: "Improve my confidence in conversations." },
  { value: "leadership", label: "Improve my leadership and reliability." },
  { value: "opportunity", label: "Better understand the opportunity and path in front of me." },
  { value: "other", label: "Other." },
];

/** §15 4.6 — the 11 personal-support options, verbatim. */
export const PERSONAL_FOCUS_OPTIONS: Option[] = [
  { value: "sleep_energy", label: "Better sleep / energy" },
  { value: "health_fitness", label: "Health / fitness" },
  { value: "money_management", label: "Managing money better" },
  { value: "time_planning", label: "Planning my time" },
  { value: "distractions", label: "Reducing distractions" },
  { value: "relationships_accountability", label: "More supportive relationships / accountability" },
  { value: "stress", label: "Managing stress" },
  { value: "confidence", label: "Building confidence" },
  { value: "learning", label: "Learning / reading / skill development" },
  { value: "none_needed", label: "I do not need to focus on something outside work right now" },
  { value: "other", label: "Other" },
];

/** §16 5.5 — the 10 leadership support-request options, verbatim. */
export const SUPPORT_REQUEST_OPTIONS: Option[] = [
  { value: "direct_feedback", label: "More direct feedback" },
  { value: "skill_coaching", label: "Sales skill coaching" },
  { value: "clearer_plan", label: "Help creating a clearer plan" },
  { value: "accountability", label: "More accountability" },
  { value: "understand_numbers", label: "Help understanding my numbers or opportunity" },
  { value: "career_path", label: "A conversation about leadership / career path" },
  { value: "consistency_support", label: "Support staying consistent" },
  { value: "goals_checkin", label: "A check-in on my personal and professional goals" },
  { value: "nothing_now", label: "Nothing right now" },
  { value: "other", label: "Other" },
];

/** §16 Level 4 — the 8 non-invasive categories leadership sees when the level
 *  is marked private. */
export const WHY4_PRIVATE_CATEGORIES: Option[] = [
  { value: "myself_self_respect", label: "Myself / self-respect" },
  { value: "partner_spouse", label: "Partner or spouse" },
  { value: "children", label: "Children or future children" },
  { value: "parents_family", label: "Parents or family" },
  { value: "friends_community", label: "Friends / community" },
  { value: "customers", label: "Customers / people I serve" },
  { value: "future_team", label: "Future team / people I lead" },
  { value: "prefer_not_to_say", label: "Other / prefer not to say" },
];

/** §16 Level 5 — the 8 high-level cost categories for a private level. */
export const WHY5_PRIVATE_CATEGORIES: Option[] = [
  { value: "lost_time", label: "Lost time" },
  { value: "financial_stress", label: "Financial stress" },
  { value: "missed_potential", label: "Missed potential" },
  { value: "loss_of_confidence", label: "Loss of confidence" },
  { value: "strained_relationships", label: "Strained relationships" },
  { value: "feeling_stuck", label: "Feeling stuck" },
  { value: "regret", label: "Regret" },
  { value: "prefer_not_to_say", label: "Other / prefer not to say" },
];

// ---------------------------------------------------------------------------
// Module 1 option lists
// ---------------------------------------------------------------------------

/** §12 1.2 — 6 options, verbatim, in spec order. Values = DirectionKind. */
export const DIRECTION_OPTIONS: Option[] = [
  { value: "inconsistent", label: "I know what I want, but I am not consistently doing what it takes." },
  { value: "vague", label: "I have some goals, but they are vague." },
  { value: "week_focus", label: "I mostly focus on the week in front of me." },
  { value: "stuck", label: "I feel stuck or unsure about what I want." },
  { value: "clear", label: "I have a clear goal and strong direction." },
  { value: "unsure", label: "I’m not sure." },
];

// ---------------------------------------------------------------------------
// Module 2 option lists + constraint mapping
// ---------------------------------------------------------------------------

/** §13 2.1 Branch A (ceiling ≤ $75k) — 6 options. */
export const CEILING_REASON_LOW_OPTIONS: Option[] = [
  { value: "early_career", label: "I am early in my sales career and still learning." },
  { value: "skill_doubt", label: "I do not yet believe I have the skill to earn more." },
  { value: "opportunity_doubt", label: "I do not think the opportunity is there." },
  { value: "not_considered", label: "I have not seriously thought about my income potential." },
  { value: "life_responsibilities", label: "I am balancing major life responsibilities right now." },
  { value: "other", label: "Other." },
];

/** §13 2.1 Branch B ($75k < ceiling ≤ $200k) — 8 options. */
export const CEILING_REASON_MID_OPTIONS: Option[] = [
  { value: "past_earnings", label: "It is around what I have made before." },
  { value: "seen_others", label: "It is around what I have seen others make." },
  { value: "consistency_doubt", label: "I believe I can work hard, but I doubt my consistency." },
  { value: "skill_doubt", label: "I do not believe I have enough skill yet." },
  { value: "rejection_pressure", label: "I do not believe I can handle the rejection or pressure." },
  { value: "unknown_actions", label: "I do not know what actions would create more income." },
  { value: "opportunity_doubt", label: "I do not think more opportunity exists." },
  { value: "other", label: "Other." },
];

/** §13 2.1 Branch C (ceiling > $200k) — 6 options. */
export const CEILING_REASON_HIGH_OPTIONS: Option[] = [
  { value: "earned_before", label: "I have earned close to this before." },
  { value: "seen_results", label: "I have watched people create results at this level." },
  { value: "knows_path", label: "I know the skills and activity required, even if I have not mastered them yet." },
  { value: "motivated_by_goal", label: "I am highly motivated by a specific life goal." },
  { value: "growth_belief", label: "I believe I can grow into the person who earns it." },
  { value: "other", label: "Other." },
];

/** §13 2.3 — 11 options, verbatim. Values are DISTINCT option slugs; the
 *  constraint each one maps to lives in BELIEF_OPTION_TO_CONSTRAINT below. */
export const BELIEF_CATEGORY_OPTIONS: Option[] = [
  { value: "never_earned_more", label: "I have never earned more than this." },
  { value: "never_seen_background", label: "I have never seen someone with my background earn more than this." },
  { value: "skill_doubt", label: "I do not believe I have the sales skill yet." },
  { value: "consistency_doubt", label: "I do not believe I can stay consistent enough." },
  { value: "rejection_avoidance", label: "I avoid rejection, follow-up, or uncomfortable conversations." },
  { value: "opportunity_doubt", label: "I do not believe the opportunity is there." },
  { value: "identity_doubt", label: "I do not believe I am the kind of person who succeeds at a bigger level." },
  { value: "fear_of_success", label: "I am worried about what more success would require from me." },
  { value: "fear_of_failure", label: "I am worried about what happens if I try and fail." },
  { value: "no_purpose", label: "I do not know what I want badly enough yet." },
  { value: "other", label: "Other." },
];

/** §13 2.3 mapping — option slug → primary_constraint_category. Several
 *  options intentionally share one constraint (spec maps 11 options onto the
 *  structured category list). */
export const BELIEF_OPTION_TO_CONSTRAINT: Record<string, ConstraintCategory> = {
  never_earned_more: "identity_ceiling",
  never_seen_background: "identity_ceiling",
  skill_doubt: "sales_skill",
  consistency_doubt: "consistency",
  rejection_avoidance: "rejection_avoidance",
  opportunity_doubt: "opportunity_belief",
  identity_doubt: "identity_ceiling",
  fear_of_success: "fear_of_success",
  fear_of_failure: "fear_of_failure",
  no_purpose: "lack_of_purpose",
  other: "other",
};

/** §13 2.5 — 10 options, verbatim. */
export const STORY_ORIGIN_OPTIONS: Option[] = [
  { value: "family_childhood", label: "Family or childhood environment" },
  { value: "past_job", label: "Past job or career experience" },
  { value: "past_failure", label: "A past failure" },
  { value: "peers", label: "Friends, peers, or people around me" },
  { value: "authority_figure", label: "A manager, teacher, coach, or authority figure" },
  { value: "social_media", label: "Social media or comparison" },
  { value: "own_inconsistency", label: "My own inconsistency" },
  { value: "financial_stress", label: "Financial stress or responsibility" },
  { value: "dont_know", label: "I do not know" },
  { value: "other", label: "Other" },
];

/** §13 2.7 — 10 options, verbatim. */
export const PERSONAL_GAP_OPTIONS: Option[] = [
  { value: "sales_skill", label: "I need stronger sales skill." },
  { value: "consistency", label: "I need stronger consistency." },
  { value: "follow_up_avoidance", label: "I need to stop avoiding follow-up." },
  { value: "uncomfortable_conversations", label: "I need to get better at uncomfortable conversations." },
  { value: "coaching", label: "I need to ask for coaching sooner." },
  { value: "planning", label: "I need to plan my week better." },
  { value: "opportunity_belief", label: "I need to believe more opportunity is possible." },
  { value: "energy_discipline", label: "I need to protect my energy, health, or personal discipline." },
  { value: "clearer_reason", label: "I need a clearer reason to push myself." },
  { value: "other", label: "Other." },
];

// ---------------------------------------------------------------------------
// §13 2.4 — Fact versus story copy (the dual_text component reads this)
// ---------------------------------------------------------------------------

export const FACT_STORY_COPY = {
  headline: "Now separate the evidence from the conclusion.",
  factQuestion: "What is the fact?",
  factHelper: "A fact is observable. It does not predict your future.",
  factExamples: [
    "I made $X last year.",
    "I have been in sales for X months.",
    "I have not yet consistently followed up.",
    "I have never closed a deal over $X.",
  ],
  storyQuestion: "What story might you be adding to that fact?",
  storyHelper: "A story is the conclusion you have drawn about what you are capable of.",
  storyExamples: [
    "That means I cannot make more.",
    "That means I am not a real salesperson.",
    "That means I will always struggle with consistency.",
    "That means people like me do not get that far.",
  ],
  factRewritePrompt:
    "Try rewriting this as something observable that has happened so far, without predicting your future.",
  storyBlankPrompt: "If the fact is true, what conclusion have you been tempted to draw from it?",
} as const;

// ---------------------------------------------------------------------------
// §13 2.8 — Personalized reflection cards (headline = first sentence, body =
// the rest, both verbatim; the pair renders as one card)
// ---------------------------------------------------------------------------

type ReflectionCard = { headline: string; body: string };

const REFLECTION_CARD_TEXT: Record<Exclude<ConstraintCategory, "unclear" | "other">, ReflectionCard> = {
  sales_skill: {
    headline: "Your ceiling may be less about who you are and more about what you have not mastered yet.",
    body: "Skill can be practiced, reviewed, coached, and improved.",
  },
  consistency: {
    headline: "Your ceiling may not be talent.",
    body: "It may be whether you can keep promises to yourself after the excitement wears off.",
  },
  rejection_avoidance: {
    headline: "Your ceiling may not be opportunity.",
    body: "It may be the moments you pull away from discomfort before the result has a chance to compound.",
  },
  opportunity_belief: {
    headline: "Opportunity matters.",
    body: "So does seeing the full path. Later, your goal will be paired with an honest conversation about what is controllable and what support you need.",
  },
  identity_ceiling: {
    headline:
      "You may be treating your past as a definition of who you are instead of evidence of where you have been.",
    body: "The next step is not fake confidence. It is a bigger possibility paired with a real plan.",
  },
  fear_of_success: {
    headline:
      "Sometimes a bigger future feels uncomfortable because it may require change, responsibility, visibility, or different habits.",
    body: "That does not make the goal wrong. It makes the tradeoff worth naming.",
  },
  fear_of_failure: {
    headline: "Fear of failure can turn a meaningful goal into a smaller goal that feels safer.",
    body: "The goal here is not certainty. It is choosing a possibility worth testing.",
  },
  lack_of_purpose: {
    headline: "Before you can build a plan, you need something that matters enough to compete with comfort.",
    body: "The next section is designed to help you find it.",
  },
};

/** The spec defines exactly eight cards (§13 2.8); "unclear" and "other" have
 *  no copy of their own, so they deliberately REUSE spec cards rather than
 *  invent new copy:
 *  - unclear → the lack_of_purpose card (an unclear primary constraint means
 *    the rep has not named what is limiting them — that card's territory);
 *  - other → the identity_ceiling card (the most general-purpose framing of
 *    the eight). */
export const REFLECTION_CARDS: Record<ConstraintCategory, ReflectionCard> = {
  ...REFLECTION_CARD_TEXT,
  unclear: REFLECTION_CARD_TEXT.lack_of_purpose,
  other: REFLECTION_CARD_TEXT.identity_ceiling,
};

// ---------------------------------------------------------------------------
// Module 3 branch tables
// ---------------------------------------------------------------------------

/** §20.1 — the smaller prompts for the stuck/unsure direction branch. */
export const STUCK_DIRECTION_PROMPTS: string[] = [
  "What would make the next year meaningfully better?",
  "What problem are you most tired of carrying?",
  "What would you be proud to change?",
];

/** §14 3.3 — the exact per-life-area primary-outcome question (all 14). */
export const PRIMARY_OUTCOME_QUESTIONS: Record<LifeArea, string> = {
  income: "If your financial situation improved in a way that genuinely changed your life, what would be different?",
  debt: "What would freedom from, or meaningful progress on, this debt allow you to do or stop worrying about?",
  home: "What would a better or more stable home situation mean for you?",
  family: "How would your family or the people you care about feel the difference if you followed through?",
  health:
    "What would having more energy, strength, or discipline allow you to do differently at work and at home?",
  confidence: "What would you do differently if you trusted yourself to follow through?",
  sales_skill: "What would becoming genuinely stronger in sales allow you to create in your life?",
  leadership: "What kind of leader do you want to become, and who would benefit if you became that person?",
  freedom: "What would more freedom let you choose that you cannot easily choose today?",
  business: "What capability or financial base do you want to build first, and what would it make possible later?",
  education:
    "What skill, credential, or level of capability do you want to develop, and what would it open up for you?",
  relationships: "What would being more intentional in your relationships allow you to create or protect?",
  giving_back: "Who or what would you like to be able to contribute to, and why does that matter?",
  other: "What would meaningful progress in this area change for you?",
};

/** §14 3.4 headline (the component renders it above the question). */
export const THREE_YEAR_HEADLINE = "Set the old labels aside for one minute.";

// ---------------------------------------------------------------------------
// Module 4 branch tables
// ---------------------------------------------------------------------------

/** §15 4.1 — life-area-specific example helper lines (10 areas carry one in
 *  the spec; education/relationships/giving_back/other have none). */
export const ONE_YEAR_EXAMPLES: Record<LifeArea, string[]> = {
  income: ["Example: Earn $___ in the next 12 months while becoming capable of producing that level consistently."],
  debt: ["Example: Pay down $___, or make a defined amount of progress, by [date]."],
  home: ["Example: Save $___ toward a home or move into a more stable living situation by [date]."],
  family: ["Example: Create more stability by earning $___, being present for ___, or accomplishing ___ by [date]."],
  health: ["Example: Train ___ times per week, reach ___, or build a routine that gives me energy by [date]."],
  confidence: ["Example: Become the kind of person who consistently follows through on ___ by [date]."],
  sales_skill: [
    "Example: Become capable of confidently leading a full sales conversation or improving [skill] by [date].",
  ],
  leadership: ["Example: Demonstrate leadership readiness through reliability, skill, and contribution by [date]."],
  freedom: ["Example: Create enough financial stability, skill, or discipline to have more choice by [date]."],
  business: ["Example: Build a specific foundation—savings, skill, network, or income—by [date]."],
  education: [],
  relationships: [],
  giving_back: [],
  other: [],
};

/** §15 4.3 scale anchors (also shown as the confidence step's helper). */
export const SCALE_ANCHORS = {
  low: "1 = I do not yet see the path.",
  high: "10 = I know the path and believe I can execute it.",
} as const;

/** §15 4.3 low-confidence branch — 8 options. */
export const CONFIDENCE_LOW_REASON_OPTIONS: Option[] = [
  { value: "unknown_steps", label: "I do not know the steps." },
  { value: "lack_skill", label: "I lack the skill." },
  { value: "inconsistent_history", label: "I have not been consistent before." },
  { value: "opportunity_doubt", label: "I do not believe the opportunity is real." },
  { value: "fear_of_failure", label: "I am afraid I will fail." },
  { value: "no_support", label: "I do not have support." },
  { value: "goal_too_big", label: "The goal may be too big for the next 12 months." },
  { value: "other", label: "Other." },
];

/** §15 4.3 mid-confidence branch — 9 options. */
export const CONFIDENCE_MID_LEVER_OPTIONS: Option[] = [
  { value: "clearer_plan", label: "Clearer plan" },
  { value: "sales_skill", label: "Better sales skill" },
  { value: "consistency", label: "More consistency" },
  { value: "follow_up", label: "Better follow-up" },
  { value: "coaching", label: "More coaching" },
  { value: "discipline", label: "Better personal discipline" },
  { value: "opportunity_belief", label: "More belief in the opportunity" },
  { value: "outside_support", label: "Support outside work" },
  { value: "other", label: "Other" },
];

/** §15 4.5 — the exact follow-up question per professional-focus selection. */
export const PRO_FOCUS_FOLLOW_UPS: Record<string, string> = {
  consistency: "What promise to yourself do you most need to start keeping?",
  sales_skill: "What sales moment do you most want to become better at?",
  follow_up: "What kind of follow-up or customer ownership do you currently avoid, delay, or underuse?",
  customer_relationships:
    "What would it look like to treat every customer relationship as part of your long-term reputation and opportunity?",
  rejection: "What action do you avoid because you do not want to hear “no”?",
  planning: "What part of your week becomes chaotic because you do not plan it before it starts?",
  feedback: "What are you hesitant to ask a leader or coach to help you with?",
  confidence: "What conversation or situation would you handle differently if you trusted your ability more?",
  leadership:
    "What behavior would someone need to see from you every week before they could trust you with more responsibility?",
  opportunity: "What do you need clarified about your path, the business, or what creates results here?",
  other: "What professional change matters most, and why?",
};

// ---------------------------------------------------------------------------
// Module 5 branch tables + Seven Levels copy
// ---------------------------------------------------------------------------

/** §16 Level 1 — helper chips per primary life area (10 areas carry chip sets
 *  in the spec; education/relationships/giving_back/other show none — no
 *  invented sets). */
export const WHY1_CHIPS: Record<LifeArea, Option[]> = {
  income: [
    { value: "stability", label: "Stability" },
    { value: "less_stress", label: "Less stress" },
    { value: "freedom", label: "Freedom" },
    { value: "pride", label: "Pride" },
    { value: "options", label: "Options" },
    { value: "supporting_others", label: "Supporting others" },
    { value: "proving_something", label: "Proving something to myself" },
    { value: "other", label: "Other" },
  ],
  debt: [
    { value: "relief", label: "Relief" },
    { value: "peace_of_mind", label: "Peace of mind" },
    { value: "freedom", label: "Freedom" },
    { value: "less_fear", label: "Less fear" },
    { value: "better_future", label: "Better future" },
    { value: "supporting_others", label: "Supporting others" },
    { value: "other", label: "Other" },
  ],
  home: [
    { value: "stability", label: "Stability" },
    { value: "security", label: "Security" },
    { value: "pride", label: "Pride" },
    { value: "space_for_family", label: "Space for family" },
    { value: "independence", label: "Independence" },
    { value: "fresh_start", label: "A fresh start" },
    { value: "other", label: "Other" },
  ],
  family: [
    { value: "provision", label: "Provision" },
    { value: "reliability", label: "Reliability" },
    { value: "more_time", label: "More time" },
    { value: "role_model", label: "Being a role model" },
    { value: "reducing_stress", label: "Reducing stress" },
    { value: "giving_opportunities", label: "Giving them opportunities" },
    { value: "other", label: "Other" },
  ],
  health: [
    { value: "energy", label: "Energy" },
    { value: "confidence", label: "Confidence" },
    { value: "longevity", label: "Longevity" },
    { value: "being_present", label: "Being present" },
    { value: "self_respect", label: "Self-respect" },
    { value: "reducing_pain_stress", label: "Reducing pain or stress" },
    { value: "other", label: "Other" },
  ],
  confidence: [
    { value: "trusting_myself", label: "Trusting myself" },
    { value: "keeping_promises", label: "Keeping promises to myself" },
    { value: "speaking_up", label: "Speaking up" },
    { value: "bigger_opportunities", label: "Taking bigger opportunities" },
    { value: "self_respect", label: "Self-respect" },
    { value: "other", label: "Other" },
  ],
  sales_skill: [
    { value: "more_income", label: "More income" },
    { value: "career_growth", label: "Career growth" },
    { value: "confidence", label: "Confidence" },
    { value: "better_service", label: "Better service to customers" },
    { value: "leadership", label: "Leadership" },
    { value: "proving_capability", label: "Proving capability" },
    { value: "other", label: "Other" },
  ],
  leadership: [
    { value: "influence", label: "Influence" },
    { value: "responsibility", label: "Responsibility" },
    { value: "serving_others", label: "Serving others" },
    { value: "career_growth", label: "Career growth" },
    { value: "role_model", label: "Being a role model" },
    { value: "building_bigger", label: "Building something bigger" },
    { value: "other", label: "Other" },
  ],
  freedom: [
    { value: "choice", label: "Choice" },
    { value: "time_control", label: "Time control" },
    { value: "less_stress", label: "Less stress" },
    { value: "travel_experiences", label: "Travel or experiences" },
    { value: "being_present", label: "Being present with people I care about" },
    { value: "other", label: "Other" },
  ],
  business: [
    { value: "independence", label: "Independence" },
    { value: "ownership", label: "Ownership" },
    { value: "family_future", label: "A future for my family" },
    { value: "creating_own", label: "Creating something of my own" },
    { value: "more_options", label: "More options" },
    { value: "other", label: "Other" },
  ],
  education: [],
  relationships: [],
  giving_back: [],
  other: [],
};

/** §16 Level 2 — selectable prompts shown when the answer reads as
 *  "I don't know" or is under 10 meaningful characters (component gates via
 *  shouldOfferWhyFallbackChips). */
export const WHY2_FALLBACK_CHIPS: Option[] = [
  { value: "safer_less_stressed", label: "I would feel safer or less stressed." },
  { value: "more_choices", label: "I would have more choices." },
  { value: "proud", label: "I would feel proud of myself." },
  { value: "more_present", label: "I would be more present for people I care about." },
  { value: "stop_carrying", label: "I would stop carrying a problem I have been avoiding." },
  { value: "believe_more_possible", label: "I would believe more is possible for me." },
  { value: "other", label: "Other." },
];

/** §16 Level 7 — writing scaffold. Never auto-generate the final answer. */
export const CORE_WHY_SCAFFOLD =
  "This matters to me because I want to __________. I am no longer willing to __________. The person I am becoming is someone who __________.";

/** §16 5.3 — the exact dynamic follow-up per primary obstacle. "other" has no
 *  spec variant and reuses the dont_know question (per branch rules, both mean
 *  "the rep has not named the mechanism yet"). */
export const OBSTACLE_FOLLOW_UPS: Record<ObstacleKey, string> = {
  wait_for_motivation: "What would you do differently if action came before motivation, not after it?",
  avoid_rejection: "What is the first action you usually avoid when you fear rejection?",
  distracted: "What distraction costs you the most progress?",
  tired: "What one part of your routine most affects your energy?",
  no_plan: "What is the first moment each week when better planning would help?",
  discouraged: "What story do you tell yourself after a bad day that makes you pull back?",
  blame_circumstances: "What is one thing you can still control even when circumstances are not ideal?",
  dont_ask_help: "What makes it hard to ask for coaching or support sooner?",
  avoid_problem: "What number, conversation, or task do you most avoid when you feel behind?",
  doubt_payoff: "What evidence would help you take your effort more seriously?",
  overcommitted: "What is one thing you need to say no to or reduce to protect your main goal?",
  dont_know:
    "Think about the last time you wanted something but did not follow through. What happened between intention and action?",
  other:
    "Think about the last time you wanted something but did not follow through. What happened between intention and action?",
};

/** §16 5.4 — editable IF pre-populations, first person, each derived from the
 *  obstacle option's own spec wording (or the spec's own IF/THEN examples
 *  where one exists). No new scenarios. */
export const IF_PREFILLS: Record<ObstacleKey, string> = {
  wait_for_motivation: "I wait until I feel motivated",
  avoid_rejection: "I want to avoid a follow-up conversation because I am worried about rejection",
  distracted: "I get distracted",
  tired: "I get tired or do not protect my energy",
  no_plan: "I do not plan my week before it starts",
  discouraged: "I have a bad sales day and start thinking the week is over",
  blame_circumstances: "I start blaming leads, timing, territory, or circumstances",
  dont_ask_help: "I do not ask for help",
  avoid_problem: "I feel behind and want to ignore my numbers",
  doubt_payoff: "I do not actually believe the effort will pay off",
  overcommitted: "I say yes to too many things and lose focus",
  // Derived from the dont_know follow-up's own wording ("What happened between
  // intention and action?") — the option label ("I do not know.") cannot be an
  // IF clause.
  dont_know: "something gets between my intention and my action",
  other: "something gets between my intention and my action",
};

/** §16 5.4 question ("When [most common obstacle] happens, what is one small
 *  action you will take instead?") — the obstacle slot is filled with the
 *  rep's editable IF prefill. */
export function ifThenQuestion(a: AnswerMap): string {
  return `When “${IF_PREFILLS[primaryObstacle(a)]}” happens, what is one small action you will take instead?`;
}

/** §16 5.4 — the 4 IF/THEN examples, verbatim (IF and THEN on separate lines). */
export const IF_THEN_EXAMPLES: string[] = [
  "IF I have a bad sales day and start thinking the week is over,\nTHEN I will review the next opportunity, ask for one piece of coaching, and take the next action before I decide what the day means.",
  "IF I want to avoid a follow-up conversation because I am worried about rejection,\nTHEN I will complete one outreach before I let myself move on to an easier task.",
  "IF I feel behind and want to ignore my numbers,\nTHEN I will open Turf Invaders, look at the data, and choose one next professional action.",
  "IF I wait to feel motivated,\nTHEN I will take one planned action for ten minutes before deciding whether I feel like it.",
];

/** §16 5.5 — the optional-context field's label (shown with the text box). */
export const SUPPORT_CONTEXT_PROMPT = "If you want, add context. This will be shared with Tyler and Shai.";

/** §16 5.6 — the lead-in line above the sentence completion. */
export const IDENTITY_COMMITMENT_LEAD = "Complete this sentence.";

/** §16 5.2 — the four summary blocks on the Core Why reflection card. */
export function coreReflectionBlocks(a: AnswerMap): { label: string; value: string }[] {
  return [
    { label: "MY GOAL", value: answerDisplayText(a[QK.m4_one_year_target]) },
    { label: "MY CORE WHY", value: answerDisplayText(a[QK.why_7]) },
    { label: "WHAT I AM TRYING TO CREATE OR PROTECT", value: answerDisplayText(a[QK.why_6]) },
    { label: "WHAT STAYING THE SAME COULD COST", value: answerDisplayText(a[QK.why_5]) },
  ];
}

// ---------------------------------------------------------------------------
// D) ALL_STEPS — the flat, ordered workshop flow
// ---------------------------------------------------------------------------

export const ALL_STEPS: StepDef[] = [
  // ------------------------------------------------------------------ MODULE 1
  {
    // 1.1 — Welcome story. story steps complete with json {seen: true}.
    key: QK.m1_welcome,
    module: "clear_board",
    kind: "story",
    required: true,
    answerType: "json",
    prompt: "Your past is evidence. It is not a ceiling.",
    storyBody:
      "Most people set their goals based on what they have already seen: what they made last year, what people around them think is realistic, what their family did, or what they have decided someone like them is capable of.\n\nThose experiences matter. But they are not automatically a limit.\n\nBefore we decide what you want next, we are going to separate facts from stories. A fact is something that has happened. A story is the meaning you attach to it.",
    factStoryCard: {
      factLabel: "FACT",
      fact: "I made $90,000 last year.",
      storyLabel: "STORY",
      story: "That means I am only a $90,000-per-year person.",
    },
    footer:
      "You do not have to pretend the future is guaranteed. You only have to be willing to question whether your old ceiling is the truth.",
    cta: "Start",
  },
  {
    // 1.2 — Current direction. text = DirectionKind option value.
    key: QK.m1_direction,
    module: "clear_board",
    kind: "single_select",
    required: true,
    answerType: "text",
    prompt: "Before we talk about what you want, how would you describe your current direction?",
    options: DIRECTION_OPTIONS,
  },
  {
    // 1.3 — Optional private context. text; private-eligible.
    key: QK.m1_life_context,
    module: "clear_board",
    kind: "text",
    required: false,
    answerType: "text",
    prompt:
      "Is there anything about your life right now that affects how you think about work, money, or your future?",
    helper: "This is optional. You can keep this private to yourself.",
    visibilityToggle: true,
    afterAnswerNote:
      "Thank you for being honest. We’ll keep the rest of this focused on what you want to build next.",
  },

  // ------------------------------------------------------------------ MODULE 2
  {
    // 2.1a — Perceived income ceiling. number. Range 0–5,000,000 is enforced
    // by the currency component; no validate fn here.
    key: QK.m2_ceiling_amount,
    module: "ceiling",
    kind: "currency",
    required: true,
    answerType: "number",
    prompt:
      "If you worked seriously hard, used the opportunities available at Tidal, got coached, and stayed consistent for the next 12 months, what do you honestly believe you could earn?",
    helper: "This is not a promise, quota, or commitment. It is your honest current belief.",
  },
  {
    // 2.1b — Ceiling reason, branched by band. text = option value slug;
    // json {otherText?} when "other".
    key: QK.m2_ceiling_reason,
    module: "ceiling",
    kind: "single_select",
    required: true,
    answerType: "text",
    prompt: (a) => {
      const band = ceilingBand(a);
      if (band === "low") {
        return "That may reflect your current reality, a belief about opportunity, or uncertainty about what is possible. Which feels closest?";
      }
      if (band === "high") return "What makes this amount feel possible to you?";
      return "What makes this number feel realistic—but anything meaningfully higher feel less believable?";
    },
    options: (a) => {
      const band = ceilingBand(a);
      if (band === "low") return CEILING_REASON_LOW_OPTIONS;
      if (band === "high") return CEILING_REASON_HIGH_OPTIONS;
      return CEILING_REASON_MID_OPTIONS;
    },
  },
  {
    // §20.2 low-ceiling minimum branch: "ask what would make a higher
    // possibility more believable" — the spec's own instruction phrased as
    // the question, no invented framing.
    key: QK.m2_ceiling_believe,
    module: "ceiling",
    kind: "text",
    required: true,
    answerType: "text",
    when: (a) => ceilingBand(a) === "low",
    prompt: "What would make a higher possibility more believable?",
    helper:
      "Not what would guarantee it — what would you need to see, learn, or experience to take a bigger number seriously?",
  },
  {
    // 2.2 — What makes it a ceiling. text, min 20 chars.
    key: QK.m2_ceiling_story,
    module: "ceiling",
    kind: "text",
    required: true,
    answerType: "text",
    minChars: 20,
    prompt: "What makes that number feel like the most you could earn?",
    helper: "Write the honest answer, not the answer that sounds best.",
    reflectionPrompts: [
      "What have you seen that makes this number feel true?",
      "What have you not seen?",
      "What do you believe about yourself that affects this number?",
      "What would you be afraid to say out loud?",
    ],
  },
  {
    // 2.3 — Belief categories. json string[] of OPTION slugs (first = primary
    // input to primaryConstraint via BELIEF_OPTION_TO_CONSTRAINT).
    key: QK.m2_belief_categories,
    module: "ceiling",
    kind: "multi_select",
    required: true,
    answerType: "json",
    maxSelections: 3,
    prompt: "Which of these is most connected to your answer?",
    options: BELIEF_CATEGORY_OPTIONS,
  },
  {
    // 2.4 — Fact versus story. json {fact, story}. Sub-question copy lives in
    // FACT_STORY_COPY (the dual_text component renders both fields from it).
    key: QK.m2_fact_story,
    module: "ceiling",
    kind: "dual_text",
    required: true,
    answerType: "json",
    prompt: FACT_STORY_COPY.headline,
    validate: (v) => {
      const j = (v?.json ?? {}) as { fact?: unknown; story?: unknown };
      const fact = typeof j.fact === "string" ? j.fact.trim() : "";
      const story = typeof j.story === "string" ? j.story.trim() : "";
      if (fact && detectPredictiveIdentity(fact)) {
        return { level: "block", message: FACT_STORY_COPY.factRewritePrompt };
      }
      if (fact && !story) {
        return { level: "block", message: FACT_STORY_COPY.storyBlankPrompt };
      }
      return null;
    },
  },
  {
    // 2.5 — Origin of story. json string[].
    key: QK.m2_story_origin,
    module: "ceiling",
    kind: "multi_select",
    required: true,
    answerType: "json",
    maxSelections: 3,
    prompt: "Where do you think this story came from?",
    helper: "The goal is not to blame anyone. It is to understand what has been shaping the way you see yourself.",
    options: STORY_ORIGIN_OPTIONS,
  },
  {
    // 2.6 — Outside view. text.
    key: QK.m2_outside_view,
    module: "ceiling",
    kind: "text",
    required: true,
    answerType: "text",
    prompt:
      "Imagine another person joined Tidal with your same age, background, current skill level, and life responsibilities. Over time, they earn two or three times your current ceiling. What would you assume they did differently?",
    helper:
      "Do not write “they got lucky.” Think in terms of skills, habits, decisions, coaching, consistency, relationships, courage, preparation, or actions.",
  },
  {
    // 2.6 follow-up — only when the outside view is external-only.
    key: QK.m2_outside_view_control,
    module: "ceiling",
    kind: "text",
    required: true,
    answerType: "text",
    when: (a) => detectExternalOnly(a[QK.m2_outside_view]?.text ?? ""),
    prompt:
      "Those factors can matter. What is one thing they could still control that you would expect them to do differently?",
  },
  {
    // 2.7 — Personal gap. json string[] (no cap in the spec).
    key: QK.m2_personal_gap,
    module: "ceiling",
    kind: "multi_select",
    required: true,
    answerType: "json",
    prompt:
      "Which of the things you just named are you not yet doing consistently, not yet skilled enough to do, or avoiding?",
    options: PERSONAL_GAP_OPTIONS,
  },
  {
    // §20.3 fear-of-failure / fear-of-success minimum asks. Gated on the
    // named constraint; prompts phrase the spec's own instructions ("ask what
    // failure would mean" / "ask what success might cost or change; let user
    // name tradeoffs"), and the helpers carry §20.3's mandated framing
    // (testable experiment, not identity verdict / tradeoffs named, not
    // pathologized).
    key: QK.m2_fear_cost,
    module: "ceiling",
    kind: "text",
    required: true,
    answerType: "text",
    when: (a) => {
      const c = primaryConstraint(a);
      return c === "fear_of_failure" || c === "fear_of_success";
    },
    prompt: (a) =>
      primaryConstraint(a) === "fear_of_success"
        ? "What might success cost or change for you?"
        : "If you went after this and it did not work, what are you afraid that would mean?",
    helper: (a) =>
      primaryConstraint(a) === "fear_of_success"
        ? "Name the tradeoffs. You do not have to solve them today."
        : "The next 90 days are a test worth running, not a verdict on who you are.",
  },
  {
    // 2.8 — Personalized reflection card (headline + body from REFLECTION_CARDS).
    key: QK.m2_reflection,
    module: "ceiling",
    kind: "story",
    required: true,
    answerType: "json",
    prompt: (a) => REFLECTION_CARDS[primaryConstraint(a)].headline,
    storyBody: (a) => REFLECTION_CARDS[primaryConstraint(a)].body,
    cta: "Build My Future",
  },

  // ------------------------------------------------------------------ MODULE 3
  {
    // 3.1 — Future direction, branched by 1.2 (§14/§20.1). stuck and unsure
    // both take the stuck-style prompt + smaller reflection prompts.
    key: QK.m3_future_direction,
    module: "build_future",
    kind: "text",
    required: true,
    answerType: "text",
    prompt: (a) => {
      const d = directionKind(a);
      if (d === "clear") {
        return "You said you already have direction. What are you actively building over the next year?";
      }
      if (d === "stuck" || d === "unsure") {
        return "Imagine it is one year from today and your life has meaningfully improved. What is different?";
      }
      return "If the next 12 months went right, what would be different in your life?";
    },
    helper:
      "Think beyond work. Income, home, family, confidence, health, freedom, skill, leadership, or peace of mind all count.",
    reflectionPrompts: (a) => {
      const d = directionKind(a);
      return d === "stuck" || d === "unsure" ? STUCK_DIRECTION_PROMPTS : [];
    },
  },
  {
    // §20.1 clear branch — what makes follow-through difficult despite clarity.
    key: QK.m3_followthrough_difficulty,
    module: "build_future",
    kind: "text",
    required: true,
    answerType: "text",
    when: (a) => directionKind(a) === "clear",
    prompt: "You have clarity. What makes follow-through difficult anyway?",
    helper: "Direction is not the same as consistency. Name what gets between you and the work.",
  },
  {
    // 3.2 — Life areas. json string[] of LifeArea slugs (first = primary).
    key: QK.m3_life_areas,
    module: "build_future",
    kind: "multi_select",
    required: true,
    answerType: "json",
    maxSelections: 3,
    prompt: "Which areas matter most to you right now?",
    helper: "Select up to three. The first area you pick is the one we build from.",
    options: LIFE_AREAS.map((value) => ({ value, label: LIFE_AREA_LABELS[value] })),
  },
  {
    // 3.3 — Primary future outcome, exact question per primary life area.
    key: QK.m3_primary_outcome,
    module: "build_future",
    kind: "text",
    required: true,
    answerType: "text",
    prompt: (a) => PRIMARY_OUTCOME_QUESTIONS[primaryLifeArea(a)],
  },
  {
    // 3.4 — Three-year possibility. text = the possibility; number = optional
    // dollar amount (the component shows an optional currency field).
    // Headline is THREE_YEAR_HEADLINE (exported above).
    key: QK.m3_three_year,
    module: "build_future",
    kind: "text",
    required: true,
    answerType: "text",
    prompt:
      "If you removed past income, past mistakes, other people’s expectations, and fear of failing, what would be an exciting but meaningful three-year possibility for your life?",
    helper: "This is not a guarantee and not a quota. It is a possibility worth exploring.",
    validate: (v) => {
      const text = (v?.text ?? "").trim();
      if (text && detectVague(text)) {
        return {
          level: "coach",
          message:
            "What would that look like in the real world? Name a result, change, experience, skill, or milestone you could recognize.",
        };
      }
      return null;
    },
  },
  {
    // 3.5 — Belief to question. text. Template in helper, example lines in
    // examples. No forced positive affirmation.
    key: QK.m3_belief_to_question,
    module: "build_future",
    kind: "text",
    required: true,
    answerType: "text",
    prompt: "Write the belief you are willing to question from today forward.",
    helper:
      "Instead of saying, “__________,” I am willing to ask, “What would I need to learn, become, and do consistently to make ________ more possible?”",
    examples: [
      "Old belief: I’m not the kind of person who can make $250,000.",
      "Better question: What would I need to learn, become, and do consistently to give myself a real shot at creating that level of value?",
    ],
  },

  // ------------------------------------------------------------------ MODULE 4
  {
    // 4.1 — One-year target. text. Life-area example line where the spec has one.
    key: QK.m4_one_year_target,
    module: "make_real",
    kind: "text",
    required: true,
    answerType: "text",
    prompt: "What is the one outcome you most want to create over the next 12 months?",
    examples: (a) => ONE_YEAR_EXAMPLES[primaryLifeArea(a)],
  },
  {
    // 4.2 — Evidence and date. json {outcome, date: "yyyy-mm-dd"}. The missing
    // date is a required-completeness block (no message needed here).
    key: QK.m4_evidence,
    module: "make_real",
    kind: "evidence_date",
    required: true,
    answerType: "json",
    prompt: "How will you know you achieved it?",
    examples: [
      "Complete 100 workouts.",
      "Make 12 months of on-time payments.",
      "Become trusted to lead a team meeting.",
      "Build a consistent routine for 90 days.",
      "Reach a savings target.",
      "Move into a better housing situation.",
      "Improve a defined sales skill with documented coaching.",
    ],
    validate: (v) => {
      const j = (v?.json ?? {}) as { outcome?: unknown };
      const outcome = typeof j.outcome === "string" ? j.outcome.trim() : "";
      if (outcome && !hasRecognizableEvidence(outcome)) {
        return {
          level: "coach",
          message:
            "Try making this more recognizable. What would you be able to point to, measure, complete, save, earn, build, improve, or experience?",
        };
      }
      return null;
    },
  },
  {
    // 4.3 — Confidence calibration. number 1–10.
    key: QK.m4_confidence,
    module: "make_real",
    kind: "scale",
    required: true,
    answerType: "number",
    prompt: "On a scale of 1–10, how confident are you that you can create this outcome in the next 12 months?",
    helper: `${SCALE_ANCHORS.low} ${SCALE_ANCHORS.high}`,
  },
  {
    // 4.3 low branch — biggest reason confidence is low.
    key: QK.m4_confidence_reason,
    module: "make_real",
    kind: "single_select",
    required: true,
    answerType: "text",
    when: (a) => confidenceBand(a) === "low",
    prompt: "What is the biggest reason your confidence is low?",
    helper:
      "A very low score does not mean the goal is wrong. It may mean the path feels unclear, the target is too far away right now, or you need more support.",
    options: CONFIDENCE_LOW_REASON_OPTIONS,
  },
  {
    // 4.3 low branch — the one-point question.
    key: QK.m4_confidence_one_point,
    module: "make_real",
    kind: "text",
    required: true,
    answerType: "text",
    when: (a) => confidenceBand(a) === "low",
    prompt: "What would make your confidence move up by one point—not to ten, just one point?",
  },
  {
    // 4.3 mid branch — confidence lever.
    key: QK.m4_confidence_lever,
    module: "make_real",
    kind: "single_select",
    required: true,
    answerType: "text",
    when: (a) => confidenceBand(a) === "mid",
    prompt: "What would most increase your confidence?",
    helper: "This is often a useful zone: the goal matters, but it will require growth.",
    options: CONFIDENCE_MID_LEVER_OPTIONS,
  },
  {
    // 4.3 high branch — overconfidence risk.
    key: QK.m4_overconfidence_risk,
    module: "make_real",
    kind: "text",
    required: true,
    answerType: "text",
    when: (a) => confidenceBand(a) === "high",
    prompt: "What could still get in your way if you became too comfortable or assumed it would happen automatically?",
    helper: "Strong confidence is useful when it is paired with specific action.",
  },
  {
    // 4.4 — 90-day mission. text.
    key: QK.m4_mission_90,
    module: "make_real",
    kind: "text",
    required: true,
    answerType: "text",
    prompt:
      "What is the most important thing you need to prove, build, improve, or change in the next 90 days to move toward your one-year target?",
    helper: "Make this a bridge, not the entire mountain.",
    examples: [
      "Become consistent with the follow-up and customer ownership I have been avoiding.",
      "Build confidence through weekly deal review and stronger discovery.",
      "Create a routine I can actually maintain.",
      "Become more reliable and prepared so I can earn more opportunity.",
      "Learn how to turn more of my current opportunities into sales.",
      "Stop letting rejection decide how hard I work.",
      "Create a financial plan and save the first $___.",
      "Build the discipline to do what I said I would do.",
    ],
    validate: (v, a) => {
      const mission = (v?.text ?? "").trim();
      const oneYear = (a[QK.m4_one_year_target]?.text ?? "").trim();
      if (mission && oneYear && detectRepeatsGoal(mission, oneYear)) {
        return {
          level: "coach",
          message:
            "Your 90-day mission should be the next bridge. What must change first before the full one-year target becomes more likely?",
        };
      }
      return null;
    },
  },
  {
    // 4.5 — Professional focus. text = option value slug.
    key: QK.m4_pro_focus,
    module: "make_real",
    kind: "single_select",
    required: true,
    answerType: "text",
    prompt:
      "Inside your role at Tidal, what professional change would make the biggest difference toward your 90-day mission?",
    options: PRO_FOCUS_OPTIONS,
  },
  {
    // 4.5 follow-up — exactly one corresponding question per selection.
    key: QK.m4_pro_focus_detail,
    module: "make_real",
    kind: "text",
    required: true,
    answerType: "text",
    prompt: (a) => {
      const focus = a[QK.m4_pro_focus]?.text ?? "";
      return PRO_FOCUS_FOLLOW_UPS[focus] ?? PRO_FOCUS_FOLLOW_UPS.other;
    },
  },
  {
    // 4.6 — Personal support focus. text = option value slug.
    key: QK.m4_personal_focus,
    module: "make_real",
    kind: "single_select",
    required: true,
    answerType: "text",
    prompt:
      "Outside of work, what personal habit or support would make it easier for you to show up as the person who can pursue this goal?",
    options: PERSONAL_FOCUS_OPTIONS,
  },
  {
    // 4.6 follow-up — optional but strongly encouraged; private-eligible.
    // Skipped entirely when the rep chose "I do not need to focus on
    // something outside work right now".
    key: QK.m4_personal_focus_change,
    module: "make_real",
    kind: "text",
    required: false,
    answerType: "text",
    when: (a) => (a[QK.m4_personal_focus]?.text ?? "") !== "none_needed",
    prompt: "What is one realistic change you are willing to make in the next 30 days?",
    helper: "Optional but strongly encouraged.",
    visibilityToggle: true,
  },

  // ------------------------------------------------------------------ MODULE 5
  {
    // 5.1 — Explain the Seven Whys.
    key: QK.m5_why_intro,
    module: "keep_promise",
    kind: "story",
    required: true,
    answerType: "json",
    prompt: "A goal is stronger when you know what is underneath it.",
    storyBody:
      "“Make more money,” “become better at sales,” and “get more disciplined” can be real goals. But they are usually not the deepest reason someone keeps going when work gets uncomfortable.\n\nWe are going to go deeper than the first answer. Not because there is a perfect answer—but because the real reason often sits underneath the surface.\n\nYou can keep deeply personal details private.",
    cta: "Find My Why",
  },
  {
    // Level 1 — Immediate meaning. text = the sentence.
    key: QK.why_1,
    module: "keep_promise",
    kind: "why",
    required: true,
    answerType: "text",
    prompt: (a) =>
      `Your one-year target is: “${quoteAnswer(a, QK.m4_one_year_target, {
        max: 120,
        fallback: "your one-year target",
      })}.” Why is reaching this important to you right now?`,
    chips: (a) => WHY1_CHIPS[primaryLifeArea(a)],
    validate: (v, a) => chipOnlyIssue(v?.text, WHY1_CHIPS[primaryLifeArea(a)]),
  },
  {
    // Level 2 — Personal impact. Chips appear only when the draft reads as
    // "I don't know" / under 10 meaningful characters (component behavior via
    // shouldOfferWhyFallbackChips); they are defined here regardless.
    key: QK.why_2,
    module: "keep_promise",
    kind: "why",
    required: true,
    answerType: "text",
    prompt: (a) =>
      `You said “${whyQuote(a, 1)}.” If that became true, what would it change about the way you live, feel, or show up every day?`,
    chips: WHY2_FALLBACK_CHIPS,
    validate: (v) => chipOnlyIssue(v?.text, WHY2_FALLBACK_CHIPS),
  },
  {
    // Level 3 — Values and identity. The spec's material-only deeper question
    // is attached as a coach issue when the answer reads vague.
    key: QK.why_3,
    module: "keep_promise",
    kind: "why",
    required: true,
    answerType: "text",
    prompt: (a) =>
      `You said it would change “${whyQuote(a, 2)}.” Why does that change matter to the kind of person you want to become?`,
    helper:
      "Think about values such as security, freedom, responsibility, growth, self-respect, contribution, family, courage, discipline, reliability, leadership, or peace.",
    validate: (v) => {
      const text = (v?.text ?? "").trim();
      // §16 Level 3: a material-outcome-only answer ("I can buy a car") earns
      // the deeper ask; so does a plain vague one.
      if (text && (detectVague(text) || detectMaterialOnly(text))) {
        return {
          level: "coach",
          message: "What would having that make you feel, protect, prove, or allow in your life?",
        };
      }
      return null;
    },
  },
  {
    // Level 4 — Relationships and legacy. Privacy-markable; when private, a
    // non-invasive category is collected for leadership (json {category}).
    key: QK.why_4,
    module: "keep_promise",
    kind: "why",
    required: true,
    answerType: "text",
    visibilityToggle: true,
    privateCategoryOptions: WHY4_PRIVATE_CATEGORIES,
    prompt: (a) =>
      `If you became more like the person you described—someone with “${whyQuote(a, 3)}”—who would feel the difference, and how?`,
  },
  {
    // Level 5 — What is at stake. Prompt references why_4's text, or (when
    // only a category was shared) its category label, or a neutral fallback.
    key: QK.why_5,
    module: "keep_promise",
    kind: "why",
    required: true,
    answerType: "text",
    visibilityToggle: true,
    privateCategoryOptions: WHY5_PRIVATE_CATEGORIES,
    prompt: (a) => {
      const w4 = a[QK.why_4];
      const text = (w4?.text ?? "").trim();
      const category = (w4?.json as { category?: string } | undefined)?.category;
      const categoryLabel = WHY4_PRIVATE_CATEGORIES.find((o) => o.value === category)?.label;
      // The rep always sees their own text (privacy gates leadership, not the
      // rep) — whyQuote handles truncation once we know text exists.
      const subject = text ? whyQuote(a, 4, { max: 120 }) : (categoryLabel ?? "the people who matter to you");
      return `You said this could affect “${subject}.” What are you most afraid will happen if you keep living and working exactly as you do now?`;
    },
    helper: "This is not about shame. It is about being honest about what staying the same could cost.",
  },
  {
    // Level 6 — Core need / core value. json {values: string[]} (≤3 chips) +
    // text = the sentence the rep writes.
    key: QK.why_6,
    module: "keep_promise",
    kind: "why",
    required: true,
    answerType: "text",
    visibilityToggle: true,
    prompt:
      "Underneath the goal, the change, and the fear of staying the same, what do you believe you are truly trying to create or protect in your life?",
    chips: CORE_VALUE_CHIPS,
    // maxSelections semantics for the chip picker (component enforces ≤3).
    maxSelections: 3,
    validate: (v) => chipOnlyIssue(v?.text, CORE_VALUE_CHIPS),
  },
  {
    // Level 7 — Core Why statement. User-authored; scaffold blanks must be
    // finished (CORE_WHY_SCAFFOLD is exported for the component).
    key: QK.why_7,
    module: "keep_promise",
    kind: "why",
    required: true,
    answerType: "text",
    visibilityToggle: true,
    prompt: "Put it in your own words: why is this goal worth working through discomfort for?",
    validate: (v) => {
      const text = (v?.text ?? "").trim();
      if (!text || text.includes("__________")) {
        return { level: "block", message: "Finish each blank in your own words — this one has to be yours." };
      }
      return null;
    },
  },
  {
    // 5.2 — Core Why reflection. The spec gives this card no headline; the
    // four blocks (coreReflectionBlocks) are the card, the display line rides
    // in footer. storyBody is a simple joined-string fallback rendering.
    key: QK.m5_core_reflection,
    module: "keep_promise",
    kind: "story",
    required: true,
    answerType: "json",
    prompt: "",
    storyBody: (a) =>
      coreReflectionBlocks(a)
        .map((b) => `${b.label}\n${b.value}`)
        .join("\n\n"),
    footer:
      "This is not something you have to share publicly. It is your reason to remember when the easier choice shows up.",
    cta: "Build My Response Plan",
  },
  {
    // 5.3 — Internal obstacle. json string[] of ObstacleKey (first = primary).
    key: QK.m5_obstacles,
    module: "keep_promise",
    kind: "multi_select",
    required: true,
    answerType: "json",
    maxSelections: 2,
    prompt: "When you do not follow through on something that matters to you, what usually happens first?",
    options: OBSTACLE_OPTIONS,
  },
  {
    // 5.3 follow-up — exact question per primary obstacle.
    key: QK.m5_obstacle_detail,
    module: "keep_promise",
    kind: "text",
    required: true,
    answerType: "text",
    prompt: (a) => OBSTACLE_FOLLOW_UPS[primaryObstacle(a)],
  },
  {
    // 5.4 — If–Then plan. json {if, then}. IF prefills come from IF_PREFILLS;
    // the interpolated question line is ifThenQuestion(a).
    key: QK.m5_if_then,
    module: "keep_promise",
    kind: "if_then",
    required: true,
    answerType: "json",
    prompt: "Make a plan for the moment your obstacle shows up.",
    helper:
      "An if–then plan does not guarantee success. It gives you a response before the excuse, fear, or distraction gets to decide for you.",
    examples: IF_THEN_EXAMPLES,
    validate: (v) => {
      const j = (v?.json ?? {}) as { then?: unknown };
      const thenPart = typeof j.then === "string" ? j.then.trim() : "";
      if (thenPart && detectNonObservable(thenPart)) {
        return {
          level: "block",
          message: "Make the response observable. What exactly will you do, for how long, or with whom?",
        };
      }
      return null;
    },
  },
  {
    // 5.5 — Leadership support request. json {selections: string[], context?}.
    key: QK.m5_support_request,
    module: "keep_promise",
    kind: "multi_select",
    required: true,
    answerType: "json",
    maxSelections: 2,
    prompt: "What would help you most from Tyler and Shai as you work toward this?",
    helper: SUPPORT_CONTEXT_PROMPT,
    options: SUPPORT_REQUEST_OPTIONS,
  },
  {
    // 5.6 — 90-day identity commitment. text = the completion of the sentence.
    // The lead-in line is IDENTITY_COMMITMENT_LEAD.
    key: QK.m5_identity_commitment,
    module: "keep_promise",
    kind: "text",
    required: true,
    answerType: "text",
    prompt: "For the next 90 days, I am choosing to become someone who __________.",
    helper: "Make this about identity and behavior, not perfection.",
    examples: [
      "keeps promises to myself after the initial excitement fades.",
      "does not let rejection decide my effort.",
      "asks for coaching before I get stuck.",
      "acts like my future matters more than my comfort.",
      "uses my opportunities with more intention.",
      "becomes more disciplined in and outside of work.",
    ],
  },
  {
    // 5.7 — Final review. All copy lives in REVIEW_COPY + REVIEW_SECTIONS;
    // prompt carries the display line (same string, single source).
    key: QK.m5_review,
    module: "keep_promise",
    kind: "review",
    required: true,
    answerType: "json",
    prompt: "Your plan does not need to be perfect today. It needs to be honest enough to guide your next decision.",
  },
];

// ---------------------------------------------------------------------------
// E) REVIEW_SECTIONS — the §16 5.7 layout, in order. render → null omits a row.
//    ctx.maskPrivate = true for the leadership view (private free text hides).
// ---------------------------------------------------------------------------

export const REVIEW_SECTIONS: {
  label: string;
  render: (a: AnswerMap, ctx: { maskPrivate: boolean }) => string | null;
}[] = [
  {
    label: "MY CURRENT CEILING",
    render: (a) => {
      const n = a[QK.m2_ceiling_amount]?.number;
      return n == null || Number.isNaN(n) ? null : usd.format(n);
    },
  },
  {
    label: "THE FACT",
    render: (a) => {
      const j = (a[QK.m2_fact_story]?.json ?? {}) as { fact?: unknown };
      const fact = typeof j.fact === "string" ? j.fact.trim() : "";
      return fact || null;
    },
  },
  {
    label: "THE STORY I AM QUESTIONING",
    render: (a) => {
      const j = (a[QK.m2_fact_story]?.json ?? {}) as { story?: unknown };
      const story = typeof j.story === "string" ? j.story.trim() : "";
      return story || null;
    },
  },
  {
    label: "MY THREE-YEAR POSSIBILITY",
    render: (a) => {
      const v = a[QK.m3_three_year];
      const text = (v?.text ?? "").trim();
      if (!text) return null;
      return v?.number != null && !Number.isNaN(v.number) ? `${text} — ${usd.format(v.number)}` : text;
    },
  },
  {
    label: "MY ONE-YEAR TARGET",
    render: (a) => {
      const target = (a[QK.m4_one_year_target]?.text ?? "").trim();
      if (!target) return null;
      const j = (a[QK.m4_evidence]?.json ?? {}) as { date?: unknown };
      // Kept as the stored yyyy-mm-dd string — no Date parsing here (avoids
      // the UTC-midnight/Pacific off-by-one; display formatting is UI's call).
      const date = typeof j.date === "string" && j.date ? j.date : null;
      return date ? `${target} — by ${date}` : target;
    },
  },
  {
    label: "MY SEVEN LEVELS OF WHY",
    render: (a, ctx) => {
      const keys = [QK.why_1, QK.why_2, QK.why_3, QK.why_4, QK.why_5, QK.why_6];
      const lines = keys
        .map((key, i) => {
          const v = a[key];
          if (!v) return null;
          const masked = ctx.maskPrivate && v.visibility === "private_to_rep";
          const text = masked ? "Private" : (v.text ?? "").trim();
          return text ? `Level ${i + 1}: ${text}` : null;
        })
        .filter((line): line is string => line != null);
      return lines.length ? lines.join("\n") : null;
    },
  },
  {
    label: "MY CORE WHY",
    render: (a, ctx) => {
      const v = a[QK.why_7];
      const text = (v?.text ?? "").trim();
      if (!text) return null;
      return ctx.maskPrivate && v?.visibility === "private_to_rep" ? "Private" : text;
    },
  },
  {
    label: "THE COST OF STAYING THE SAME",
    render: (a, ctx) => {
      const v = a[QK.why_5];
      if (!v) return null;
      if (ctx.maskPrivate && v.visibility === "private_to_rep") {
        const category = (v.json as { category?: string } | undefined)?.category;
        return WHY5_PRIVATE_CATEGORIES.find((o) => o.value === category)?.label ?? null;
      }
      const text = (v.text ?? "").trim();
      return text || null;
    },
  },
  {
    label: "MY 90-DAY MISSION",
    render: (a) => (a[QK.m4_mission_90]?.text ?? "").trim() || null,
  },
  {
    label: "MY PROFESSIONAL FOCUS",
    render: (a) => {
      const value = (a[QK.m4_pro_focus]?.text ?? "").trim();
      if (!value) return null;
      const label = PRO_FOCUS_OPTIONS.find((o) => o.value === value)?.label ?? value;
      const detail = (a[QK.m4_pro_focus_detail]?.text ?? "").trim();
      return detail ? `${label} — ${detail}` : label;
    },
  },
  {
    label: "MY PERSONAL SUPPORT FOCUS",
    render: (a, ctx) => {
      const value = (a[QK.m4_personal_focus]?.text ?? "").trim();
      if (!value) return null;
      const label = PERSONAL_FOCUS_OPTIONS.find((o) => o.value === value)?.label ?? value;
      const change = a[QK.m4_personal_focus_change];
      const changeText = (change?.text ?? "").trim();
      const changeVisible = changeText && !(ctx.maskPrivate && change?.visibility === "private_to_rep");
      return changeVisible ? `${label} — ${changeText}` : label;
    },
  },
  {
    label: "MY IF–THEN PLAN",
    render: (a) => {
      const j = (a[QK.m5_if_then]?.json ?? {}) as { if?: unknown; then?: unknown };
      const ifPart = typeof j.if === "string" ? j.if.trim() : "";
      const thenPart = typeof j.then === "string" ? j.then.trim() : "";
      if (!ifPart && !thenPart) return null;
      return `IF ${ifPart},\nTHEN ${thenPart}`;
    },
  },
  {
    label: "MY 90-DAY IDENTITY COMMITMENT",
    render: (a) => {
      const text = (a[QK.m5_identity_commitment]?.text ?? "").trim();
      if (!text) return null;
      return `For the next 90 days, I am choosing to become someone who ${text}`;
    },
  },
];

// ---------------------------------------------------------------------------
// F) §18.4 — Dynamic purpose reminder (Purpose Home, Section 4)
// ---------------------------------------------------------------------------

const REMINDER_LINES = {
  stability:
    "You said stability for the people you care about matters. What would the person building that stability do next?",
  leadership:
    "You said you want to become a leader. Leadership starts before the title—with reliability when nobody is watching.",
  skill:
    "You said you want to become stronger at sales. Skill grows through honest feedback and repeated practice, not waiting to feel ready.",
  consistency: "You said consistency is the gap. Your next promise matters more than your last excuse.",
  rejection:
    "You said rejection pulls you back. Your if–then plan exists for the exact moment you want to avoid the next move.",
  clarity: "Clarity grows when you keep asking what matters and make the next honest decision.",
} as const;

export function pickReminderLine(a: AnswerMap): string {
  const area = primaryLifeArea(a);
  if (area === "family" || area === "income") return REMINDER_LINES.stability;
  if (area === "leadership") return REMINDER_LINES.leadership;
  if (area === "sales_skill") return REMINDER_LINES.skill;
  const constraint = primaryConstraint(a);
  if (constraint === "consistency") return REMINDER_LINES.consistency;
  if (constraint === "rejection_avoidance") return REMINDER_LINES.rejection;
  // lack_of_purpose / unclear — and the final fallback — share the clarity line.
  return REMINDER_LINES.clarity;
}

// ---------------------------------------------------------------------------
// G) Entry, review, completion, empty-state and error copy
// ---------------------------------------------------------------------------

/** §10.1 landing card (plus the §10.2 resume lines). */
export const LANDING_COPY = {
  // §6 — the feature's subtitle, shown under the nav name on entry surfaces.
  subtitle: "Build the life. Earn it on purpose.",
  headline: "Your work should be connected to something bigger than the next appointment.",
  body: "You can be trained on scripts, follow-up, and closing all day. But if you are not clear on what you are building, doing nothing will usually feel easier than doing the hard thing. This experience helps you get honest about the beliefs that may be limiting you, choose a goal that matters, and put it into words.",
  commitments: [
    "Private from other reps.",
    "Tyler and Shai can review your professional plan to mentor you better.",
    "Takes about 35–45 minutes. Your progress saves automatically.",
  ],
  ackText: "I understand this is a personal and professional clarity exercise, not a guarantee of income or outcome.",
  primaryCta: "Start My Purpose",
  secondaryCta: "Save for later",
  // §10.2 — in progress
  resumeHeadline: "You’re right where you left off.",
  resumeCta: "Continue My Purpose",
} as const;

/** §16 5.7 review-screen copy. */
export const REVIEW_COPY = {
  displayLine:
    "Your plan does not need to be perfect today. It needs to be honest enough to guide your next decision.",
  ackText:
    "I understand Tyler and Shai will review my professional plan so they can mentor and coach me more effectively.",
  primaryCta: "Save My Purpose",
} as const;

/** §17 completion screen. */
export const COMPLETION_COPY = {
  headline: "You now have a direction.",
  body: "You named the story that may be limiting you. You chose a future worth working toward. You identified why it matters underneath the surface. And you created a 90-day bridge between where you are and where you want to go.",
  closing:
    "Your goal is not a promise. It is a direction. The next proof comes from what you choose to do when comfort is easier.",
  primaryCta: "Go to My Purpose Home",
  secondaryCta: "Review My Answers",
} as const;

/** §22 empty states. */
export const EMPTY_STATE_COPY = {
  not_started:
    "You have not built your Purpose Profile yet. When you are ready, this is where you will clarify what you are building and why it matters.",
  in_progress: "You have started. Your answers are saved. Continue when you are ready.",
  no_crm: "Your current performance data is not available here yet. Your Purpose Profile is still saved and available.",
  no_leadership_notes: "No leadership follow-up has been added yet.",
  private_field: "This response was marked private by the rep.",
} as const;

/** §23 error states. */
export const ERROR_COPY = {
  save_failure:
    "We could not save that answer right now. Your response is still on this device. Please try again before leaving this page.",
  session_timeout: "Your session expired, but your saved progress is still here. Sign back in to continue.",
  unauthorized: "You do not have access to this part of Turf Invaders.",
  canvasser: "My Purpose for canvassers is coming later. This first version is built for the sales team.",
} as const;

/** §18.2 — the scoreboard's mandatory framing line. */
export const SCOREBOARD_COPY = {
  feedbackLine: "These numbers are not your identity. They are feedback you can use.",
} as const;

/** §16 Levels 4–5 privacy affordance — the spec quotes this exact string. */
export const KEEP_PRIVATE_AFFORDANCE = "I want to keep this private.";

/** Gap-fill (no spec copy exists): the ask that pairs a private Level 4/5
 *  answer with its leadership-visible category. */
export const PRIVATE_CATEGORY_PROMPT =
  "Keep the words private — just give Tyler and Shai the category";
