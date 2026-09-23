-- ═══════════════════════════════════════════════════════════════════════════
-- MY PURPOSE v1 (owner-approved 2026-09-23). A guided goal workshop for the
-- sales reps — five modules (Clear the Board → The Ceiling → Build the
-- Future → Make It Real → Seven Levels of Why / Keep the Promise) that walk
-- a rep from "what's actually in the way" to a written 3-year possibility,
-- 1-year target, 90-day mission, and a Core Why — plus an owner-only
-- leadership dashboard for mentoring off what a rep chose to share.
--
-- Owner decisions baked in here:
--   · Leadership access is gated to the `owner` role ONLY — never
--     office_staff, never captain. This is personal material; the two
--     owners mentor off it directly.
--   · Ships DARK: purpose_admin_config.sales_rep_feature_enabled = false.
--     The two owners walk the workshop themselves first, then flip the flag.
--   · NO fictional seed data — a deliberate deviation from the spec's
--     sample-profiles section. Every row in these tables is a real person's
--     real answer or it doesn't exist (house rule: never invent numbers,
--     and never invent people either).
--   · Crisis/safety flags are METADATA ONLY. purpose_safety_flags never
--     carries a single character of what the rep wrote — just where and
--     when a client-side keyword screen tripped, so a human can check in.
--
-- Privacy model, in one breath: a rep's answers default to
-- 'leadership_shared'; two designated answer keys and Why levels 4–7 may be
-- marked 'private_to_rep', and private means private — the owner read paths
-- (policies + the masked whys RPC + the reflection/revision rules below)
-- are built so private text is unreachable by anyone but the rep.
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file <this file>
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0) purpose_admin_config: the singleton switchboard ───────────────────────
-- Created FIRST: the purpose_profiles INSERT policy below references this
-- table in a subquery, and CREATE POLICY resolves relations at definition
-- time — config must already exist or the file cannot apply once.
-- company_settings pattern: boolean-TRUE primary key, one row, ever.
-- sales_rep_feature_enabled ships FALSE — the owners walk the workshop
-- first, then open the doors.

CREATE TABLE IF NOT EXISTS public.purpose_admin_config (
  id boolean PRIMARY KEY DEFAULT TRUE,
  sales_rep_feature_enabled boolean NOT NULL DEFAULT false,
  workshop_launch_mode text NOT NULL DEFAULT 'pre_launch'
    CHECK (workshop_launch_mode IN ('pre_launch','live','ongoing')),
  enable_post_workshop_edits boolean NOT NULL DEFAULT true,
  show_existing_crm_summary boolean NOT NULL DEFAULT true,
  show_optional_weekly_reflection boolean NOT NULL DEFAULT true,
  leadership_visibility_notice text NOT NULL
    DEFAULT 'Tyler and Shai can review your professional plan to mentor you better. Anything you mark "Private to me" stays private.',
  workshop_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purpose_admin_config_singleton CHECK (id)
);

GRANT SELECT, UPDATE ON public.purpose_admin_config TO authenticated;
GRANT ALL ON public.purpose_admin_config TO service_role;
ALTER TABLE public.purpose_admin_config ENABLE ROW LEVEL SECURITY;

-- Reps need the row to read the launch flag + the visibility notice verbatim.
DROP POLICY IF EXISTS "purpose_config read" ON public.purpose_admin_config;
CREATE POLICY "purpose_config read"
  ON public.purpose_admin_config FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'sales_rep'::app_role)
    OR public.has_role(auth.uid(), 'owner'::app_role)
  );

DROP POLICY IF EXISTS "purpose_config owner update" ON public.purpose_admin_config;
CREATE POLICY "purpose_config owner update"
  ON public.purpose_admin_config FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'owner'::app_role));
-- No INSERT/DELETE policies: the singleton is seeded below and never moves.

DROP TRIGGER IF EXISTS purpose_admin_config_touch_updated_at ON public.purpose_admin_config;
CREATE TRIGGER purpose_admin_config_touch_updated_at
  BEFORE UPDATE ON public.purpose_admin_config
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

INSERT INTO public.purpose_admin_config (id) VALUES (TRUE)
ON CONFLICT (id) DO NOTHING;


-- ── 1) purpose_profiles: one workshop per person ─────────────────────────────
-- UNIQUE (id, user_id) exists purely as the composite-FK anchor: every child
-- table references (purpose_profile_id, user_id) against it, so a child row's
-- denormalized user_id can never disagree with its profile — RLS on children
-- can trust user_id without a join.

CREATE TABLE IF NOT EXISTS public.purpose_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'sales_rep' CHECK (role IN ('sales_rep','owner')),
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('not_started','in_progress','submitted')),
  current_module text,
  current_step text,
  workshop_completed boolean NOT NULL DEFAULT false,
  version_number int NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  -- Leadership working columns (owner-only writes, enforced by the guard
  -- trigger below — the rep can see them, which is by design: nothing about
  -- you is tracked behind your back).
  last_reviewed_at timestamptz,
  leadership_follow_up_date date,
  leadership_status text
    CHECK (leadership_status IN ('needs_review','follow_up_set','discussed','ongoing')),
  leadership_next_action text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purpose_profiles_id_user_uq UNIQUE (id, user_id)
);

GRANT SELECT, INSERT, UPDATE ON public.purpose_profiles TO authenticated;
GRANT ALL ON public.purpose_profiles TO service_role;
ALTER TABLE public.purpose_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "purpose_profiles own read" ON public.purpose_profiles;
CREATE POLICY "purpose_profiles own read"
  ON public.purpose_profiles FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "purpose_profiles owner read all" ON public.purpose_profiles;
CREATE POLICY "purpose_profiles owner read all"
  ON public.purpose_profiles FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role));

