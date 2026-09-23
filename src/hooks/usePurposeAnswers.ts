// My Purpose — the persistence adapter. The engine thinks in ONE AnswerMap;
// the database stores each datum in exactly one home table (purpose_answers,
// purpose_beliefs, purpose_goals, purpose_whys, purpose_if_then_plans — the
// no-duplication rule). This file is the only place that routing exists:
// loadAnswers() recomposes the map from all five tables, saveAnswer()
// dispatches a key to its home. Query-key prefix "purpose_answers" covers the
// composed map.

import { useQuery } from "@tanstack/react-query";
import type { AnswerMap, AnswerValue, SavePosition } from "@/lib/purpose/types";
import { ANSWER_HOMES, MODULE_KEYS, QK } from "@/lib/purpose/questionKeys";
import { resolveDyn, selectionsOf } from "@/lib/purpose/engine";
import {
  ALL_STEPS,
  BELIEF_OPTION_TO_CONSTRAINT,
  PERSONAL_FOCUS_OPTIONS,
  PRO_FOCUS_OPTIONS,
  primaryObstacle,
} from "@/data/purpose-workshop-content";
import {
  purposeRpc,
  purposeTable,
  type PurposeAnswerRow,
  type PurposeBeliefsRow,
  type PurposeGoalRow,
  type PurposeIfThenRow,
  type PurposeWhyRow,
} from "./usePurposeTable";

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export const purposeAnswersKey = (profileId: string) => ["purpose_answers", profileId] as const;

// ---------------------------------------------------------------------------
// Load: five tables → one AnswerMap
// ---------------------------------------------------------------------------

export async function loadPurposeAnswers(profileId: string): Promise<Record<string, AnswerValue>> {
  const [answersRes, beliefsRes, goalsRes, whysRes, ifThenRes] = await Promise.all([
    purposeTable("purpose_answers").select("*").eq("purpose_profile_id", profileId).eq("is_current", true),
    purposeTable("purpose_beliefs").select("*").eq("purpose_profile_id", profileId).maybeSingle(),
    purposeTable("purpose_goals").select("*").eq("purpose_profile_id", profileId),
    purposeTable("purpose_whys").select("*").eq("purpose_profile_id", profileId),
    purposeTable("purpose_if_then_plans").select("*").eq("purpose_profile_id", profileId).maybeSingle(),
  ]);
  for (const res of [answersRes, beliefsRes, goalsRes, whysRes, ifThenRes]) {
    if (res.error) throw res.error;
  }

  const map: Record<string, AnswerValue> = {};

  for (const raw of (answersRes.data ?? []) as unknown as PurposeAnswerRow[]) {
    map[raw.question_key] = {
      text: raw.answer_value_text ?? undefined,
      number: raw.answer_value_number ?? undefined,
      date: raw.answer_value_date ?? undefined,
      json: raw.answer_value_json ?? undefined,
      visibility: raw.visibility,
      updatedAt: raw.updated_at,
    };
  }

  const b = (beliefsRes.data ?? null) as unknown as PurposeBeliefsRow | null;
  if (b) {
    const at = b.updated_at;
    if (b.current_ceiling_amount != null)
      map[QK.m2_ceiling_amount] = { number: Number(b.current_ceiling_amount), updatedAt: at };
    if (b.ceiling_reason_category)
      map[QK.m2_ceiling_reason] = {
        text: b.ceiling_reason_category,
        json: b.ceiling_reason_free_text ? { otherText: b.ceiling_reason_free_text } : undefined,
        updatedAt: at,
      };
    if (b.stated_ceiling_reason) map[QK.m2_ceiling_story] = { text: b.stated_ceiling_reason, updatedAt: at };
    if (b.belief_categories_json?.length)
      map[QK.m2_belief_categories] = { json: b.belief_categories_json, updatedAt: at };
    if (b.fact_statement || b.story_statement)
      map[QK.m2_fact_story] = {
        json: { fact: b.fact_statement ?? "", story: b.story_statement ?? "" },
        updatedAt: at,
      };
    if (b.belief_source_categories_json?.length)
      map[QK.m2_story_origin] = { json: b.belief_source_categories_json, updatedAt: at };
    if (b.development_gap_categories_json?.length)
      map[QK.m2_personal_gap] = { json: b.development_gap_categories_json, updatedAt: at };
    if (b.belief_to_question) map[QK.m3_belief_to_question] = { text: b.belief_to_question, updatedAt: at };
  }

  for (const g of (goalsRes.data ?? []) as unknown as PurposeGoalRow[]) {
    const at = g.updated_at;
    switch (g.goal_type) {
      case "possibility_3_year": {
        const amt = g.measurable_outcome != null ? Number(g.measurable_outcome) : NaN;
        map[QK.m3_three_year] = {
          text: g.goal_description ?? undefined,
          number: Number.isFinite(amt) ? amt : undefined,
          updatedAt: at,
        };
        break;
      }
      case "target_1_year": {
        if (g.goal_description) map[QK.m4_one_year_target] = { text: g.goal_description, updatedAt: at };
        if (g.measurable_outcome || g.target_date)
          map[QK.m4_evidence] = {
            json: { outcome: g.measurable_outcome ?? "", date: g.target_date ?? "" },
            updatedAt: at,
          };
        if (g.confidence_rating != null)
          map[QK.m4_confidence] = { number: g.confidence_rating, updatedAt: at };
        break;
      }
      case "mission_90_day":
        if (g.goal_description) map[QK.m4_mission_90] = { text: g.goal_description, updatedAt: at };
        break;
      case "professional_focus":
        if (g.life_area) map[QK.m4_pro_focus] = { text: g.life_area, updatedAt: at };
        if (g.goal_description) map[QK.m4_pro_focus_detail] = { text: g.goal_description, updatedAt: at };
        break;
      case "personal_focus":
        if (g.life_area)
          map[QK.m4_personal_focus] = { text: g.life_area, visibility: g.visibility, updatedAt: at };
        break;
    }
  }

  for (const w of (whysRes.data ?? []) as unknown as PurposeWhyRow[]) {
    if (w.level_number < 1 || w.level_number > 7) continue;
    map[`why_${w.level_number}`] = {
      text: w.answer_text ?? undefined,
      json: {
        ...(w.answer_category ? { category: w.answer_category } : {}),
        ...(w.answer_categories_json?.length ? { values: w.answer_categories_json } : {}),
      },
      visibility: w.visibility,
      updatedAt: w.updated_at,
    };
  }

  const it = (ifThenRes.data ?? null) as unknown as PurposeIfThenRow | null;
  if (it && (it.trigger_statement || it.response_statement)) {
    map[QK.m5_if_then] = {
      json: { if: it.trigger_statement ?? "", then: it.response_statement ?? "" },
      updatedAt: it.updated_at,
    };
  }

  return map;
}

