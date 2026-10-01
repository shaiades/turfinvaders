-- ═══════════════════════════════════════════════════════════════════════════
-- CAPTAIN CREW TIME POWERS (owner-approved 2026-10-01).
--
-- The van works as a unit: everyone rides in together, breaks for lunch
-- together, and rides home together. This migration gives the van captain
-- the clock to match:
--
--   1) Bulk "now" punches for the whole van: crew_clock_in, crew_clock_out,
--      crew_start_lunch, crew_end_lunch. Deliberately NO time parameters —
--      a bulk punch records the actual moment it happened (CA records must
--      reflect real time; backdating goes through the reasoned adjust RPCs
--      below). Per-member skip-and-report: one member's conflict (already
--      clocked in, no open shift, …) never blocks the rest of the van.
--      Bulk punches are stamped entry_source='crew' so provenance survives.
--   2) Captains may ADJUST their own van's records: the admin RPCs
--      (admin_update_time_entry / admin_set_meal / admin_create_time_entry /
--      void_time_entry) gain a captain arm — own team only, never their own
--      entries ("ask a manager"). Owner decision 2026-10-01: captain edits
--      are final (no admin re-approval), defended by the reason requirement
--      + the append-only time_entry_audit trail. captain_edit_needs_review()
--      is the one-function policy toggle if that ever changes.
--   3) Guard doctrine unchanged: a non-empty app.edit_reason proves a write
--      came through one of our SECURITY DEFINER RPCs (set_config is not
--      reachable through PostgREST). The guards now admit a reasoned write
--      from a captain whose team matches the target — STRICTLY: a captain
--      with no van matches nobody (approve_time_entry's IS DISTINCT FROM
--      let two NULL teams match; that hole is closed here too).
--
-- Replaces (full bodies, triggers unchanged):
--   guard_time_entry_write  v3 → v4   (20260824100000)
--   guard_meal_write        v1 → v2   (20260819120000)
--   admin_update_time_entry v1 → v2   (20260819120000)
--   void_time_entry         v1 → v2   (20260819120000)
--   admin_set_meal          v2 → v3   (20260824100000)
--   admin_create_time_entry v2 → v3   (20260911120000)
--   approve_time_entry      v1 → v2   (20260824100000)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) entry_source gains 'crew' (bulk-punch provenance) ────────────────────

ALTER TABLE public.time_entries DROP CONSTRAINT time_entries_source_chk;
ALTER TABLE public.time_entries ADD CONSTRAINT time_entries_source_chk
  CHECK (entry_source IN ('self','auto_closed','manager_edit','manager_created','crew'));

-- ── 2) Captain team scope, shared by guards and RPCs ────────────────────────

-- Policy toggle (owner decision 2026-10-01: captain edits are final). When
-- flipped to true, captain adjustments keep needs_correction raised with a
-- 'captain_edit' flag so admins re-approve them in the review queue.
CREATE OR REPLACE FUNCTION public.captain_edit_needs_review()
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$ SELECT false $$;

-- Authorization gate for the reasoned adjust RPCs. Returns true for admins,
-- false for a captain who passed the team checks; RAISEs for everyone else.
CREATE OR REPLACE FUNCTION public.assert_time_adjust_rights(_target uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  IF public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff') THEN
    RETURN true;
  END IF;
  IF NOT public.has_role(auth.uid(), 'captain') THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF public.my_team_id(auth.uid()) IS NULL
     OR public.my_team_id(_target) IS DISTINCT FROM public.my_team_id(auth.uid()) THEN
    RAISE EXCEPTION 'captains adjust records for their own team only';
  END IF;
  IF _target = auth.uid() THEN
    RAISE EXCEPTION 'you cannot adjust your own time records — ask a manager';
  END IF;
  RETURN false;
END $$;

-- ── 3) guard_time_entry_write v4: reasoned captain writes pass, own team ────