-- INSERT pins every leadership/progress column to its birth state so a
-- client can't mint a pre-completed or pre-reviewed profile. It also pins
-- WHO may mint one: the role column must match a role the caller actually
-- holds (a canvasser hitting PostgREST directly gets nothing, and a rep
-- can't self-assign 'owner'), and reps can't create a profile before the
-- launch flag flips — otherwise a direct insert would sidestep the
-- ensure_purpose_profile() gates entirely.
DROP POLICY IF EXISTS "purpose_profiles own insert" ON public.purpose_profiles;
CREATE POLICY "purpose_profiles own insert"
  ON public.purpose_profiles FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND status = 'in_progress'
    AND workshop_completed = false
    AND completed_at IS NULL
    AND version_number = 1
    AND last_reviewed_at IS NULL
    AND leadership_follow_up_date IS NULL
    AND leadership_status IS NULL
    AND leadership_next_action IS NULL
    AND (
      (role = 'owner' AND public.has_role(auth.uid(), 'owner'::app_role))
      OR (
        role = 'sales_rep'
        AND public.has_role(auth.uid(), 'sales_rep'::app_role)
        AND COALESCE(
          (SELECT c.sales_rep_feature_enabled FROM public.purpose_admin_config c WHERE c.id),
          false)
      )
    )
  );

DROP POLICY IF EXISTS "purpose_profiles own update" ON public.purpose_profiles;
CREATE POLICY "purpose_profiles own update"
  ON public.purpose_profiles FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Owner UPDATE exists for the leadership columns; the guard trigger does the
-- column-level split (owner may touch leadership fields, only the rep may
-- touch progress fields). No DELETE policy for anyone: a workshop is a
-- record, not a scratchpad.
DROP POLICY IF EXISTS "purpose_profiles owner update" ON public.purpose_profiles;
CREATE POLICY "purpose_profiles owner update"
  ON public.purpose_profiles FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'owner'::app_role));

DROP TRIGGER IF EXISTS purpose_profiles_touch_updated_at ON public.purpose_profiles;
CREATE TRIGGER purpose_profiles_touch_updated_at
  BEFORE UPDATE ON public.purpose_profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 2) purpose_answers: the versioned raw answer store ───────────────────────
-- WRITES GO THROUGH save_purpose_answer() ONLY. The versioning rules (edit in
-- place pre-submit, append a new version post-submit, retro-privatize every
-- version when a key flips private) cannot be expressed as row policies — a
-- direct client write could strand two is_current rows or resurrect a shared
-- copy of a privatized answer. So: SELECT grant only, no write policies, and
-- the RPC (SECURITY DEFINER) is the single door.

CREATE TABLE IF NOT EXISTS public.purpose_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose_profile_id uuid NOT NULL,
  user_id uuid NOT NULL,
  question_key text NOT NULL,
  module_key text NOT NULL,
  answer_type text NOT NULL
    CHECK (answer_type IN ('text','number','currency','date','scale','single_select','multi_select','json')),
  answer_value_text text,
  answer_value_number numeric(14,2),
  answer_value_date date,
  answer_value_json jsonb,
  visibility text NOT NULL DEFAULT 'leadership_shared'
    CHECK (visibility IN ('leadership_shared','private_to_rep')),
  required boolean NOT NULL DEFAULT false,
  answer_version int NOT NULL DEFAULT 1,
  is_current boolean NOT NULL DEFAULT true,
  answered_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (purpose_profile_id, user_id)
    REFERENCES public.purpose_profiles (id, user_id) ON DELETE CASCADE,
  UNIQUE (purpose_profile_id, question_key, answer_version)
);

-- Exactly one live row per question per profile.
CREATE UNIQUE INDEX IF NOT EXISTS purpose_answers_current_uq
  ON public.purpose_answers (purpose_profile_id, question_key)
  WHERE is_current;
CREATE INDEX IF NOT EXISTS purpose_answers_user_idx
  ON public.purpose_answers (user_id);

-- SELECT only — deliberately no INSERT/UPDATE/DELETE grant (see above).
GRANT SELECT ON public.purpose_answers TO authenticated;
GRANT ALL ON public.purpose_answers TO service_role;
ALTER TABLE public.purpose_answers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "purpose_answers own read" ON public.purpose_answers;
CREATE POLICY "purpose_answers own read"
  ON public.purpose_answers FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Owners read shared CURRENT answers only: private_to_rep rows are invisible
-- to them, and so are superseded versions — edit history is the rep's (the
-- same doctrine that keeps purpose_revision_log owner-free below).
DROP POLICY IF EXISTS "purpose_answers owner read shared" ON public.purpose_answers;
CREATE POLICY "purpose_answers owner read shared"
  ON public.purpose_answers FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    AND visibility = 'leadership_shared'
    AND is_current
  );

DROP TRIGGER IF EXISTS purpose_answers_touch_updated_at ON public.purpose_answers;
CREATE TRIGGER purpose_answers_touch_updated_at
  BEFORE UPDATE ON public.purpose_answers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 3) purpose_goals: the chosen commitments ─────────────────────────────────
-- One row per goal type per profile. Only the personal-focus goal may be
-- private (the professional plan is the mentoring surface); the CHECK
-- encodes that so a client bug can't hide a 1-year target from leadership.

CREATE TABLE IF NOT EXISTS public.purpose_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose_profile_id uuid NOT NULL,
  user_id uuid NOT NULL,
  goal_type text NOT NULL
    CHECK (goal_type IN ('possibility_3_year','target_1_year','mission_90_day','professional_focus','personal_focus')),
  goal_title text,
  goal_description text,
  measurable_outcome text,
  target_date date,
  life_area text,
  confidence_rating int CHECK (confidence_rating BETWEEN 1 AND 10),
  chosen boolean NOT NULL DEFAULT true,
  visibility text NOT NULL DEFAULT 'leadership_shared'
    CHECK (visibility IN ('leadership_shared','private_to_rep')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (purpose_profile_id, user_id)
    REFERENCES public.purpose_profiles (id, user_id) ON DELETE CASCADE,
  UNIQUE (purpose_profile_id, goal_type),
  CONSTRAINT purpose_goals_privacy_chk
    CHECK (visibility = 'leadership_shared' OR goal_type = 'personal_focus')
);

