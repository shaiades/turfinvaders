// My Purpose — the question-key registry. ONE list, three consumers: the
// content file's StepDefs, the persistence adapter's table routing, and the
// migration's save_purpose_answer() RPC (its _privateable array MUST mirror
// PRIVATE_ELIGIBLE_ANSWER_KEYS below — cross-referenced in
// supabase/migrations/20260924090000_my_purpose_v1.sql).

import type { ModuleKey } from "./types";

export const MODULE_KEYS: Record<ModuleKey, string> = {
  clear_board: "module_1",
  ceiling: "module_2",
  build_future: "module_3",
  make_real: "module_4",
  keep_promise: "module_5",
};

export const QK = {
  // Module 1 — Clear the Board
  m1_welcome: "m1_welcome",
  m1_direction: "m1_direction",
  m1_life_context: "m1_life_context", // optional; private-eligible

  // Module 2 — The Ceiling
  m2_ceiling_amount: "m2_ceiling_amount", // → purpose_beliefs.current_ceiling_amount
  m2_ceiling_reason: "m2_ceiling_reason", // json {category, otherText?}
  m2_ceiling_story: "m2_ceiling_story", // → purpose_beliefs.stated_ceiling_reason
  m2_belief_categories: "m2_belief_categories", // → purpose_beliefs.belief_categories_json
  m2_fact_story: "m2_fact_story", // json {fact, story} → purpose_beliefs.fact/story_statement
  m2_story_origin: "m2_story_origin", // → purpose_beliefs.belief_source_categories_json
  m2_outside_view: "m2_outside_view",
  m2_outside_view_control: "m2_outside_view_control", // when external-only
  m2_personal_gap: "m2_personal_gap", // → purpose_beliefs.development_gap_categories_json
  m2_reflection: "m2_reflection", // story card (seen marker)

  // Module 3 — Build the Future
  m3_future_direction: "m3_future_direction",
  m3_followthrough_difficulty: "m3_followthrough_difficulty", // when direction = clear (§20.1)
  m3_life_areas: "m3_life_areas", // json string[] (≤3; first = primary)
  m3_primary_outcome: "m3_primary_outcome",
  m3_three_year: "m3_three_year", // json {text, amount?} → purpose_goals possibility_3_year
  m3_belief_to_question: "m3_belief_to_question", // → purpose_beliefs.belief_to_question

  // Module 4 — Make It Real
  m4_one_year_target: "m4_one_year_target", // → purpose_goals target_1_year
  m4_evidence: "m4_evidence", // json {outcome, date} → target_1_year measurable_outcome/target_date
  m4_confidence: "m4_confidence", // number 1–10 → target_1_year confidence_rating
  m4_confidence_reason: "m4_confidence_reason", // when 1–3
  m4_confidence_one_point: "m4_confidence_one_point", // when 1–3
  m4_confidence_lever: "m4_confidence_lever", // when 4–7
  m4_overconfidence_risk: "m4_overconfidence_risk", // when 8–10
  m4_mission_90: "m4_mission_90", // → purpose_goals mission_90_day
  m4_pro_focus: "m4_pro_focus", // → purpose_goals professional_focus (life_area = slug)
  m4_pro_focus_detail: "m4_pro_focus_detail",
  m4_personal_focus: "m4_personal_focus", // → purpose_goals personal_focus
  m4_personal_focus_change: "m4_personal_focus_change", // optional; private-eligible

  // Module 5 — Seven Levels of Why + Keep the Promise
  m5_why_intro: "m5_why_intro",
  why_1: "why_1",
  why_2: "why_2",
  why_3: "why_3",
  why_4: "why_4", // json {text, category?}; privacy-markable
  why_5: "why_5", // json {text, category?}; privacy-markable
  why_6: "why_6", // json {values: string[], text}; privacy-markable
  why_7: "why_7", // Core Why; privacy-markable; is_core_why = true
  m5_core_reflection: "m5_core_reflection", // story summary card
  m5_obstacles: "m5_obstacles", // json string[] (≤2; first = primary)
  m5_obstacle_detail: "m5_obstacle_detail",
  m5_if_then: "m5_if_then", // json {if, then} → purpose_if_then_plans
  m5_support_request: "m5_support_request", // json {selections: string[], context?}
  m5_identity_commitment: "m5_identity_commitment",
  m5_review: "m5_review", // review step; ack recorded at submit
} as const;

