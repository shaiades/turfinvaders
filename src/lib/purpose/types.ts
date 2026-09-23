// My Purpose — shared workshop types. This file is the CONTRACT between the
// content file (src/data/purpose-workshop-content.ts), the pure engine
// (src/lib/purpose/engine.ts), the persistence adapter (src/hooks/usePurpose*)
// and the step components (src/components/purpose/). Keep it import-free so
// the verify script (scripts/verify-purpose-engine.ts) can load everything
// without touching React or supabase.

export type ModuleKey =
  | "clear_board"
  | "ceiling"
  | "build_future"
  | "make_real"
  | "keep_promise";

export type Visibility = "leadership_shared" | "private_to_rep";

/** One answer, engine-side. Mirrors what the persistence adapter reads/writes
 *  (purpose_answers columns or a typed table's fields, depending on the key). */
export type AnswerValue = {
  text?: string;
  number?: number;
  /** ISO yyyy-mm-dd */
  date?: string;
  /** Multi-selects, chip picks, dual/if-then composites. */
  json?: unknown;
  /** Only meaningful on steps with visibilityToggle. */
  visibility?: Visibility;
  /** Local bookkeeping for merge-on-resume; never sent to the server. */
  updatedAt?: string;
};

export type AnswerMap = Readonly<Record<string, AnswerValue>>;

export type StepKind =
  | "story" // full-copy card, single CTA (1.1, 2.8, 5.1, 5.2)
  | "single_select" // tappable option cards
  | "multi_select" // capped multi-select
  | "text" // textarea (+ optional chips that seed text)
  | "dual_text" // 2.4 fact/story — json {fact, story}
  | "currency" // 2.1a; 3.4's optional amount lives inside its text step
  | "scale" // 4.3 1–10
  | "evidence_date" // 4.2 — json {outcome, date}
  | "if_then" // 5.4 — json {if, then}
  | "why" // Seven Levels: text + chips + optional privacy + category-on-private
  | "review"; // 5.7

export type Option = { value: string; label: string };

/** Anything that varies with prior answers is `T | (a: AnswerMap) => T`.
 *  Every function MUST return a sensible default for an empty/partial map —
 *  that rule is what makes "no branch dead-ends" checkable. */
export type Dyn<T> = T | ((a: AnswerMap) => T);

export type StepIssue = {
  /** block: Continue stays disabled until the detector passes.
   *  coach: inline callout; a subsequent edit arms the next Continue. */
  level: "block" | "coach";
  message: string;
};

export type StepDef = {
  /** Stable question_key (persistence contract — see questionKeys.ts). */
  key: string;
  module: ModuleKey;
  kind: StepKind;
  /** false → the step shows a Skip affordance (1.3, 4.6 follow-up). */
  required: boolean;
  prompt: Dyn<string>;
  helper?: Dyn<string>;
  /** Rendered as the spec's example cards / example lists. */
  examples?: Dyn<string[]>;
  /** kind "story": the long copy. Paragraphs split on blank lines. */
  storyBody?: Dyn<string>;
  /** story CTA label ("Start", "Find My Why", "Build My Future"…). */
  cta?: string;
  /** kind "story": an optional FACT/STORY-style contrast card. */
  factStoryCard?: { factLabel: string; fact: string; storyLabel: string; story: string };
  /** Footer line under a story body (1.1). */
  footer?: Dyn<string>;
  options?: Dyn<Option[]>;
  /** 2.3/2.5 = 3, 5.3/5.5 = 2. Only for multi_select. */
  maxSelections?: number;
  /** Quick-picks that seed the textarea (Why L1/L6, vague fallbacks). */
  chips?: Dyn<Option[]>;
  /** Rotating optional reflection prompts under the field (2.2, stuck 3.1). */
  reflectionPrompts?: Dyn<string[]>;
  /** Minimum characters for text-y kinds (2.2 = 20). */
  minChars?: number;
  /** Adds the spec's "I'm not sure" style option to a select. */
  notSure?: boolean;
  /** Shows the Private-to-me / Share-with-Tyler-and-Shai toggle. */
  visibilityToggle?: boolean;
  /** why_4 / why_5: required category select when marked private. */
  privateCategoryOptions?: Option[];
  /** Omitted = always included in the resolved flow. */
  when?: (a: AnswerMap) => boolean;
  /** Pure; composed from validators.ts. Return null when fine. */
  validate?: (v: AnswerValue | undefined, a: AnswerMap) => StepIssue | null;
  /** Persistence hint for purpose_answers.answer_type routing. */
  answerType: "text" | "number" | "date" | "json";
  /** 5.7 review rows; also feeds the completion screen and Purpose Home. */
  reviewSection?: { label: string; render: (a: AnswerMap) => string };
  /** A short confirmation line shown after answering (1.3 thank-you). */
  afterAnswerNote?: string;
};