GRANT SELECT, INSERT, UPDATE ON public.purpose_goals TO authenticated;
GRANT ALL ON public.purpose_goals TO service_role;
ALTER TABLE public.purpose_goals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "purpose_goals own read" ON public.purpose_goals;
CREATE POLICY "purpose_goals own read"
  ON public.purpose_goals FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "purpose_goals owner read shared" ON public.purpose_goals;
CREATE POLICY "purpose_goals owner read shared"
  ON public.purpose_goals FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    AND visibility = 'leadership_shared'
  );

DROP POLICY IF EXISTS "purpose_goals own insert" ON public.purpose_goals;
CREATE POLICY "purpose_goals own insert"
  ON public.purpose_goals FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Owners never write a rep's goals (mentoring is talk, not edits), and
-- nobody deletes them — post-submit edits are captured by the revision log.
DROP POLICY IF EXISTS "purpose_goals own update" ON public.purpose_goals;
CREATE POLICY "purpose_goals own update"
  ON public.purpose_goals FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP TRIGGER IF EXISTS purpose_goals_touch_updated_at ON public.purpose_goals;
CREATE TRIGGER purpose_goals_touch_updated_at
  BEFORE UPDATE ON public.purpose_goals
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 4) purpose_beliefs: the ceiling work (Module 2 + 3 carry-over) ───────────
-- Singleton per profile. This is the fact-vs-story material; it is always
-- leadership-visible by design (the whole point of Module 2 is naming the
-- constraint out loud), so it carries no visibility column.

CREATE TABLE IF NOT EXISTS public.purpose_beliefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose_profile_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  current_ceiling_amount numeric(12,2),
  ceiling_type text
    CHECK (ceiling_type IN ('income','career','leadership','lifestyle','confidence','unknown')),
  stated_ceiling_reason text,
  belief_categories_json jsonb,
  fact_statement text,
  story_statement text,
  belief_source_categories_json jsonb,
  development_gap_categories_json jsonb,
  primary_constraint_category text
    CHECK (primary_constraint_category IN (
      'sales_skill','consistency','rejection_avoidance','opportunity_belief',
      'identity_ceiling','fear_of_success','fear_of_failure','lack_of_purpose',
      'unclear','other')),
  old_belief_statement text,
  belief_to_question text,
  possibility_statement text,
  ceiling_reason_category text,
  ceiling_reason_free_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (purpose_profile_id, user_id)
    REFERENCES public.purpose_profiles (id, user_id) ON DELETE CASCADE
);

GRANT SELECT, INSERT, UPDATE ON public.purpose_beliefs TO authenticated;
GRANT ALL ON public.purpose_beliefs TO service_role;
ALTER TABLE public.purpose_beliefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "purpose_beliefs own read" ON public.purpose_beliefs;
CREATE POLICY "purpose_beliefs own read"
  ON public.purpose_beliefs FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "purpose_beliefs owner read" ON public.purpose_beliefs;
CREATE POLICY "purpose_beliefs owner read"
  ON public.purpose_beliefs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role));

DROP POLICY IF EXISTS "purpose_beliefs own insert" ON public.purpose_beliefs;
CREATE POLICY "purpose_beliefs own insert"
  ON public.purpose_beliefs FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "purpose_beliefs own update" ON public.purpose_beliefs;
CREATE POLICY "purpose_beliefs own update"
  ON public.purpose_beliefs FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
-- No owner writes, no DELETE (revision log covers post-submit history).

DROP TRIGGER IF EXISTS purpose_beliefs_touch_updated_at ON public.purpose_beliefs;
CREATE TRIGGER purpose_beliefs_touch_updated_at
  BEFORE UPDATE ON public.purpose_beliefs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 5) purpose_whys: the Seven Levels ────────────────────────────────────────
-- LOUD AND ON PURPOSE: there is NO owner SELECT policy on this table — not a
-- masked one, none. Levels 4–7 may be private (the table CHECK pins levels
-- 1–3 to shared), and the ONLY leadership read path is the
-- get_purpose_whys_for_leadership() RPC below, which nulls out the text of
-- private levels while keeping the category metadata. A plain owner policy
-- here would hand PostgREST the raw rows and one bad client query would leak
-- a private Core Why. The deepest answers a rep writes in this app live in
-- this table; the door has one key and the rep holds it.

CREATE TABLE IF NOT EXISTS public.purpose_whys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose_profile_id uuid NOT NULL,
  user_id uuid NOT NULL,
  level_number int NOT NULL CHECK (level_number BETWEEN 1 AND 7),
  prompt_text text,
  answer_text text,
  answer_category text,
  answer_categories_json jsonb,
  visibility text NOT NULL DEFAULT 'leadership_shared'
    CHECK (visibility IN ('leadership_shared','private_to_rep')),
  is_core_why boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (purpose_profile_id, user_id)
    REFERENCES public.purpose_profiles (id, user_id) ON DELETE CASCADE,
  UNIQUE (purpose_profile_id, level_number),
  -- Spec §16: only levels 4–7 are privacy-eligible.
  CONSTRAINT purpose_whys_privacy_chk
    CHECK (visibility = 'leadership_shared' OR level_number BETWEEN 4 AND 7)
);

GRANT SELECT, INSERT, UPDATE ON public.purpose_whys TO authenticated;
GRANT ALL ON public.purpose_whys TO service_role;
ALTER TABLE public.purpose_whys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "purpose_whys own read" ON public.purpose_whys;
CREATE POLICY "purpose_whys own read"
  ON public.purpose_whys FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "purpose_whys own insert" ON public.purpose_whys;
CREATE POLICY "purpose_whys own insert"
  ON public.purpose_whys FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "purpose_whys own update" ON public.purpose_whys;
