// My Purpose — data-access foundation. The purpose_* tables aren't in the
// generated Database types until the migration is applied and Lovable
// regenerates types.ts, so every purpose query goes through this one untyped
// escape hatch (the ObjectionDojo dojoTable precedent), cast on read. Keep
// the casts HERE — components and hooks stay typed via the row types below.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { LeadershipStatus, PurposeStatus, Visibility } from "@/lib/purpose/types";

// An untyped view of the client: the generated Database types don't know the
// purpose_* tables yet, and the generic builder collapses unknown table names
// to `never`. Row shapes are re-imposed by the types below, cast on read.
const loose = supabase as unknown as SupabaseClient;

export const purposeTable = (name: string) => loose.from(name);

export const purposeRpc = (name: string, args?: Record<string, unknown>) => loose.rpc(name, args);

/** Postgres "relation does not exist" (42P01) / PostgREST "table not in
 *  schema cache" (PGRST205) / missing function (PGRST202, 42883) — i.e. the
 *  migration hasn't been applied yet. Screens render a graceful fallback
 *  instead of an error state. */
export function isMissingMigration(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205" || e.code === "PGRST202" || e.code === "42883") return true;
  const msg = (e.message ?? "").toLowerCase();
  return msg.includes("does not exist") || msg.includes("schema cache");
}

// ---------------------------------------------------------------------------
// Row types (mirror supabase/migrations/20260924090000_my_purpose_v1.sql)
// ---------------------------------------------------------------------------

export type PurposeProfileRow = {
  id: string;
  user_id: string;
  role: "sales_rep" | "owner";
  status: PurposeStatus;
  current_module: string | null;
  current_step: string | null;
  workshop_completed: boolean;
  version_number: number;
  started_at: string;
  completed_at: string | null;
  last_reviewed_at: string | null;
  leadership_follow_up_date: string | null;
  leadership_status: LeadershipStatus | null;
  leadership_next_action: string | null;
  created_at: string;
  updated_at: string;
};

export type PurposeAnswerRow = {
  id: string;
  purpose_profile_id: string;
  user_id: string;
  question_key: string;
  module_key: string;
  answer_type: string;
  answer_value_text: string | null;
  answer_value_number: number | null;
  answer_value_date: string | null;
  answer_value_json: unknown;
  visibility: Visibility;
  required: boolean;
  answer_version: number;
  is_current: boolean;
  answered_at: string;
  created_at: string;
  updated_at: string;
};

export type PurposeGoalRow = {
  id: string;
  purpose_profile_id: string;
  user_id: string;
  goal_type: string;
  goal_title: string | null;
  goal_description: string | null;
  measurable_outcome: string | null;
  target_date: string | null;
  life_area: string | null;
  confidence_rating: number | null;
  chosen: boolean;
  visibility: Visibility;
  updated_at: string;
};

export type PurposeBeliefsRow = {
  id: string;
  purpose_profile_id: string;
  user_id: string;
  current_ceiling_amount: number | null;
  ceiling_type: string | null;
  stated_ceiling_reason: string | null;
  belief_categories_json: string[] | null;
  fact_statement: string | null;
  story_statement: string | null;
  belief_source_categories_json: string[] | null;
  development_gap_categories_json: string[] | null;
  primary_constraint_category: string | null;
  old_belief_statement: string | null;
  belief_to_question: string | null;
  possibility_statement: string | null;
  ceiling_reason_category: string | null;
  ceiling_reason_free_text: string | null;
  updated_at: string;
};

export type PurposeWhyRow = {
  id: string;
  purpose_profile_id: string;
  user_id: string;
  level_number: number;
  prompt_text: string | null;
  answer_text: string | null;
  answer_category: string | null;
  answer_categories_json: string[] | null;
  visibility: Visibility;
  is_core_why: boolean;
  updated_at: string;
};

/** The leadership RPC's masked shape — private levels come back with null
 *  text but their category columns intact. */
export type PurposeWhyLeadershipRow = {
  level_number: number;
  prompt_text: string | null;
  answer_text: string | null;
  answer_category: string | null;
  answer_categories_json: string[] | null;
  is_core_why: boolean;
  visibility: Visibility;
  updated_at: string;
};

export type PurposeIfThenRow = {
  id: string;
  purpose_profile_id: string;
  user_id: string;
  trigger_type: "external" | "internal" | "recovery";
  trigger_statement: string | null;
  response_statement: string | null;
  full_if_then_statement: string | null;
  updated_at: string;
};

export type PurposeReflectionRow = {
  id: string;
  purpose_profile_id: string;
  user_id: string;
  reflection_date: string;
  prompt_key: string;
  answer_text: string;
  visibility: Visibility;
  created_at: string;
};

export type PurposeLeadershipNoteRow = {
  id: string;
  purpose_profile_id: string;
  author_user_id: string;
  note_text: string;
  note_type: "observation" | "coaching_plan" | "follow_up" | "milestone" | "concern";
  visible_to_rep: boolean;
  created_at: string;
  updated_at: string;
};

export type PurposeConfigRow = {
  id: boolean;
  sales_rep_feature_enabled: boolean;
  workshop_launch_mode: "pre_launch" | "live" | "ongoing";
  enable_post_workshop_edits: boolean;
  show_existing_crm_summary: boolean;
  show_optional_weekly_reflection: boolean;
  leadership_visibility_notice: string;
  workshop_version: number;
  updated_at: string;
};

export type PurposeSafetyFlagRow = {
  id: string;
  purpose_profile_id: string;
  user_id: string;
  source: string;
  module_key: string | null;
  question_key: string | null;
  flagged_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  cleared_at: string | null;
  cleared_by: string | null;
};