export type ModuleMeta = {
  key: ModuleKey;
  /** 1-based — "Part 2 of 5". */
  index: number;
  /** "The Ceiling" */
  label: string;
  /** One-sentence module rationale shown under the label. */
  rationale: string;
  /** Progress weight; all five must sum to 100. */
  weight: number;
};

// ---------------------------------------------------------------------------
// Category vocabularies (stored as slugs; labels live in the content file)
// ---------------------------------------------------------------------------

export const LIFE_AREAS = [
  "income",
  "debt",
  "home",
  "family",
  "health",
  "confidence",
  "sales_skill",
  "leadership",
  "freedom",
  "business",
  "education",
  "relationships",
  "giving_back",
  "other",
] as const;
export type LifeArea = (typeof LIFE_AREAS)[number];

export const CONSTRAINT_CATEGORIES = [
  "sales_skill",
  "consistency",
  "rejection_avoidance",
  "opportunity_belief",
  "identity_ceiling",
  "fear_of_success",
  "fear_of_failure",
  "lack_of_purpose",
  "unclear",
  "other",
] as const;
export type ConstraintCategory = (typeof CONSTRAINT_CATEGORIES)[number];

export const OBSTACLE_KEYS = [
  "wait_for_motivation",
  "avoid_rejection",
  "distracted",
  "tired",
  "no_plan",
  "discouraged",
  "blame_circumstances",
  "dont_ask_help",
  "avoid_problem",
  "doubt_payoff",
  "overcommitted",
  "dont_know",
  "other",
] as const;
export type ObstacleKey = (typeof OBSTACLE_KEYS)[number];

export type DirectionKind = "clear" | "stuck" | "inconsistent" | "vague" | "week_focus" | "unsure";
export type CeilingBand = "low" | "mid" | "high";
export type ConfidenceBand = "low" | "mid" | "high";

export const GOAL_TYPES = [
  "possibility_3_year",
  "target_1_year",
  "mission_90_day",
  "professional_focus",
  "personal_focus",
] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

/** Rep-owned workshop lifecycle (leadership coaching state lives separately
 *  in purpose_profiles.leadership_status). */
export type PurposeStatus = "not_started" | "in_progress" | "submitted";
export type LeadershipStatus = "needs_review" | "follow_up_set" | "discussed" | "ongoing";

// ---------------------------------------------------------------------------
// Narrow persistence interface the workshop hook drives (implemented by the
// adapter in usePurposeWorkshop; stubbed by the verify script).
// ---------------------------------------------------------------------------

export type SavePosition = { module: ModuleKey; stepKey: string };

export interface PurposePersistence {
  /** Route a single answer to its home table (RPC / typed upsert). */
  saveAnswer(key: string, value: AnswerValue, position: SavePosition): Promise<{ error: string | null }>;
  /** Load every current answer as an AnswerMap. */
  loadAnswers(): Promise<AnswerMap>;
}