CREATE POLICY "purpose_whys own update"
  ON public.purpose_whys FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP TRIGGER IF EXISTS purpose_whys_touch_updated_at ON public.purpose_whys;
CREATE TRIGGER purpose_whys_touch_updated_at
  BEFORE UPDATE ON public.purpose_whys
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 6) purpose_if_then_plans: the obstacle plan (Module 5) ───────────────────
-- Singleton per profile.

CREATE TABLE IF NOT EXISTS public.purpose_if_then_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose_profile_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  trigger_type text NOT NULL DEFAULT 'internal'
    CHECK (trigger_type IN ('external','internal','recovery')),
  trigger_statement text,
  response_statement text,
  full_if_then_statement text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (purpose_profile_id, user_id)
    REFERENCES public.purpose_profiles (id, user_id) ON DELETE CASCADE
);

GRANT SELECT, INSERT, UPDATE ON public.purpose_if_then_plans TO authenticated;
GRANT ALL ON public.purpose_if_then_plans TO service_role;
ALTER TABLE public.purpose_if_then_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "purpose_if_then own read" ON public.purpose_if_then_plans;
CREATE POLICY "purpose_if_then own read"
  ON public.purpose_if_then_plans FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "purpose_if_then owner read" ON public.purpose_if_then_plans;
CREATE POLICY "purpose_if_then owner read"
  ON public.purpose_if_then_plans FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role));

DROP POLICY IF EXISTS "purpose_if_then own insert" ON public.purpose_if_then_plans;
CREATE POLICY "purpose_if_then own insert"
  ON public.purpose_if_then_plans FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "purpose_if_then own update" ON public.purpose_if_then_plans;
CREATE POLICY "purpose_if_then own update"
  ON public.purpose_if_then_plans FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
-- No owner writes, no DELETE.

DROP TRIGGER IF EXISTS purpose_if_then_plans_touch_updated_at ON public.purpose_if_then_plans;
CREATE TRIGGER purpose_if_then_plans_touch_updated_at
  BEFORE UPDATE ON public.purpose_if_then_plans
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 7) purpose_reflections: the optional weekly check-in ─────────────────────
-- Defaults PRIVATE (opposite of every other table) — a journal is the rep's
-- unless they choose to share an entry. Reps may delete their own entries;
-- it's the one place delete is allowed, because a journal you can't retract
-- is a journal nobody writes in.

CREATE TABLE IF NOT EXISTS public.purpose_reflections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose_profile_id uuid NOT NULL,
  user_id uuid NOT NULL,
  reflection_date date NOT NULL DEFAULT current_date,
  prompt_key text NOT NULL DEFAULT 'weekly_becoming',
  answer_text text NOT NULL CHECK (char_length(answer_text) BETWEEN 1 AND 4000),
  visibility text NOT NULL DEFAULT 'private_to_rep'
    CHECK (visibility IN ('leadership_shared','private_to_rep')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (purpose_profile_id, user_id)
    REFERENCES public.purpose_profiles (id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS purpose_reflections_profile_date_idx
  ON public.purpose_reflections (purpose_profile_id, reflection_date DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.purpose_reflections TO authenticated;
GRANT ALL ON public.purpose_reflections TO service_role;
ALTER TABLE public.purpose_reflections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "purpose_reflections own read" ON public.purpose_reflections;
CREATE POLICY "purpose_reflections own read"
  ON public.purpose_reflections FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "purpose_reflections owner read shared" ON public.purpose_reflections;
CREATE POLICY "purpose_reflections owner read shared"
  ON public.purpose_reflections FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    AND visibility = 'leadership_shared'
  );

DROP POLICY IF EXISTS "purpose_reflections own insert" ON public.purpose_reflections;
CREATE POLICY "purpose_reflections own insert"
  ON public.purpose_reflections FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "purpose_reflections own update" ON public.purpose_reflections;
CREATE POLICY "purpose_reflections own update"
  ON public.purpose_reflections FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "purpose_reflections own delete" ON public.purpose_reflections;
CREATE POLICY "purpose_reflections own delete"
  ON public.purpose_reflections FOR DELETE TO authenticated
  USING (user_id = auth.uid());

DROP TRIGGER IF EXISTS purpose_reflections_touch_updated_at ON public.purpose_reflections;
CREATE TRIGGER purpose_reflections_touch_updated_at
  BEFORE UPDATE ON public.purpose_reflections
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 8) purpose_leadership_notes: the owners' coaching notebook ───────────────
-- No denormalized user_id here: these are notes ABOUT a profile BY an owner,
-- and the author FK is the accountability trail. Notes are owner-eyes-only
-- unless the author flips visible_to_rep (e.g. a milestone worth sharing).

CREATE TABLE IF NOT EXISTS public.purpose_leadership_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose_profile_id uuid NOT NULL
    REFERENCES public.purpose_profiles(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  note_text text NOT NULL,
  note_type text NOT NULL DEFAULT 'observation'
    CHECK (note_type IN ('observation','coaching_plan','follow_up','milestone','concern')),
  visible_to_rep boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS purpose_leadership_notes_profile_idx
  ON public.purpose_leadership_notes (purpose_profile_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.purpose_leadership_notes TO authenticated;
GRANT ALL ON public.purpose_leadership_notes TO service_role;
ALTER TABLE public.purpose_leadership_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "purpose_notes owner read" ON public.purpose_leadership_notes;
CREATE POLICY "purpose_notes owner read"
  ON public.purpose_leadership_notes FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role));

DROP POLICY IF EXISTS "purpose_notes owner insert" ON public.purpose_leadership_notes;
CREATE POLICY "purpose_notes owner insert"
  ON public.purpose_leadership_notes FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'owner'::app_role)
    AND author_user_id = auth.uid()
  );