export type QuestionKey = (typeof QK)[keyof typeof QK];

export const ALL_QUESTION_KEYS: readonly QuestionKey[] = Object.values(QK);

/** Keys whose rows may be marked private_to_rep in purpose_answers.
 *  MUST mirror the migration RPC's _privateable array. The Seven Whys and
 *  weekly reflections carry their own visibility columns in their own tables
 *  and are NOT listed here. */
export const PRIVATE_ELIGIBLE_ANSWER_KEYS: readonly QuestionKey[] = [
  QK.m1_life_context,
  QK.m4_personal_focus_change,
];

/** Whys that may be marked private (spec §16: levels 4–7). */
export const PRIVATE_ELIGIBLE_WHY_LEVELS = [4, 5, 6, 7] as const;

/** Routing: where each key's canonical value lives. Everything not listed
 *  routes to purpose_answers via the save_purpose_answer RPC. */
export type AnswerHome =
  | { table: "purpose_beliefs"; kind: "beliefs" }
  | { table: "purpose_goals"; kind: "goal"; goalType: string }
  | { table: "purpose_whys"; kind: "why"; level: number }
  | { table: "purpose_if_then_plans"; kind: "if_then" };

export const ANSWER_HOMES: Partial<Record<QuestionKey, AnswerHome>> = {
  [QK.m2_ceiling_amount]: { table: "purpose_beliefs", kind: "beliefs" },
  [QK.m2_ceiling_story]: { table: "purpose_beliefs", kind: "beliefs" },
  [QK.m2_belief_categories]: { table: "purpose_beliefs", kind: "beliefs" },
  [QK.m2_fact_story]: { table: "purpose_beliefs", kind: "beliefs" },
  [QK.m2_story_origin]: { table: "purpose_beliefs", kind: "beliefs" },
  [QK.m2_personal_gap]: { table: "purpose_beliefs", kind: "beliefs" },
  [QK.m3_belief_to_question]: { table: "purpose_beliefs", kind: "beliefs" },
  [QK.m3_three_year]: { table: "purpose_goals", kind: "goal", goalType: "possibility_3_year" },
  [QK.m4_one_year_target]: { table: "purpose_goals", kind: "goal", goalType: "target_1_year" },
  [QK.m4_evidence]: { table: "purpose_goals", kind: "goal", goalType: "target_1_year" },
  [QK.m4_confidence]: { table: "purpose_goals", kind: "goal", goalType: "target_1_year" },
  [QK.m4_mission_90]: { table: "purpose_goals", kind: "goal", goalType: "mission_90_day" },
  [QK.m4_pro_focus]: { table: "purpose_goals", kind: "goal", goalType: "professional_focus" },
  [QK.m4_pro_focus_detail]: { table: "purpose_goals", kind: "goal", goalType: "professional_focus" },
  [QK.m4_personal_focus]: { table: "purpose_goals", kind: "goal", goalType: "personal_focus" },
  [QK.why_1]: { table: "purpose_whys", kind: "why", level: 1 },
  [QK.why_2]: { table: "purpose_whys", kind: "why", level: 2 },
  [QK.why_3]: { table: "purpose_whys", kind: "why", level: 3 },
  [QK.why_4]: { table: "purpose_whys", kind: "why", level: 4 },
  [QK.why_5]: { table: "purpose_whys", kind: "why", level: 5 },
  [QK.why_6]: { table: "purpose_whys", kind: "why", level: 6 },
  [QK.why_7]: { table: "purpose_whys", kind: "why", level: 7 },
  [QK.m5_if_then]: { table: "purpose_if_then_plans", kind: "if_then" },
};