CREATE OR REPLACE FUNCTION public.guard_time_entry_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _privileged boolean;
  _captain_ok boolean := false;
  _reason text := NULLIF(current_setting('app.edit_reason', true), '');
  _target uuid;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  _privileged := public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff');

  IF TG_OP = 'INSERT' THEN _target := NEW.user_id; ELSE _target := OLD.user_id; END IF;
  IF NOT _privileged AND _reason IS NOT NULL
     AND public.has_role(auth.uid(), 'captain') THEN
    -- Strict: a vanless captain matches nobody (two NULL teams must NOT match).
    _captain_ok := public.my_team_id(auth.uid()) IS NOT NULL
               AND public.my_team_id(_target) = public.my_team_id(auth.uid());
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF (_privileged OR _captain_ok) AND _reason IS NOT NULL THEN
      -- A reasoned insert can only come through an RPC, so 'crew' (set by
      -- the bulk punch RPCs) is trustworthy; anything else is a backfill.
      IF NEW.entry_source IS DISTINCT FROM 'crew' THEN
        NEW.entry_source := 'manager_created';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.user_id <> auth.uid() THEN
      RAISE EXCEPTION 'creating an entry for someone else requires a reason (use the timesheet editor)';
    END IF;
    IF NEW.clock_out IS NOT NULL
       OR abs(extract(epoch FROM (NEW.clock_in - now()))) > 300 THEN
      RAISE EXCEPTION 'clock-in must be now — past or future punches need a manager correction';
    END IF;
    NEW.entry_source := 'self';
    NEW.needs_correction := false;
    NEW.flag_reasons := '{}';
    NEW.reviewed_by := NULL; NEW.reviewed_at := NULL;
    NEW.voided_at := NULL; NEW.voided_by := NULL; NEW.void_reason := NULL;
    RETURN NEW;
  END IF;

  -- Pure touches (recompute pokes) pass for anyone RLS admitted.
  IF NEW.clock_in IS NOT DISTINCT FROM OLD.clock_in
     AND NEW.clock_out IS NOT DISTINCT FROM OLD.clock_out
     AND NEW.log_date IS NOT DISTINCT FROM OLD.log_date
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.meal_status IS NOT DISTINCT FROM OLD.meal_status
     AND NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at
     AND NEW.entry_source IS NOT DISTINCT FROM OLD.entry_source
     AND NEW.needs_correction IS NOT DISTINCT FROM OLD.needs_correction
     AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at THEN
    RETURN NEW;
  END IF;

  -- Reasoned approval-only writes (review stamp set, times untouched) come
  -- from approve_time_entry, which already checked captain/admin rights.
  IF _reason IS NOT NULL
     AND NEW.reviewed_at IS NOT NULL AND OLD.reviewed_at IS DISTINCT FROM NEW.reviewed_at
     AND NEW.clock_in IS NOT DISTINCT FROM OLD.clock_in
     AND NEW.clock_out IS NOT DISTINCT FROM OLD.clock_out
     AND NEW.log_date IS NOT DISTINCT FROM OLD.log_date
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.meal_status IS NOT DISTINCT FROM OLD.meal_status
     AND NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at THEN
    RETURN NEW;
  END IF;

  IF _privileged OR _captain_ok THEN
    IF _reason IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF NOT (auth.uid() = OLD.user_id AND OLD.clock_out IS NULL
            AND NEW.clock_out IS NOT NULL AND NEW.voided_at IS NULL) THEN
      RAISE EXCEPTION 'editing time records requires a reason (use the timesheet editor)';
    END IF;
  END IF;

  IF OLD.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'not your time entry';
  END IF;
  IF OLD.clock_out IS NOT NULL THEN
    RAISE EXCEPTION 'closed entries are read-only — ask a manager for a correction';
  END IF;
  IF NEW.clock_out IS NULL OR abs(extract(epoch FROM (NEW.clock_out - now()))) > 300 THEN
    RAISE EXCEPTION 'clock-out must be now — corrections go through a manager';
  END IF;
  IF NEW.clock_in IS DISTINCT FROM OLD.clock_in
     OR NEW.log_date IS DISTINCT FROM OLD.log_date
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.voided_at IS DISTINCT FROM OLD.voided_at
     OR NEW.entry_source IS DISTINCT FROM OLD.entry_source
     OR NEW.flag_reasons IS DISTINCT FROM OLD.flag_reasons
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by THEN
    RAISE EXCEPTION 'only clock-out and meal attestation can change on a punch-out';
  END IF;
  -- Workers may never LOWER the review flag; compute (which runs after this
  -- guard) may still RAISE it during the same punch-out.
  IF OLD.needs_correction AND NOT NEW.needs_correction THEN
    RAISE EXCEPTION 'flagged entries are cleared by captain/manager approval only';
  END IF;
  IF NEW.meal_status IS DISTINCT FROM OLD.meal_status
     AND NEW.meal_status NOT IN ('missed', 'unrecorded') THEN
    RAISE EXCEPTION 'attestation can only mark a meal missed or unrecorded';
  END IF;
  RETURN NEW;