-- Edit-own-notes-only: author_user_id is the accountability trail, so an
-- owner can neither rewrite the other owner's note nor reattribute one
-- (USING pins whose notes you may touch; WITH CHECK pins that the author
-- column still names you after the write).
DROP POLICY IF EXISTS "purpose_notes owner update" ON public.purpose_leadership_notes;
CREATE POLICY "purpose_notes owner update"
  ON public.purpose_leadership_notes FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    AND author_user_id = auth.uid()
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'owner'::app_role)
    AND author_user_id = auth.uid()
  );

DROP POLICY IF EXISTS "purpose_notes owner delete" ON public.purpose_leadership_notes;
CREATE POLICY "purpose_notes owner delete"
  ON public.purpose_leadership_notes FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role));

DROP POLICY IF EXISTS "purpose_notes rep read shared" ON public.purpose_leadership_notes;
CREATE POLICY "purpose_notes rep read shared"
  ON public.purpose_leadership_notes FOR SELECT TO authenticated
  USING (
    visible_to_rep
    AND EXISTS (
      SELECT 1 FROM public.purpose_profiles pp
      WHERE pp.id = purpose_leadership_notes.purpose_profile_id
        AND pp.user_id = auth.uid()
    )
  );

DROP TRIGGER IF EXISTS purpose_leadership_notes_touch_updated_at ON public.purpose_leadership_notes;
CREATE TRIGGER purpose_leadership_notes_touch_updated_at
  BEFORE UPDATE ON public.purpose_leadership_notes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 10) purpose_safety_flags: metadata-only wellbeing pings ──────────────────
-- NEVER any answer-text column — this table is metadata ONLY, by owner
-- decision. The client-side keyword screen files WHERE (module/question) and
-- WHEN a concerning phrase appeared so an owner can check in like a human
-- being; what the rep actually wrote stays wherever the rep put it, under
-- that row's own visibility. Reps have INSERT but NO SELECT: the flag is
-- discreet by construction — no UI can render "you were flagged" because no
-- rep query can see it.

CREATE TABLE IF NOT EXISTS public.purpose_safety_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose_profile_id uuid NOT NULL,
  user_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'keyword_client' CHECK (source IN ('keyword_client')),
  -- Length-capped: these render on the owner dashboard and a rep can insert
  -- them freely, so they must stay short slugs, not free prose.
  module_key text CHECK (module_key IS NULL OR char_length(module_key) <= 64),
  question_key text CHECK (question_key IS NULL OR char_length(question_key) <= 64),
  flagged_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES public.profiles(id),
  cleared_at timestamptz,
  cleared_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (purpose_profile_id, user_id)
    REFERENCES public.purpose_profiles (id, user_id) ON DELETE CASCADE
);

-- The dashboard's "open flags" list.
CREATE INDEX IF NOT EXISTS purpose_safety_flags_open_idx
  ON public.purpose_safety_flags (flagged_at DESC)
  WHERE cleared_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON public.purpose_safety_flags TO authenticated;
GRANT ALL ON public.purpose_safety_flags TO service_role;
ALTER TABLE public.purpose_safety_flags ENABLE ROW LEVEL SECURITY;

-- Rep files a flag against their own profile, born un-acknowledged.
DROP POLICY IF EXISTS "purpose_flags rep insert" ON public.purpose_safety_flags;
CREATE POLICY "purpose_flags rep insert"
  ON public.purpose_safety_flags FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND acknowledged_at IS NULL
    AND acknowledged_by IS NULL
    AND cleared_at IS NULL
    AND cleared_by IS NULL
  );

DROP POLICY IF EXISTS "purpose_flags owner read" ON public.purpose_safety_flags;
CREATE POLICY "purpose_flags owner read"
  ON public.purpose_safety_flags FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role));

DROP POLICY IF EXISTS "purpose_flags owner update" ON public.purpose_safety_flags;
CREATE POLICY "purpose_flags owner update"
  ON public.purpose_safety_flags FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'owner'::app_role));

DROP TRIGGER IF EXISTS purpose_safety_flags_touch_updated_at ON public.purpose_safety_flags;
CREATE TRIGGER purpose_safety_flags_touch_updated_at
  BEFORE UPDATE ON public.purpose_safety_flags
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 11) purpose_revision_log: post-submit edit history ───────────────────────
-- Append-only, trigger-fed (time_entry_audit idiom). LOUD AND ON PURPOSE:
-- the SELECT policy is OWN ROWS ONLY and there is deliberately NO owner
-- policy — old_row/new_row are whole-row jsonb snapshots, so a why or a
-- personal-focus goal that was later marked private would sit here in
-- plaintext, and an owner read of the log would be a back door around every
-- visibility rule above. Leadership sees the CURRENT shared state through
-- the tables; history is the rep's. No client write grants or policies:
-- only the SECURITY DEFINER trigger below inserts.

CREATE TABLE IF NOT EXISTS public.purpose_revision_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  purpose_profile_id uuid NOT NULL,
  user_id uuid NOT NULL,
  actor uuid,               -- auth.uid(); NULL = service role / system
  action text NOT NULL,     -- update | delete (lower(TG_OP))
  old_row jsonb,
  new_row jsonb,
  happened_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS purpose_revision_log_row_idx
  ON public.purpose_revision_log (row_id, happened_at);

GRANT SELECT ON public.purpose_revision_log TO authenticated;
GRANT ALL ON public.purpose_revision_log TO service_role;
ALTER TABLE public.purpose_revision_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "purpose_revisions own read" ON public.purpose_revision_log;
CREATE POLICY "purpose_revisions own read"
  ON public.purpose_revision_log FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ── 12) Guard trigger: purpose_profiles column split ─────────────────────────
-- One UPDATE policy pair can't say "owners touch these columns, the rep
-- touches those" — this trigger can. auth.uid() IS NULL (service role /
-- definer housekeeping) passes untouched, same as the time-clock guards.

