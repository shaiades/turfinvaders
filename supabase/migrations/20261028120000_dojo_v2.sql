-- ═══════════════════════════════════════════════════════════════════════════
-- OBJECTION DOJO v2 (conversion audit 2026-10-15, Phase 2 §3) — the Dojo
-- drills the SAME six objections canvassers actually tag at the door
-- (src/lib/objections.ts → field_pins.objection), each coached with the
-- Empathy → Clarification → Realignment rebuttal (copy lives in
-- src/data/door-script.ts; the DB row carries identity + the model-video
-- slot, never the words). What's new:
--
--   1. objections.door_key           — binds a Dojo card to the door
--                                      objection label ("Drill this" deep
--                                      link + rebuttal copy lookup).
--      objections.model_video_path   — the slot for Shai's model take
--                                      (coach-videos bucket below).
--      The four 2026-08-15 seed prompts are retired (active = false); the
--      six door objections are seeded in their place.
--   2. objection_attempts.points_awarded — approved drills score ARCADE
--      points (1/drill, cap 3 per LA week), stamped at review time so the
--      ladder just sums. Game points only — the pay engine reads daily_logs
--      and is untouched.
--   3. review_objection_attempt() RPC — compare-and-swap review (pending →
--      approved/denied exactly once, fixing the old panel's unguarded
--      update), callable by owner/office_staff AND by a captain for their
--      OWN van (owner decision 2026-10-15; same-team rule mirrors
--      day_off_requests 20261002180000). Approval stamps the capped points
--      and posts the drill to the Street Feed (kind 'dojo').
--   4. Captains can SELECT their own van's attempts (review queue).
--   5. coach-videos bucket (private) — model takes now; Phase 5's "Message
--      from Shai" reuses it.
--
-- Idempotent — safe to re-paste.
-- Apply via: supabase db query --linked --file supabase/migrations/20261028120000_dojo_v2.sql
-- Runs AFTER 20260815010000 (objection_dojo) and 20260913120000 (dojo push).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) Objections: door binding + model-video slot + reseed ─────────────────
ALTER TABLE public.objections
  ADD COLUMN IF NOT EXISTS door_key text,
  ADD COLUMN IF NOT EXISTS model_video_path text;

CREATE UNIQUE INDEX IF NOT EXISTS objections_door_key_uk
  ON public.objections (door_key) WHERE door_key IS NOT NULL;

-- Retire the four 2026-08-15 generic prompts (exact seed titles only — an
-- owner-added custom objection is left alone).
UPDATE public.objections
SET active = false
WHERE door_key IS NULL
  AND title IN (
    'I''m Not Interested', 'I Don''t Have Money',
    'I Need to Talk to My Spouse', 'I''m Too Busy'
  );

-- Seed the six door objections. door_key must equal the DOOR_OBJECTIONS
-- label in src/lib/objections.ts — it's the join key for the rebuttal copy
-- and the field_pins.objection stats.
INSERT INTO public.objections (title, prompt, sort, active, door_key)
SELECT v.title, v.prompt, v.sort, true, v.door_key
FROM (VALUES
  ('Have a guy',         'They already have a roofer. Empathy → Clarification → Realignment.', 1, 'Have a guy'),
  ('Not interested',     'The reflex no. Empathy → Clarification → Realignment.',              2, 'Not interested'),
  ('No money',           'Price fear before price exists. Empathy → Clarification → Realignment.', 3, 'No money'),
  ('Not now',            'Bad timing. Empathy → Clarification → Realignment.',                 4, 'Not now'),
  ('Talk to my spouse',  'The half-a-decision. Empathy → Clarification → Realignment.',        5, 'Talk to my spouse'),
  ('Other',              'The curveball. Empathy → Clarification → Realignment.',              6, 'Other')
) AS v(title, prompt, sort, door_key)
WHERE NOT EXISTS (
  SELECT 1 FROM public.objections o WHERE o.door_key = v.door_key
);

-- ── 2) Points on approved drills ─────────────────────────────────────────────
ALTER TABLE public.objection_attempts
  ADD COLUMN IF NOT EXISTS points_awarded numeric;

-- ── 3) Captain review visibility (own van only) ──────────────────────────────
DROP POLICY IF EXISTS "Captains see own van attempts" ON public.objection_attempts;
CREATE POLICY "Captains see own van attempts"
  ON public.objection_attempts FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'captain'::app_role)
    AND public.my_team_id(auth.uid()) IS NOT NULL
    AND public.my_team_id(canvasser_id) = public.my_team_id(auth.uid())
  );