END $$;

-- ── 4) guard_meal_write v2: same captain arm (via the parent entry) ─────────

CREATE OR REPLACE FUNCTION public.guard_meal_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _privileged boolean;
  _captain_ok boolean := false;
  _reason text := NULLIF(current_setting('app.edit_reason', true), '');
  _entry record;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  _privileged := public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff');

  SELECT user_id, clock_out INTO _entry FROM public.time_entries WHERE id = NEW.time_entry_id;
  IF NOT _privileged AND _reason IS NOT NULL
     AND public.has_role(auth.uid(), 'captain') THEN
    _captain_ok := public.my_team_id(auth.uid()) IS NOT NULL
               AND public.my_team_id(_entry.user_id) = public.my_team_id(auth.uid());
  END IF;
  IF (_privileged OR _captain_ok) AND _reason IS NOT NULL THEN
    RETURN NEW; -- reasoned manager/captain fix (admin_set_meal, crew lunch RPCs)
  END IF;

  IF _entry.user_id IS NULL OR _entry.user_id <> auth.uid() OR NEW.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'not your shift';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF _entry.clock_out IS NOT NULL THEN
      RAISE EXCEPTION 'lunch can only start while clocked in';
    END IF;
    IF NEW.meal_end IS NOT NULL OR abs(extract(epoch FROM (NEW.meal_start - now()))) > 300 THEN
      RAISE EXCEPTION 'lunch must start now — past meals need a manager correction';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.meal_end IS NOT NULL THEN
    RAISE EXCEPTION 'closed meals are read-only — ask a manager for a correction';
  END IF;
  IF NEW.meal_start IS DISTINCT FROM OLD.meal_start
     OR NEW.time_entry_id IS DISTINCT FROM OLD.time_entry_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'only the lunch end time can be set';
  END IF;
  IF NEW.meal_end IS NULL OR abs(extract(epoch FROM (NEW.meal_end - now()))) > 300 THEN
    RAISE EXCEPTION 'lunch end must be now';
  END IF;
  RETURN NEW;
END $$;

-- ── 5) Adjust RPCs gain the captain arm (call sites unchanged) ──────────────