CREATE OR REPLACE FUNCTION public.guard_purpose_profile_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  -- Immutable identity: a profile never changes hands or tier.
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'user_id and role are immutable on a purpose profile';
  END IF;

  -- Leadership working columns: owner-only.
  IF (NEW.last_reviewed_at IS DISTINCT FROM OLD.last_reviewed_at
      OR NEW.leadership_follow_up_date IS DISTINCT FROM OLD.leadership_follow_up_date
      OR NEW.leadership_status IS DISTINCT FROM OLD.leadership_status
      OR NEW.leadership_next_action IS DISTINCT FROM OLD.leadership_next_action)
     AND NOT public.has_role(auth.uid(), 'owner'::app_role) THEN
    RAISE EXCEPTION 'leadership review columns are owner-only';
  END IF;

  -- Resume-position columns: the rep's own, and only the rep's own —
  -- owners mentor, they don't move someone else's cursor.
  IF (NEW.current_module IS DISTINCT FROM OLD.current_module
      OR NEW.current_step IS DISTINCT FROM OLD.current_step)
     AND OLD.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'workshop progress can only be changed by its own rep';
  END IF;

  -- Lifecycle columns: ONLY the submit RPC moves these (it flags itself via
  -- a transaction-local GUC — the time-clock app.edit_reason idiom). Without
  -- this, a rep could PATCH status='submitted'/workshop_completed=true over
  -- PostgREST and skip every completeness check in submit_purpose_profile.
  IF (NEW.status IS DISTINCT FROM OLD.status
      OR NEW.workshop_completed IS DISTINCT FROM OLD.workshop_completed
      OR NEW.started_at IS DISTINCT FROM OLD.started_at
      OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
      OR NEW.version_number IS DISTINCT FROM OLD.version_number)
     AND COALESCE(current_setting('purpose.internal', true), '') <> '1' THEN
    RAISE EXCEPTION 'submission state moves only through submit_purpose_profile()';
  END IF;

  RETURN NEW;
END $$;

-- Named a_guard so it fires before touch_updated_at (BEFORE triggers run
-- alphabetically).
DROP TRIGGER IF EXISTS purpose_profiles_a_guard ON public.purpose_profiles;
CREATE TRIGGER purpose_profiles_a_guard
  BEFORE UPDATE ON public.purpose_profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_purpose_profile_update();

-- ── 13) Revision-log trigger on the four content tables ──────────────────────
-- Pre-submit the workshop is a scratchpad (autosave churn would drown the
-- log), so revisions only record once the parent profile is
-- workshop_completed. SECURITY DEFINER because authenticated has no INSERT
-- path to the log — the trigger is the only pen.

CREATE OR REPLACE FUNCTION public.log_purpose_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _completed boolean;
BEGIN
  SELECT workshop_completed INTO _completed
  FROM public.purpose_profiles
  WHERE id = OLD.purpose_profile_id;

  IF NOT COALESCE(_completed, false) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- No-op updates (touch pokes) don't earn a history row.
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) = to_jsonb(OLD) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.purpose_revision_log
    (table_name, row_id, purpose_profile_id, user_id, actor, action, old_row, new_row)
  VALUES
    (TG_TABLE_NAME, OLD.id, OLD.purpose_profile_id, OLD.user_id, auth.uid(),
     lower(TG_OP), to_jsonb(OLD),
     CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(NEW) END);

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

DROP TRIGGER IF EXISTS purpose_goals_zz_revision ON public.purpose_goals;
CREATE TRIGGER purpose_goals_zz_revision
  AFTER UPDATE OR DELETE ON public.purpose_goals
  FOR EACH ROW EXECUTE FUNCTION public.log_purpose_revision();

DROP TRIGGER IF EXISTS purpose_beliefs_zz_revision ON public.purpose_beliefs;
CREATE TRIGGER purpose_beliefs_zz_revision
  AFTER UPDATE OR DELETE ON public.purpose_beliefs
  FOR EACH ROW EXECUTE FUNCTION public.log_purpose_revision();

DROP TRIGGER IF EXISTS purpose_whys_zz_revision ON public.purpose_whys;
CREATE TRIGGER purpose_whys_zz_revision
  AFTER UPDATE OR DELETE ON public.purpose_whys
  FOR EACH ROW EXECUTE FUNCTION public.log_purpose_revision();

DROP TRIGGER IF EXISTS purpose_if_then_plans_zz_revision ON public.purpose_if_then_plans;
CREATE TRIGGER purpose_if_then_plans_zz_revision
  AFTER UPDATE OR DELETE ON public.purpose_if_then_plans
  FOR EACH ROW EXECUTE FUNCTION public.log_purpose_revision();

-- ── 14) RPC: ensure_purpose_profile ──────────────────────────────────────────
-- The app's entry point: idempotently mints (or fetches) the caller's
-- profile. Role is derived server-side — never trusted from the client —
-- and the launch flag gates reps while owners walk the workshop pre-launch.

CREATE OR REPLACE FUNCTION public.ensure_purpose_profile()
RETURNS public.purpose_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _role text;
  _row public.purpose_profiles;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF public.has_role(_uid, 'owner'::app_role) THEN
    _role := 'owner';
  ELSIF public.has_role(_uid, 'sales_rep'::app_role) THEN
    _role := 'sales_rep';
  ELSE
    RAISE EXCEPTION 'My Purpose is for the sales team';
  END IF;

  IF _role = 'sales_rep'
     AND NOT COALESCE(
       (SELECT sales_rep_feature_enabled FROM public.purpose_admin_config WHERE id),
       false) THEN
    RAISE EXCEPTION 'My Purpose is not open yet';
  END IF;

  INSERT INTO public.purpose_profiles (user_id, role, status)
  VALUES (_uid, _role, 'in_progress')
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO _row FROM public.purpose_profiles WHERE user_id = _uid;
  RETURN _row;
END $$;

REVOKE ALL ON FUNCTION public.ensure_purpose_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_purpose_profile() TO authenticated, service_role;

