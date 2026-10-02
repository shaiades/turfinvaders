-- Tidal Activity Test (owner, 2026-10-01): the high-performer habit +
-- activity assessment. Round 1 was run as a Google Form; this migration
-- creates the store, seeds the 10 form responses VERBATIM (scores are the
-- form's own grading, never recomputed at import — never-invent-numbers),
-- and ships the aggregates-only team-stats RPC that lets the rep-facing
-- Goals tab show team avg / best / adoption without any teammate's answer
-- sheet crossing RLS (the get_purpose_whys_for_leadership masking doctrine).
-- Reps retake in-app (source 'in_app'); history is immutable.
-- Idempotent. Apply via: supabase db query --linked --file <this file>

-- 1) The takes. One row per rep per take.
CREATE TABLE IF NOT EXISTS public.activity_tests (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id     uuid NOT NULL REFERENCES public.profiles (id),
  -- LA calendar date, sent by the client (laTodayISO) — never UTC current_date.
  taken_on   date NOT NULL,
  source     text NOT NULL DEFAULT 'in_app'
    CHECK (source IN ('google_form', 'in_app')),
  -- Questionnaire version (src/lib/activity-test.ts TEST_VERSION). Takes of
  -- different versions are never compared or trended against each other.
  version    int  NOT NULL DEFAULT 1,
  -- habit_key -> 'yes'|'no' plus the 3 activity question keys -> chosen
  -- option value, keys per src/data/activity-test-content.ts.
  answers    jsonb NOT NULL DEFAULT '{}'::jsonb,
  score      int  NOT NULL CHECK (score >= 0),
  max_score  int  NOT NULL DEFAULT 30,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A re-run of this migration, or a double-tapped in-app submit on one
  -- day, can never duplicate a take.
  UNIQUE (rep_id, taken_on, source)
);

CREATE INDEX IF NOT EXISTS activity_tests_rep_idx
  ON public.activity_tests (rep_id, taken_on DESC);

ALTER TABLE public.activity_tests ENABLE ROW LEVEL SECURITY;

-- Reps read their own takes.
DROP POLICY IF EXISTS "activity_tests own read" ON public.activity_tests;
CREATE POLICY "activity_tests own read"
  ON public.activity_tests FOR SELECT TO authenticated
  USING (rep_id = auth.uid());

-- Admin tier (owner + office staff) reads all — the named leadership board.
DROP POLICY IF EXISTS "activity_tests admin read" ON public.activity_tests;
CREATE POLICY "activity_tests admin read"
  ON public.activity_tests FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
  );

-- Reps append their own in-app retakes only; imported rows are seeded here
-- (service-side). No UPDATE/DELETE policies: test history is immutable.
DROP POLICY IF EXISTS "activity_tests own insert" ON public.activity_tests;
CREATE POLICY "activity_tests own insert"
  ON public.activity_tests FOR INSERT TO authenticated
  WITH CHECK (rep_id = auth.uid() AND source = 'in_app');

GRANT SELECT, INSERT ON public.activity_tests TO authenticated;
GRANT ALL ON public.activity_tests TO service_role;

-- 2) Aggregates-only team stats. SECURITY DEFINER because plain RLS gives a
--    rep only their own rows, but the Goals tab shows team avg / best /
--    per-habit adoption and the caller's rank. Returns COUNTS AND AVERAGES
--    ONLY — never an individual's answers (that read exists solely for the
--    admin tier via the policy above).
CREATE OR REPLACE FUNCTION public.get_activity_test_team_stats()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT (
    has_role(auth.uid(), 'sales_rep'::app_role)
    OR has_role(auth.uid(), 'owner'::app_role)
    OR has_role(auth.uid(), 'office_staff'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  WITH latest AS (
    -- Latest take per ACTIVE, non-placeholder sales rep.
    SELECT DISTINCT ON (t.rep_id) t.rep_id, t.score, t.answers
    FROM activity_tests t
    JOIN profiles p ON p.id = t.rep_id
      AND COALESCE(p.is_active, true)
      AND NOT COALESCE(p.is_placeholder, false)
    WHERE EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = t.rep_id AND ur.role = 'sales_rep'::app_role
    )
    ORDER BY t.rep_id, t.taken_on DESC, t.created_at DESC
  )
  SELECT jsonb_build_object(
    'n', (SELECT count(*) FROM latest),
    'avg_score', (SELECT round(avg(score)::numeric, 1) FROM latest),
    'best_score', (SELECT max(score) FROM latest),
    -- Competition ranking of the CALLER among the latest takes (ties share
    -- a rank); null when the caller has no take in the set.
    'my_rank', (
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM latest WHERE rep_id = auth.uid())
        THEN NULL
        ELSE 1 + (SELECT count(*) FROM latest
                  WHERE score > (SELECT score FROM latest WHERE rep_id = auth.uid()))
      END
    ),
    -- {question_key: {"yes": n, "no": m, "<option>": k}} across the latest
    -- takes — anonymous adoption fractions, nothing per-rep.
    'answer_counts', (
      SELECT COALESCE(jsonb_object_agg(agg.key, agg.counts), '{}'::jsonb)
      FROM (
        SELECT per.key, jsonb_object_agg(per.value, per.cnt) AS counts
        FROM (
          SELECT kv.key, kv.value, count(*) AS cnt
          FROM latest, jsonb_each_text(latest.answers) kv
          GROUP BY kv.key, kv.value
        ) per
        GROUP BY per.key
      ) agg
    )
  ) INTO result;

  RETURN result;