export function usePurposeAnswers(profileId: string | undefined) {
  return useQuery({
    enabled: !!profileId,
    queryKey: purposeAnswersKey(profileId ?? ""),
    staleTime: 15_000,
    retry: false,
    queryFn: () => loadPurposeAnswers(profileId!),
  });
}

// ---------------------------------------------------------------------------
// Save: one key → its home table
// ---------------------------------------------------------------------------

const optionLabel = (options: { value: string; label: string }[], value: string | undefined) =>
  options.find((o) => o.value === value)?.label ?? null;

/** Obstacle → the spec's trigger_type taxonomy. External circumstances vs
 *  internal pull-back vs recovery-of-basics; default internal. */
function triggerTypeFor(obstacle: string): "external" | "internal" | "recovery" {
  if (obstacle === "blame_circumstances" || obstacle === "distracted") return "external";
  if (obstacle === "tired" || obstacle === "no_plan" || obstacle === "overcommitted") return "recovery";
  return "internal";
}

function beliefPatch(key: string, value: AnswerValue, answers: AnswerMap): Record<string, unknown> | null {
  switch (key) {
    case QK.m2_ceiling_amount:
      return { current_ceiling_amount: value.number ?? null, ceiling_type: "income" };
    case QK.m2_ceiling_reason:
      return {
        ceiling_reason_category: value.text ?? null,
        ceiling_reason_free_text: (asObj(value.json).otherText as string | undefined) ?? null,
      };
    case QK.m2_ceiling_story:
      return { stated_ceiling_reason: value.text ?? null };
    case QK.m2_belief_categories: {
      const selections = selectionsOf(value);
      const first = selections[0];
      return {
        belief_categories_json: selections,
        primary_constraint_category: first ? (BELIEF_OPTION_TO_CONSTRAINT[first] ?? "other") : "unclear",
      };
    }
    case QK.m2_fact_story: {
      const j = asObj(value.json);
      return {
        fact_statement: (j.fact as string | undefined) ?? null,
        story_statement: (j.story as string | undefined) ?? null,
      };
    }
    case QK.m2_story_origin:
      return { belief_source_categories_json: selectionsOf(value) };
    case QK.m2_personal_gap:
      return { development_gap_categories_json: selectionsOf(value) };
    case QK.m3_belief_to_question:
      return { belief_to_question: value.text ?? null };
    default:
      return null;
  }
  void answers;
}