-- ── 15) RPC: save_purpose_answer — the ONLY write path into purpose_answers ──
-- Pre-submit: overwrite in place (autosave). Post-submit: append a new
-- version and retire the old one. Marking a key private retro-privatizes
-- every version of it, so no shared copy of a privatized answer survives.

CREATE OR REPLACE FUNCTION public.save_purpose_answer(
  _question_key text,
  _module_key text,
  _answer_type text,
  _text text DEFAULT NULL,
  _number numeric DEFAULT NULL,
  _date date DEFAULT NULL,
  _json jsonb DEFAULT NULL,
  _visibility text DEFAULT 'leadership_shared',
  _required boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _profile public.purpose_profiles;
  -- MUST mirror PRIVATE_ELIGIBLE_ANSWER_KEYS in
  -- src/lib/purpose/questionKeys.ts — the client offers "Private to me" on
  -- exactly these keys and this array is the server-side truth. Change them
  -- together or not at all. (Whys and reflections carry their own
  -- visibility columns in their own tables and are NOT listed here.)
  _privateable text[] := ARRAY['m1_life_context','m4_personal_focus_change'];
  _current public.purpose_answers;
  _id uuid;
  _version int;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF _visibility NOT IN ('leadership_shared','private_to_rep') THEN
    RAISE EXCEPTION 'invalid visibility: %', _visibility;
  END IF;
  IF _visibility = 'private_to_rep' AND NOT (_question_key = ANY (_privateable)) THEN
    RAISE EXCEPTION '% is not a private-eligible question', _question_key;
  END IF;

  -- FOR UPDATE serializes concurrent autosaves on the same profile: two
  -- in-flight saves of one key queue here instead of racing the
  -- version/is_current bookkeeping below.
  SELECT * INTO _profile
  FROM public.purpose_profiles
  WHERE user_id = _uid
  FOR UPDATE;

  IF _profile.id IS NULL THEN
    RAISE EXCEPTION 'no purpose profile — call ensure_purpose_profile() first';
  END IF;

  -- Launch gate mirrors ensure_purpose_profile: owners bypass, reps need
  -- the flag (a rep mid-autosave when the flag flips off gets a clean error,
  -- not a silent drop).
  IF _profile.role = 'sales_rep'
     AND NOT COALESCE(
       (SELECT sales_rep_feature_enabled FROM public.purpose_admin_config WHERE id),
       false) THEN
    RAISE EXCEPTION 'My Purpose is not open yet';
  END IF;

  SELECT * INTO _current
  FROM public.purpose_answers
  WHERE purpose_profile_id = _profile.id
    AND question_key = _question_key
    AND is_current;

  IF _current.id IS NULL THEN
    -- First answer to this question.
    INSERT INTO public.purpose_answers (
      purpose_profile_id, user_id, question_key, module_key, answer_type,
      answer_value_text, answer_value_number, answer_value_date, answer_value_json,
      visibility, required)
    VALUES (
      _profile.id, _uid, _question_key, _module_key, _answer_type,
      _text, _number, _date, _json,
      _visibility, _required)
    RETURNING id, answer_version INTO _id, _version;
  ELSIF NOT _profile.workshop_completed THEN
    -- Workshop in progress: autosave overwrites in place.
    UPDATE public.purpose_answers
    SET module_key = _module_key,
        answer_type = _answer_type,
        answer_value_text = _text,
        answer_value_number = _number,
        answer_value_date = _date,
        answer_value_json = _json,
        visibility = _visibility,
        required = _required,
        answered_at = now()
    WHERE id = _current.id
    RETURNING id, answer_version INTO _id, _version;
  ELSE
    -- Post-submit edit: retire the current version, append the next.
    UPDATE public.purpose_answers SET is_current = false WHERE id = _current.id;

    INSERT INTO public.purpose_answers (
      purpose_profile_id, user_id, question_key, module_key, answer_type,
      answer_value_text, answer_value_number, answer_value_date, answer_value_json,
      visibility, required, answer_version, is_current)
    VALUES (
      _profile.id, _uid, _question_key, _module_key, _answer_type,
      _text, _number, _date, _json,
      _visibility, _required, _current.answer_version + 1, true)
    RETURNING id, answer_version INTO _id, _version;
  END IF;

  -- Retro-privacy: going private buries every older version too — leadership
  -- must not be able to read v1 of an answer whose v3 was marked private.
  IF _visibility = 'private_to_rep' THEN
    UPDATE public.purpose_answers
    SET visibility = 'private_to_rep'
    WHERE purpose_profile_id = _profile.id
      AND question_key = _question_key
      AND visibility <> 'private_to_rep';
  END IF;

  RETURN jsonb_build_object('id', _id, 'answer_version', _version);
END $$;

REVOKE ALL ON FUNCTION public.save_purpose_answer(text, text, text, text, numeric, date, jsonb, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_purpose_answer(text, text, text, text, numeric, date, jsonb, text, boolean) TO authenticated, service_role;

-- ── 16) RPC: submit_purpose_profile ──────────────────────────────────────────
-- Validates the workshop's non-negotiables server-side (the client checks
-- too, but the client is a suggestion) and flips the profile to submitted.
-- Re-submitting after post-workshop edits bumps version_number.