END $$;

GRANT EXECUTE ON FUNCTION public.get_activity_test_team_stats() TO authenticated;

-- 3) Seed — the 10 Google Form responses (submitted 2026-10-01), answers
--    and scores transcribed VERBATIM from the form's grading. Profile
--    lookup happens AT APPLY TIME by display_name (lower + btrim both
--    sides: the form has 'Curtis Westergard ' with a trailing space); a
--    missing or ambiguous name ABORTS the migration rather than silently
--    skipping or mis-crediting a rep.
DO $$
DECLARE
  r record;
  v_rep uuid;
  v_count int;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('Jovanny Paz', 23, '{
      "gym_exercise":"no","role_play_weekly":"yes","meditate":"no","game_plan_day":"yes",
      "read_books":"no","audiobooks_between_leads":"yes","meal_prep":"yes","eat_out_every_day":"no",
      "saturday_hungover":"no","appts_15_early":"yes","knock_neighbors_jips":"yes","visualize_goals":"no",
      "pipeline_reloads":"yes","help_teammates_role_play":"yes","morning_affirmations":"no",
      "go_home_between_leads":"no","visit_jips_photos":"yes","notes_meetings":"yes","review_numbers_ti":"no",
      "jip_visits_week":"2","visits_per_jip":"2","prev_customers_week":"2"
    }'::jsonb),
    ('Jonathan Paz', 16, '{
      "gym_exercise":"no","role_play_weekly":"no","meditate":"no","game_plan_day":"no",
      "read_books":"no","audiobooks_between_leads":"no","meal_prep":"yes","eat_out_every_day":"no",
      "saturday_hungover":"no","appts_15_early":"yes","knock_neighbors_jips":"no","visualize_goals":"no",
      "pipeline_reloads":"yes","help_teammates_role_play":"no","morning_affirmations":"no",
      "go_home_between_leads":"no","visit_jips_photos":"yes","notes_meetings":"yes","review_numbers_ti":"no",
      "jip_visits_week":"5+","visits_per_jip":"3","prev_customers_week":"2"
    }'::jsonb),
    ('Yakup Sancakli', 29, '{
      "gym_exercise":"yes","role_play_weekly":"yes","meditate":"yes","game_plan_day":"yes",
      "read_books":"yes","audiobooks_between_leads":"yes","meal_prep":"yes","eat_out_every_day":"no",
      "saturday_hungover":"no","appts_15_early":"yes","knock_neighbors_jips":"yes","visualize_goals":"yes",
      "pipeline_reloads":"yes","help_teammates_role_play":"yes","morning_affirmations":"yes",
      "go_home_between_leads":"no","visit_jips_photos":"yes","notes_meetings":"yes","review_numbers_ti":"no",
      "jip_visits_week":"5+","visits_per_jip":"5+","prev_customers_week":"2"
    }'::jsonb),
    ('Josiah Haas', 23, '{
      "gym_exercise":"yes","role_play_weekly":"no","meditate":"yes","game_plan_day":"yes",
      "read_books":"yes","audiobooks_between_leads":"yes","meal_prep":"yes","eat_out_every_day":"no",
      "saturday_hungover":"no","appts_15_early":"no","knock_neighbors_jips":"yes","visualize_goals":"no",
      "pipeline_reloads":"yes","help_teammates_role_play":"no","morning_affirmations":"yes",
      "go_home_between_leads":"no","visit_jips_photos":"yes","notes_meetings":"yes","review_numbers_ti":"no",
      "jip_visits_week":"3","visits_per_jip":"4","prev_customers_week":"4+"
    }'::jsonb),
    ('Jaxon Heilman', 7, '{
      "gym_exercise":"yes","role_play_weekly":"no","meditate":"no","game_plan_day":"no",
      "read_books":"no","audiobooks_between_leads":"no","meal_prep":"yes","eat_out_every_day":"no",
      "saturday_hungover":"no","appts_15_early":"no","knock_neighbors_jips":"no","visualize_goals":"no",
      "pipeline_reloads":"yes","help_teammates_role_play":"no","morning_affirmations":"no",
      "go_home_between_leads":"no","visit_jips_photos":"no","notes_meetings":"no","review_numbers_ti":"no",
      "jip_visits_week":"1","visits_per_jip":"1","prev_customers_week":"0"
    }'::jsonb),
    ('Bergan Lundak', 15, '{
      "gym_exercise":"yes","role_play_weekly":"no","meditate":"no","game_plan_day":"yes",
      "read_books":"no","audiobooks_between_leads":"no","meal_prep":"no","eat_out_every_day":"yes",
      "saturday_hungover":"no","appts_15_early":"yes","knock_neighbors_jips":"yes","visualize_goals":"no",
      "pipeline_reloads":"yes","help_teammates_role_play":"no","morning_affirmations":"no",
      "go_home_between_leads":"no","visit_jips_photos":"yes","notes_meetings":"yes","review_numbers_ti":"no",
      "jip_visits_week":"1","visits_per_jip":"2","prev_customers_week":"4+"
    }'::jsonb),
    ('Bradley Crouse', 19, '{
      "gym_exercise":"no","role_play_weekly":"yes","meditate":"no","game_plan_day":"yes",
      "read_books":"yes","audiobooks_between_leads":"yes","meal_prep":"no","eat_out_every_day":"no",
      "saturday_hungover":"no","appts_15_early":"yes","knock_neighbors_jips":"no","visualize_goals":"no",
      "pipeline_reloads":"yes","help_teammates_role_play":"yes","morning_affirmations":"no",
      "go_home_between_leads":"no","visit_jips_photos":"yes","notes_meetings":"yes","review_numbers_ti":"yes",
      "jip_visits_week":"1","visits_per_jip":"4","prev_customers_week":"0"
    }'::jsonb),
    ('Alfredo Castro', 18, '{
      "gym_exercise":"no","role_play_weekly":"yes","meditate":"yes","game_plan_day":"no",
      "read_books":"no","audiobooks_between_leads":"no","meal_prep":"no","eat_out_every_day":"no",
      "saturday_hungover":"no","appts_15_early":"yes","knock_neighbors_jips":"no","visualize_goals":"no",
      "pipeline_reloads":"yes","help_teammates_role_play":"yes","morning_affirmations":"yes",
      "go_home_between_leads":"no","visit_jips_photos":"yes","notes_meetings":"yes","review_numbers_ti":"no",
      "jip_visits_week":"2","visits_per_jip":"5+","prev_customers_week":"1"
    }'::jsonb),
    ('Curtis Westergard ', 29, '{
      "gym_exercise":"yes","role_play_weekly":"yes","meditate":"yes","game_plan_day":"yes",
      "read_books":"yes","audiobooks_between_leads":"yes","meal_prep":"no","eat_out_every_day":"no",
      "saturday_hungover":"no","appts_15_early":"yes","knock_neighbors_jips":"yes","visualize_goals":"yes",
      "pipeline_reloads":"yes","help_teammates_role_play":"yes","morning_affirmations":"yes",
      "go_home_between_leads":"no","visit_jips_photos":"yes","notes_meetings":"yes","review_numbers_ti":"yes",
      "jip_visits_week":"3","visits_per_jip":"5+","prev_customers_week":"4+"
    }'::jsonb),
    ('Samuel Corona', 24, '{
      "gym_exercise":"no","role_play_weekly":"yes","meditate":"yes","game_plan_day":"yes",
      "read_books":"yes","audiobooks_between_leads":"no","meal_prep":"no","eat_out_every_day":"no",
      "saturday_hungover":"no","appts_15_early":"yes","knock_neighbors_jips":"no","visualize_goals":"yes",
      "pipeline_reloads":"yes","help_teammates_role_play":"yes","morning_affirmations":"no",
      "go_home_between_leads":"no","visit_jips_photos":"yes","notes_meetings":"yes","review_numbers_ti":"yes",
      "jip_visits_week":"3","visits_per_jip":"2","prev_customers_week":"2"
    }'::jsonb)
  ) AS t(form_name, score, answers)
  LOOP
    SELECT count(*) INTO v_count
    FROM public.profiles
    WHERE lower(btrim(display_name)) = lower(btrim(r.form_name));

    IF v_count = 0 THEN
      RAISE EXCEPTION 'activity_tests seed: no profile named "%"', r.form_name;
    ELSIF v_count > 1 THEN
      RAISE EXCEPTION 'activity_tests seed: name "%" is ambiguous (% profiles)', r.form_name, v_count;
    END IF;

    SELECT id INTO v_rep
    FROM public.profiles
    WHERE lower(btrim(display_name)) = lower(btrim(r.form_name));

    INSERT INTO public.activity_tests (rep_id, taken_on, source, version, answers, score, max_score)
    VALUES (v_rep, date '2026-10-01', 'google_form', 1, r.answers, r.score, 30)
    ON CONFLICT (rep_id, taken_on, source) DO NOTHING;
  END LOOP;
END $$;