-- ── 4) Review RPC: CAS + capped points + Street Feed ─────────────────────────
-- The weekly cap counts POINTED approvals by reviewed_at in the current LA
-- ISO week; approvals past the cap still go live, at 0 points (the Kombat
-- role_play precedent). Deliberately NO direct-update path for captains —
-- the old client UPDATE policy stays owner/office-only, so this RPC is the
-- single captain door and the CAS can't be bypassed.
CREATE OR REPLACE FUNCTION public.review_objection_attempt(
  _attempt_id uuid, _status text, _deny_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _caller uuid := auth.uid();
  _is_admin boolean;
  _is_captain boolean;
  _row public.objection_attempts%ROWTYPE;
  _week_start date := (date_trunc('week', (now() AT TIME ZONE 'America/Los_Angeles')))::date;
  _pointed_this_week int;
  _award numeric := NULL;
  _title text;
  _name text;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _status NOT IN ('approved', 'denied') THEN
    RAISE EXCEPTION 'Status must be approved or denied';
  END IF;

  _is_admin := public.has_role(_caller, 'owner'::app_role)
    OR public.has_role(_caller, 'office_staff'::app_role);
  _is_captain := public.has_role(_caller, 'captain'::app_role);
  IF NOT (_is_admin OR _is_captain) THEN
    RAISE EXCEPTION 'Only Owners, Admins, or Captains can review Dojo attempts';
  END IF;

  SELECT * INTO _row FROM public.objection_attempts WHERE id = _attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attempt not found'; END IF;

  IF NOT _is_admin THEN
    -- Captain lane: own van only (strict — a vanless captain matches
    -- nobody, same as day_off_requests), and never their own take.
    IF _row.canvasser_id = _caller THEN
      RAISE EXCEPTION 'You can''t review your own attempt';
    END IF;
    IF public.my_team_id(_caller) IS NULL
       OR public.my_team_id(_row.canvasser_id) IS DISTINCT FROM public.my_team_id(_caller) THEN
      RAISE EXCEPTION 'Captains review their own van only';
    END IF;
  END IF;

  IF _row.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_' || _row.status);
  END IF;

  IF _status = 'approved' THEN
    -- Serialize per canvasser so two concurrent approvals can't both land
    -- under the cap.
    PERFORM pg_advisory_xact_lock(hashtext('dojo_award' || _row.canvasser_id::text));
    SELECT count(*) INTO _pointed_this_week
    FROM public.objection_attempts
    WHERE canvasser_id = _row.canvasser_id
      AND status = 'approved'
      AND COALESCE(points_awarded, 0) > 0
      AND (reviewed_at AT TIME ZONE 'America/Los_Angeles')::date >= _week_start;
    _award := CASE WHEN _pointed_this_week >= 3 THEN 0 ELSE 1 END;
  END IF;

  UPDATE public.objection_attempts SET
    status = _status,
    deny_reason = CASE WHEN _status = 'denied' THEN _deny_reason ELSE NULL END,
    reviewed_by = _caller,
    reviewed_at = now(),
    points_awarded = _award
  WHERE id = _attempt_id AND status = 'pending';

  IF _status = 'approved' THEN
    SELECT title INTO _title FROM public.objections WHERE id = _row.objection_id;
    SELECT display_name INTO _name FROM public.profiles WHERE id = _row.canvasser_id;
    -- Street Feed shout (kind 'dojo'); SECURITY DEFINER bypasses the
    -- leaders-only insert policy, created_by NULL = system (feed-trigger
    -- convention). Best effort — a feed hiccup must never fail the review.
    BEGIN
      INSERT INTO public.feed_events (kind, actor_name, body, created_by)
      VALUES (
        'dojo',
        COALESCE(_name, 'A player'),
        '🥋 ' || COALESCE(_name, 'A player') || ' drilled “' || COALESCE(_title, 'an objection')
          || '” — live in the Dojo' || CASE WHEN _award > 0 THEN ' · +1 pt' ELSE '' END,
        NULL
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'status', _status,
    'points_awarded', _award,
    'capped', _status = 'approved' AND _award = 0
  );
END $$;
REVOKE ALL ON FUNCTION public.review_objection_attempt(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_objection_attempt(uuid, text, text)
  TO authenticated, service_role;

-- ── 5) coach-videos bucket (model takes now, Phase 5 messages later) ─────────
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('coach-videos', 'coach-videos', false, 50 * 1024 * 1024)
ON CONFLICT (id) DO UPDATE SET file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS "Coach videos admin write" ON storage.objects;
CREATE POLICY "Coach videos admin write"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'coach-videos'
    AND (public.has_role(auth.uid(), 'owner'::app_role)
         OR public.has_role(auth.uid(), 'office_staff'::app_role))
  );

DROP POLICY IF EXISTS "Coach videos admin read" ON storage.objects;
CREATE POLICY "Coach videos admin read"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'coach-videos'
    AND (public.has_role(auth.uid(), 'owner'::app_role)
         OR public.has_role(auth.uid(), 'office_staff'::app_role))
  );

-- Everyone may watch a model take that an objection card references — the
-- same shape as the approved-attempt read on objection-attempts.
DROP POLICY IF EXISTS "Coach videos model read" ON storage.objects;
CREATE POLICY "Coach videos model read"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'coach-videos'
    AND EXISTS (
      SELECT 1 FROM public.objections o WHERE o.model_video_path = name
    )
  );

DROP POLICY IF EXISTS "Coach videos admin delete" ON storage.objects;
CREATE POLICY "Coach videos admin delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'coach-videos'
    AND (public.has_role(auth.uid(), 'owner'::app_role)
         OR public.has_role(auth.uid(), 'office_staff'::app_role))
  );