CREATE OR REPLACE FUNCTION public.submit_purpose_profile()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _profile public.purpose_profiles;
  _missing text[] := ARRAY[]::text[];
  _gt text;
  _why_count int;
  _core_ok boolean;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO _profile
  FROM public.purpose_profiles
  WHERE user_id = _uid
  FOR UPDATE;

  IF _profile.id IS NULL THEN
    RAISE EXCEPTION 'no purpose profile — call ensure_purpose_profile() first';
  END IF;

  -- 1-year target: description + measurable outcome + a real date.
  IF NOT EXISTS (
    SELECT 1 FROM public.purpose_goals g
    WHERE g.purpose_profile_id = _profile.id
      AND g.goal_type = 'target_1_year'
      AND COALESCE(btrim(g.goal_description), '') <> ''
      AND g.target_date IS NOT NULL
      AND COALESCE(btrim(g.measurable_outcome), '') <> ''
  ) THEN
    _missing := _missing || '1-year target (description, measurable outcome, target date)';
  END IF;

  -- 3-year possibility, 90-day mission, professional focus: described.
  FOREACH _gt IN ARRAY ARRAY['possibility_3_year','mission_90_day','professional_focus'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.purpose_goals g
      WHERE g.purpose_profile_id = _profile.id
        AND g.goal_type = _gt
        AND COALESCE(btrim(g.goal_description), '') <> ''
    ) THEN
      _missing := _missing || (_gt || ' goal description');
    END IF;
  END LOOP;

  -- Ceiling work: fact vs story named, plus the belief turned into a question.
  IF NOT EXISTS (
    SELECT 1 FROM public.purpose_beliefs b
    WHERE b.purpose_profile_id = _profile.id
      AND COALESCE(btrim(b.fact_statement), '') <> ''
      AND COALESCE(btrim(b.story_statement), '') <> ''
      AND COALESCE(btrim(b.belief_to_question), '') <> ''
  ) THEN
    _missing := _missing || 'ceiling work (fact statement, story statement, belief-to-question)';
  END IF;

  -- Seven whys, all seven, each carrying SUBSTANCE — either written text or
  -- (for a privacy-marked level) at least its high-level category. Counting
  -- bare rows would let seven empty inserts through PostgREST satisfy QA #9;
  -- level 5 is the spec's named "cost of staying the same".
  SELECT COUNT(*) INTO _why_count
  FROM public.purpose_whys w
  WHERE w.purpose_profile_id = _profile.id
    AND (
      COALESCE(btrim(w.answer_text), '') <> ''
      OR COALESCE(btrim(w.answer_category), '') <> ''
    );

  SELECT bool_or(w.is_core_why AND COALESCE(btrim(w.answer_text), '') <> '')
  INTO _core_ok
  FROM public.purpose_whys w
  WHERE w.purpose_profile_id = _profile.id AND w.level_number = 7;

  IF _why_count <> 7 OR NOT COALESCE(_core_ok, false) THEN
    _missing := _missing || 'seven levels of why (level 7 must be the written Core Why)';
  END IF;

  -- If-then plan: both halves.
  IF NOT EXISTS (
    SELECT 1 FROM public.purpose_if_then_plans p
    WHERE p.purpose_profile_id = _profile.id
      AND COALESCE(btrim(p.trigger_statement), '') <> ''
      AND COALESCE(btrim(p.response_statement), '') <> ''
  ) THEN
    _missing := _missing || 'if-then plan (trigger and response)';
  END IF;

  -- The identity commitment, in the rep's own words.
  IF NOT EXISTS (
    SELECT 1 FROM public.purpose_answers a
    WHERE a.purpose_profile_id = _profile.id
      AND a.question_key = 'm5_identity_commitment'
      AND a.is_current
      AND COALESCE(btrim(a.answer_value_text), '') <> ''
  ) THEN
    _missing := _missing || 'identity commitment';
  END IF;

  IF array_length(_missing, 1) > 0 THEN
    RAISE EXCEPTION 'Incomplete: %', array_to_string(_missing, '; ');
  END IF;

  -- Unlock the guard trigger's lifecycle gate for THIS transaction only —
  -- direct PostgREST updates to these columns stay blocked.
  PERFORM set_config('purpose.internal', '1', true);

  -- workshop_completed in the SET expressions reads the OLD value: a first
  -- submit stays version 1; a re-submit after post-workshop edits bumps it.
  UPDATE public.purpose_profiles
  SET status = 'submitted',
      workshop_completed = true,
      completed_at = COALESCE(completed_at, now()),
      version_number = version_number + CASE WHEN workshop_completed THEN 1 ELSE 0 END
  WHERE id = _profile.id;

  RETURN jsonb_build_object('ok', true);
END $$;

REVOKE ALL ON FUNCTION public.submit_purpose_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_purpose_profile() TO authenticated, service_role;

-- ── 17) RPC: get_purpose_whys_for_leadership — the masked whys read ──────────
-- The ONLY leadership window into purpose_whys (see the table's comment: no
-- owner SELECT policy exists on it). Private levels come back with their
-- text nulled but their category metadata intact, so the dashboard can show
-- "level 5: family (private)" without ever holding the words. Non-owners get
-- zero rows — the gate lives in the WHERE clause, inside the definer.

CREATE OR REPLACE FUNCTION public.get_purpose_whys_for_leadership(_purpose_profile_id uuid)
RETURNS TABLE (
  level_number int,
  prompt_text text,
  answer_text text,
  answer_category text,
  answer_categories_json jsonb,
  is_core_why boolean,
  visibility text,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    w.level_number,
    CASE WHEN w.visibility = 'leadership_shared' THEN w.prompt_text END,
    CASE WHEN w.visibility = 'leadership_shared' THEN w.answer_text END,
    w.answer_category,
    w.answer_categories_json,
    w.is_core_why,
    w.visibility,
    w.updated_at
  FROM public.purpose_whys w
  WHERE w.purpose_profile_id = _purpose_profile_id
    AND public.has_role(auth.uid(), 'owner'::app_role)
  ORDER BY w.level_number;
$$;

REVOKE ALL ON FUNCTION public.get_purpose_whys_for_leadership(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_purpose_whys_for_leadership(uuid) TO authenticated, service_role;

-- ── 18) Realtime: none, on purpose ───────────────────────────────────────────
-- No purpose_* table joins the supabase_realtime publication. These rows are
-- privacy-sensitive personal writing; the workshop is a solo activity and
-- the leadership dashboard refetches on navigation. Nothing here needs a
-- live wire, so nothing gets one.