CREATE OR REPLACE FUNCTION public.admin_update_time_entry(
  _id uuid, _clock_in timestamptz, _clock_out timestamptz, _reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _target uuid;
  _is_admin boolean;
  _flag_review boolean;
BEGIN
  SELECT user_id INTO _target FROM public.time_entries WHERE id = _id;
  IF _target IS NULL THEN RAISE EXCEPTION 'time entry not found'; END IF;
  _is_admin := public.assert_time_adjust_rights(_target);
  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'a reason is required to edit a time record';
  END IF;
  IF _clock_out IS NOT NULL AND _clock_out <= _clock_in THEN
    RAISE EXCEPTION 'clock-out must be after clock-in';
  END IF;
  _flag_review := NOT _is_admin AND public.captain_edit_needs_review();
  PERFORM set_config('app.edit_reason', _reason, true);
  UPDATE public.time_entries
  SET clock_in = _clock_in,
      clock_out = _clock_out,
      log_date = (_clock_in AT TIME ZONE 'America/Los_Angeles')::date,
      entry_source = 'manager_edit',
      needs_correction = _flag_review,
      flag_reasons = CASE WHEN _flag_review AND NOT ('captain_edit' = ANY(flag_reasons))
                          THEN array_append(flag_reasons, 'captain_edit')
                          ELSE flag_reasons END
  WHERE id = _id;
  IF NOT FOUND THEN RAISE EXCEPTION 'time entry not found'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.void_time_entry(_id uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _target uuid;
BEGIN
  SELECT user_id INTO _target FROM public.time_entries WHERE id = _id;
  IF _target IS NULL THEN RAISE EXCEPTION 'time entry not found'; END IF;
  PERFORM public.assert_time_adjust_rights(_target);
  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'a reason is required to void a time record';
  END IF;
  PERFORM set_config('app.edit_reason', _reason, true);
  UPDATE public.time_entries
  SET voided_at = now(), voided_by = auth.uid(), void_reason = btrim(_reason)
  WHERE id = _id AND voided_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'time entry not found (or already voided)'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.admin_set_meal(
  _time_entry_id uuid, _meal_start timestamptz, _meal_end timestamptz, _reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid;
  _first uuid;
  _is_admin boolean;
  _flag_review boolean;
BEGIN
  SELECT user_id INTO _uid FROM public.time_entries WHERE id = _time_entry_id;
  IF _uid IS NULL THEN RAISE EXCEPTION 'time entry not found'; END IF;
  _is_admin := public.assert_time_adjust_rights(_uid);
  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'a reason is required to edit meal records';
  END IF;
  IF _meal_end <= _meal_start THEN
    RAISE EXCEPTION 'meal end must be after meal start';
  END IF;
  _flag_review := NOT _is_admin AND public.captain_edit_needs_review();
  PERFORM set_config('app.edit_reason', _reason, true);
  SELECT id INTO _first FROM public.meal_periods
  WHERE time_entry_id = _time_entry_id
  ORDER BY meal_start LIMIT 1;
  IF _first IS NULL THEN
    INSERT INTO public.meal_periods (time_entry_id, user_id, meal_start, meal_end)
    VALUES (_time_entry_id, _uid, _meal_start, _meal_end);
  ELSE
    UPDATE public.meal_periods
    SET meal_start = _meal_start, meal_end = _meal_end
    WHERE id = _first;
    UPDATE public.meal_periods
    SET meal_start = _meal_start, meal_end = _meal_start
    WHERE time_entry_id = _time_entry_id AND id <> _first;
  END IF;
  IF _flag_review THEN
    UPDATE public.time_entries
    SET needs_correction = true,
        flag_reasons = CASE WHEN NOT ('captain_edit' = ANY(flag_reasons))
                            THEN array_append(flag_reasons, 'captain_edit')
                            ELSE flag_reasons END
    WHERE id = _time_entry_id;
  ELSE
    UPDATE public.time_entries
    SET needs_correction = false,
        reviewed_by = auth.uid(),
        reviewed_at = now()
    WHERE id = _time_entry_id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.admin_create_time_entry(
  _user_id uuid, _clock_in timestamptz, _clock_out timestamptz, _reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _new_id uuid;
  _is_admin boolean;
  _flag_review boolean;
BEGIN
  _is_admin := public.assert_time_adjust_rights(_user_id);
  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'a reason is required to create a time record';
  END IF;
  IF _clock_out IS NOT NULL AND _clock_out <= _clock_in THEN
    RAISE EXCEPTION 'clock-out must be after clock-in';
  END IF;
  _flag_review := NOT _is_admin AND public.captain_edit_needs_review();
  PERFORM set_config('app.edit_reason', _reason, true);
  INSERT INTO public.time_entries (user_id, clock_in, clock_out, log_date, entry_source)
  VALUES (_user_id, _clock_in, _clock_out,
          (_clock_in AT TIME ZONE 'America/Los_Angeles')::date, 'manager_created')
  RETURNING id INTO _new_id;
  IF _flag_review THEN
    UPDATE public.time_entries
    SET needs_correction = true,
        flag_reasons = CASE WHEN NOT ('captain_edit' = ANY(flag_reasons))
                            THEN array_append(flag_reasons, 'captain_edit')
                            ELSE flag_reasons END
    WHERE id = _new_id;
  ELSE
    UPDATE public.time_entries
    SET needs_correction = false,
        reviewed_by = auth.uid(),
        reviewed_at = now()
    WHERE id = _new_id AND needs_correction;
  END IF;
  RETURN _new_id;
END $$;

-- ── 6) approve_time_entry v2: a vanless captain approves nobody ─────────────

CREATE OR REPLACE FUNCTION public.approve_time_entry(_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row record;
  _is_admin boolean;
BEGIN
  SELECT user_id, needs_correction, voided_at INTO _row
  FROM public.time_entries WHERE id = _id;
  IF _row.user_id IS NULL THEN RAISE EXCEPTION 'time entry not found'; END IF;
  IF _row.voided_at IS NOT NULL THEN RAISE EXCEPTION 'entry is voided'; END IF;

  _is_admin := public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff');
  IF NOT _is_admin THEN
    IF NOT public.has_role(auth.uid(), 'captain') THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
    IF public.my_team_id(auth.uid()) IS NULL
       OR public.my_team_id(_row.user_id) IS DISTINCT FROM public.my_team_id(auth.uid()) THEN
      RAISE EXCEPTION 'captains approve entries for their own team only';
    END IF;
    IF _row.user_id = auth.uid() THEN
      RAISE EXCEPTION 'you cannot approve your own time entry — ask a manager';
    END IF;
  END IF;

  PERFORM set_config('app.edit_reason', 'approved in review queue', true);
  UPDATE public.time_entries
  SET needs_correction = false,
      reviewed_by = auth.uid(),
      reviewed_at = now()
  WHERE id = _id;
END $$;

-- ── 7) The bulk crew punch RPCs ─────────────────────────────────────────────
-- Shared shape: admin (any van) or captain (own van only); 1–30 distinct
-- members; per-member subtransaction so one conflict never kills the batch;
-- RAISE only for authorization — per-member outcomes ride the result jsonb:
--   { ok: n, skipped: n, results: [{user_id, status: ok|skipped|error,
--     code?, entry_id?, closed_lunch?}] }
-- Audit rows land via the existing zz triggers (actor = the captain,
-- reason = the crew-action sentence below).

CREATE OR REPLACE FUNCTION public.crew_clock_in(_user_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _is_admin boolean := public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff');
  _my_team uuid := public.my_team_id(auth.uid());
  _uid uuid;
  _entry_id uuid;
  _code text;
  _results jsonb := '[]'::jsonb;
  _ok int := 0;
  _skipped int := 0;
BEGIN
  IF NOT _is_admin THEN
    IF NOT public.has_role(auth.uid(), 'captain') OR _my_team IS NULL THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  END IF;
  IF _user_ids IS NULL OR array_length(_user_ids, 1) IS NULL OR array_length(_user_ids, 1) > 30 THEN
    RAISE EXCEPTION 'select 1–30 crew members';
  END IF;
  PERFORM set_config('app.edit_reason', 'crew clock-in (live bulk punch)', true);
  FOR _uid IN SELECT DISTINCT u FROM unnest(_user_ids) u LOOP
    BEGIN
      _code := NULL;
      IF NOT _is_admin AND public.my_team_id(_uid) IS DISTINCT FROM _my_team THEN
        _code := 'not_your_team';
      ELSIF EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.id = _uid AND p.is_active IS NOT DISTINCT FROM false) THEN
        _code := 'inactive';
      ELSIF EXISTS (SELECT 1 FROM public.time_entries te
                    WHERE te.user_id = _uid AND te.clock_out IS NULL AND te.voided_at IS NULL) THEN
        _code := 'already_clocked_in';
      ELSE
        INSERT INTO public.time_entries (user_id, clock_in, log_date, entry_source)
        VALUES (_uid, now(), (now() AT TIME ZONE 'America/Los_Angeles')::date, 'crew')
        RETURNING id INTO _entry_id;
        _ok := _ok + 1;
        _results := _results || jsonb_build_object('user_id', _uid, 'status', 'ok', 'entry_id', _entry_id);
        CONTINUE;
      END IF;
      _skipped := _skipped + 1;
      _results := _results || jsonb_build_object('user_id', _uid, 'status', 'skipped', 'code', _code);
    EXCEPTION WHEN OTHERS THEN
      _skipped := _skipped + 1;
      _results := _results || jsonb_build_object('user_id', _uid, 'status', 'error', 'code', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('ok', _ok, 'skipped', _skipped, 'results', _results);
END $$;

CREATE OR REPLACE FUNCTION public.crew_clock_out(_user_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _is_admin boolean := public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff');
  _my_team uuid := public.my_team_id(auth.uid());
  _uid uuid;
  _open_id uuid;
  _closed_lunch boolean;
  _code text;
  _results jsonb := '[]'::jsonb;
  _ok int := 0;
  _skipped int := 0;
BEGIN
  IF NOT _is_admin THEN
    IF NOT public.has_role(auth.uid(), 'captain') OR _my_team IS NULL THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  END IF;
  IF _user_ids IS NULL OR array_length(_user_ids, 1) IS NULL OR array_length(_user_ids, 1) > 30 THEN
    RAISE EXCEPTION 'select 1–30 crew members';
  END IF;
  PERFORM set_config('app.edit_reason', 'crew clock-out (live bulk punch)', true);
  FOR _uid IN SELECT DISTINCT u FROM unnest(_user_ids) u LOOP
    BEGIN
      _code := NULL; _closed_lunch := false; _open_id := NULL;
      IF NOT _is_admin AND public.my_team_id(_uid) IS DISTINCT FROM _my_team THEN
        _code := 'not_your_team';
      ELSE
        SELECT te.id INTO _open_id FROM public.time_entries te
        WHERE te.user_id = _uid AND te.clock_out IS NULL AND te.voided_at IS NULL
        LIMIT 1;
        IF _open_id IS NULL THEN
          _code := 'no_open_shift';
        ELSE
          -- An open lunch ends when the shift ends.
          UPDATE public.meal_periods SET meal_end = now()
          WHERE time_entry_id = _open_id AND meal_end IS NULL;
          IF FOUND THEN _closed_lunch := true; END IF;
          UPDATE public.time_entries
          SET clock_out = now(), entry_source = 'crew'
          WHERE id = _open_id;
          _ok := _ok + 1;
          _results := _results || jsonb_build_object('user_id', _uid, 'status', 'ok',
                                                     'entry_id', _open_id, 'closed_lunch', _closed_lunch);
          CONTINUE;
        END IF;
      END IF;
      _skipped := _skipped + 1;
      _results := _results || jsonb_build_object('user_id', _uid, 'status', 'skipped', 'code', _code);
    EXCEPTION WHEN OTHERS THEN
      _skipped := _skipped + 1;
      _results := _results || jsonb_build_object('user_id', _uid, 'status', 'error', 'code', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('ok', _ok, 'skipped', _skipped, 'results', _results);
END $$;

CREATE OR REPLACE FUNCTION public.crew_start_lunch(_user_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _is_admin boolean := public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff');
  _my_team uuid := public.my_team_id(auth.uid());
  _uid uuid;
  _open_id uuid;
  _code text;
  _results jsonb := '[]'::jsonb;
  _ok int := 0;
  _skipped int := 0;
BEGIN
  IF NOT _is_admin THEN
    IF NOT public.has_role(auth.uid(), 'captain') OR _my_team IS NULL THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  END IF;
  IF _user_ids IS NULL OR array_length(_user_ids, 1) IS NULL OR array_length(_user_ids, 1) > 30 THEN
    RAISE EXCEPTION 'select 1–30 crew members';
  END IF;
  PERFORM set_config('app.edit_reason', 'crew lunch start (live bulk punch)', true);
  FOR _uid IN SELECT DISTINCT u FROM unnest(_user_ids) u LOOP
    BEGIN
      _code := NULL; _open_id := NULL;
      IF NOT _is_admin AND public.my_team_id(_uid) IS DISTINCT FROM _my_team THEN
        _code := 'not_your_team';
      ELSE
        SELECT te.id INTO _open_id FROM public.time_entries te
        WHERE te.user_id = _uid AND te.clock_out IS NULL AND te.voided_at IS NULL
        LIMIT 1;
        IF _open_id IS NULL THEN
          _code := 'no_open_shift';
        ELSIF EXISTS (SELECT 1 FROM public.meal_periods mp
                      WHERE mp.time_entry_id = _open_id AND mp.meal_end IS NULL) THEN
          _code := 'already_on_lunch';
        ELSE
          INSERT INTO public.meal_periods (time_entry_id, user_id, meal_start)
          VALUES (_open_id, _uid, now());
          _ok := _ok + 1;
          _results := _results || jsonb_build_object('user_id', _uid, 'status', 'ok', 'entry_id', _open_id);
          CONTINUE;
        END IF;
      END IF;
      _skipped := _skipped + 1;
      _results := _results || jsonb_build_object('user_id', _uid, 'status', 'skipped', 'code', _code);
    EXCEPTION
      WHEN unique_violation THEN
        -- meal_periods_one_open_per_entry: someone raced us — same outcome.
        _skipped := _skipped + 1;
        _results := _results || jsonb_build_object('user_id', _uid, 'status', 'skipped', 'code', 'already_on_lunch');
      WHEN OTHERS THEN
        _skipped := _skipped + 1;
        _results := _results || jsonb_build_object('user_id', _uid, 'status', 'error', 'code', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('ok', _ok, 'skipped', _skipped, 'results', _results);
END $$;

CREATE OR REPLACE FUNCTION public.crew_end_lunch(_user_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _is_admin boolean := public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff');
  _my_team uuid := public.my_team_id(auth.uid());
  _uid uuid;
  _meal_id uuid;
  _code text;
  _results jsonb := '[]'::jsonb;
  _ok int := 0;
  _skipped int := 0;
BEGIN
  IF NOT _is_admin THEN
    IF NOT public.has_role(auth.uid(), 'captain') OR _my_team IS NULL THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  END IF;
  IF _user_ids IS NULL OR array_length(_user_ids, 1) IS NULL OR array_length(_user_ids, 1) > 30 THEN
    RAISE EXCEPTION 'select 1–30 crew members';
  END IF;
  PERFORM set_config('app.edit_reason', 'crew lunch end (live bulk punch)', true);
  FOR _uid IN SELECT DISTINCT u FROM unnest(_user_ids) u LOOP
    BEGIN
      _code := NULL; _meal_id := NULL;
      IF NOT _is_admin AND public.my_team_id(_uid) IS DISTINCT FROM _my_team THEN
        _code := 'not_your_team';
      ELSE
        SELECT mp.id INTO _meal_id
        FROM public.meal_periods mp
        JOIN public.time_entries te ON te.id = mp.time_entry_id
        WHERE te.user_id = _uid AND te.clock_out IS NULL AND te.voided_at IS NULL
          AND mp.meal_end IS NULL
        LIMIT 1;
        IF _meal_id IS NULL THEN
          _code := 'not_on_lunch';
        ELSE
          UPDATE public.meal_periods SET meal_end = now() WHERE id = _meal_id;
          _ok := _ok + 1;
          _results := _results || jsonb_build_object('user_id', _uid, 'status', 'ok');
          CONTINUE;
        END IF;
      END IF;
      _skipped := _skipped + 1;
      _results := _results || jsonb_build_object('user_id', _uid, 'status', 'skipped', 'code', _code);
    EXCEPTION WHEN OTHERS THEN
      _skipped := _skipped + 1;
      _results := _results || jsonb_build_object('user_id', _uid, 'status', 'error', 'code', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('ok', _ok, 'skipped', _skipped, 'results', _results);
END $$;

-- ── 8) Grants ───────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.crew_clock_in(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crew_clock_out(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crew_start_lunch(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crew_end_lunch(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assert_time_adjust_rights(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crew_clock_in(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_clock_out(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_start_lunch(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_end_lunch(uuid[]) TO authenticated;