function goalPatch(key: string, value: AnswerValue): Record<string, unknown> | null {
  switch (key) {
    case QK.m3_three_year:
      return {
        goal_description: value.text ?? null,
        measurable_outcome: value.number != null ? String(value.number) : null,
      };
    case QK.m4_one_year_target:
      return { goal_description: value.text ?? null };
    case QK.m4_evidence: {
      const j = asObj(value.json);
      return {
        measurable_outcome: (j.outcome as string | undefined) ?? null,
        target_date: (j.date as string | undefined) || null,
      };
    }
    case QK.m4_confidence:
      return { confidence_rating: value.number ?? null };
    case QK.m4_mission_90:
      return { goal_description: value.text ?? null };
    case QK.m4_pro_focus:
      return { life_area: value.text ?? null, goal_title: optionLabel(PRO_FOCUS_OPTIONS, value.text) };
    case QK.m4_pro_focus_detail:
      return { goal_description: value.text ?? null };
    case QK.m4_personal_focus:
      return {
        life_area: value.text ?? null,
        goal_title: optionLabel(PERSONAL_FOCUS_OPTIONS, value.text),
        visibility: value.visibility ?? "leadership_shared",
      };
    default:
      return null;
  }
}

export type SaveAnswerFn = (
  key: string,
  value: AnswerValue,
  position: SavePosition,
) => Promise<{ error: string | null }>;

/** Build the routing save function the SaveQueue drives. `getAnswers` must
 *  return the LATEST local AnswerMap (the workshop hook updates local state
 *  before enqueueing, so derived columns like primary_constraint_category and
 *  interpolated why prompts see the fresh value). */
export function buildSaveAnswer(
  profile: { id: string; user_id: string },
  getAnswers: () => AnswerMap,
): SaveAnswerFn {
  return async (key, value, position) => {
    try {
      const home = ANSWER_HOMES[key as keyof typeof ANSWER_HOMES];
      const base = { purpose_profile_id: profile.id, user_id: profile.user_id };

      if (home?.kind === "beliefs") {
        const patch = beliefPatch(key, value, getAnswers());
        if (!patch) return { error: `No belief mapping for ${key}` };
        const { error } = await purposeTable("purpose_beliefs").upsert(
          { ...base, ...patch },
          { onConflict: "purpose_profile_id" },
        );
        return { error: error ? error.message : null };
      }

      if (home?.kind === "goal") {
        const patch = goalPatch(key, value);
        if (!patch) return { error: `No goal mapping for ${key}` };
        const { error } = await purposeTable("purpose_goals").upsert(
          { ...base, goal_type: home.goalType, ...patch },
          { onConflict: "purpose_profile_id,goal_type" },
        );
        return { error: error ? error.message : null };
      }

      if (home?.kind === "why") {
        const step = ALL_STEPS.find((s) => s.key === key);
        const j = asObj(value.json);
        const values = Array.isArray(j.values)
          ? (j.values as unknown[]).filter((x): x is string => typeof x === "string")
          : null;
        const { error } = await purposeTable("purpose_whys").upsert(
          {
            ...base,
            level_number: home.level,
            // Stored so leadership can audit WHICH dynamically-built question
            // the rep actually answered (spec §9.10).
            prompt_text: step ? resolveDyn(step.prompt, getAnswers()) : null,
            answer_text: value.text ?? null,
            answer_category: (j.category as string | undefined) ?? null,
            answer_categories_json: values,
            visibility: value.visibility ?? "leadership_shared",
            is_core_why: home.level === 7,
          },
          { onConflict: "purpose_profile_id,level_number" },
        );
        return { error: error ? error.message : null };
      }

      if (home?.kind === "if_then") {
        const j = asObj(value.json);
        const ifText = (j.if as string | undefined) ?? "";
        const thenText = (j.then as string | undefined) ?? "";
        const { error } = await purposeTable("purpose_if_then_plans").upsert(
          {
            ...base,
            trigger_type: triggerTypeFor(primaryObstacle(getAnswers())),
            trigger_statement: ifText || null,
            response_statement: thenText || null,
            full_if_then_statement: ifText && thenText ? `IF ${ifText},\nTHEN ${thenText}` : null,
          },
          { onConflict: "purpose_profile_id" },
        );
        return { error: error ? error.message : null };
      }

      // Default home: the versioned purpose_answers table, RPC-only writes.
      const { error } = await purposeRpc("save_purpose_answer", {
        _question_key: key,
        _module_key: MODULE_KEYS[position.module],
        _answer_type: value.number != null ? "number" : value.date ? "date" : value.json !== undefined ? "json" : "text",
        _text: value.text ?? null,
        _number: value.number ?? null,
        _date: value.date ?? null,
        _json: value.json !== undefined ? value.json : null,
        _visibility: value.visibility ?? "leadership_shared",
      });
      return { error: error ? error.message : null };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
}
