-- ═══════════════════════════════════════════════════════════════════════════
-- HR ROLE — ACCESS (owner ask 2026-10-15, for Zuleyma Hernandez).
-- Requires 20261025120000_hr_role_enum.sql applied FIRST (its own execution).
--
-- HR is the TIME & ATTENDANCE administrator:
--   · READ everything timekeeping: punches, meals, audit trail, passes,
--     weekly attestations, absences, the sick-leave ledger/balances.
--   · WRITE the attendance surface with the same powers as the Admin tier:
--     edit/create/void punches, set meal times, resolve meal/rest states,
--     approve flagged entries, grant passes, record absences (any kind, any
--     date), review day-off requests.
--   · NO payroll dollars: payroll_runs/_lines policies and the paycheck
--     engine (calc_weekly_paycheck, the fleet server fns) are untouched —
--     pay stays with the Admin tier + the bookkeeper.
--
-- Mechanics: a new is_time_admin() names the tier ONCE; every time-side
-- authorization that read "owner OR office_staff" now reads is_time_admin.
-- Re-emitted full bodies (behavior otherwise unchanged):
--   assert_time_adjust_rights  v1 → v2   (20261002120000)
--   guard_time_entry_write     v7 → v8   (20261022120000)
--   guard_meal_write           v3 → v4   (20261002140000)
--   approve_time_entry         v2 → v3   (20261002120000)
--   grant/revoke_time_clock_exception v1 → v2 (20260911120000)
--   submit/review/cancel_day_off v2 → v3 (20261023120000)
-- Client mirrors in the same PR: role-policy.ts (APP_ROLES, labels,
-- TIME_ADMIN_ROLES), users.functions.ts, AppShell nav, dashboard fan-out,
-- reports route gate, notify-flagged-punch / notify-day-off audiences.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0) The time-admin tier, named once ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_time_admin(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.has_role(_uid, 'owner')
      OR public.has_role(_uid, 'office_staff')
      OR public.has_role(_uid, 'hr')
$$;

REVOKE ALL ON FUNCTION public.is_time_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_time_admin(uuid) TO authenticated, service_role;

-- ── 1) Read policies: HR joins the time-records read tier ────────────────────

DROP POLICY IF EXISTS "Users view own time entries" ON public.time_entries;
CREATE POLICY "Users view own time entries" ON public.time_entries
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper')
         OR public.has_role(auth.uid(), 'hr'));

DROP POLICY IF EXISTS "meal read own or staff" ON public.meal_periods;
CREATE POLICY "meal read own or staff" ON public.meal_periods
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper')
         OR public.has_role(auth.uid(), 'hr'));

DROP POLICY IF EXISTS "audit read own or staff" ON public.time_entry_audit;
CREATE POLICY "audit read own or staff" ON public.time_entry_audit
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.time_entries te
                 WHERE te.id = time_entry_audit.time_entry_id
                   AND te.user_id = auth.uid())
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper')
         OR public.has_role(auth.uid(), 'hr'));

DROP POLICY IF EXISTS "passes read own or staff" ON public.time_clock_exceptions;
CREATE POLICY "passes read own or staff" ON public.time_clock_exceptions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper')
         OR public.has_role(auth.uid(), 'hr'));

DROP POLICY IF EXISTS "attestations read own or staff" ON public.time_week_attestations;
CREATE POLICY "attestations read own or staff" ON public.time_week_attestations
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper')
         OR public.has_role(auth.uid(), 'hr'));

DROP POLICY IF EXISTS "day off read own or staff" ON public.day_off_requests;
CREATE POLICY "day off read own or staff" ON public.day_off_requests
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper')
         OR public.has_role(auth.uid(), 'hr'));

DROP POLICY IF EXISTS "sick ledger read own or staff" ON public.sick_leave_ledger;
CREATE POLICY "sick ledger read own or staff" ON public.sick_leave_ledger
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper')
         OR public.has_role(auth.uid(), 'hr'));

-- ── 2) assert_time_adjust_rights v2: HR adjusts anyone, like the Admins ──────

CREATE OR REPLACE FUNCTION public.assert_time_adjust_rights(_target uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  IF public.is_time_admin(auth.uid()) THEN
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

-- ── 3) guard_time_entry_write v8: HR joins the privileged tier ───────────────
-- Identical to v7 (20261022120000) except _privileged.

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
  _privileged := public.is_time_admin(auth.uid());

  IF TG_OP = 'INSERT' THEN _target := NEW.user_id; ELSE _target := OLD.user_id; END IF;
  IF NOT _privileged AND _reason IS NOT NULL
     AND public.has_role(auth.uid(), 'captain') THEN
    -- Strict: a vanless captain matches nobody (two NULL teams must NOT match).
    _captain_ok := public.my_team_id(auth.uid()) IS NOT NULL
               AND public.my_team_id(_target) = public.my_team_id(auth.uid());
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- log_date is server truth (compute re-derives it too) — normalized
    -- BEFORE the freeze check so a client-sent date can't dodge the lock.
    NEW.log_date := (NEW.clock_in AT TIME ZONE 'America/Los_Angeles')::date;
    IF public.week_is_frozen(NEW.log_date) THEN
      RAISE EXCEPTION 'that week''s payroll is approved and locked — an owner must reopen the run to correct records';
    END IF;
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
    NEW.meal_status := 'pending';
    NEW.second_meal_status := 'not_required';
    NEW.rest_break_status := 'pending';
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
     AND NEW.second_meal_status IS NOT DISTINCT FROM OLD.second_meal_status
     AND NEW.rest_break_status IS NOT DISTINCT FROM OLD.rest_break_status
     AND NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at
     AND NEW.entry_source IS NOT DISTINCT FROM OLD.entry_source
     AND NEW.needs_correction IS NOT DISTINCT FROM OLD.needs_correction
     AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at THEN
    RETURN NEW;
  END IF;

  -- The freeze lock: both the entry's old week and (for a date move) its
  -- new week must be unlocked before anything meaningful can change.
  IF public.week_is_frozen(OLD.log_date) OR public.week_is_frozen(NEW.log_date) THEN
    RAISE EXCEPTION 'that week''s payroll is approved and locked — an owner must reopen the run to correct records';
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

  -- The worker's own post-hoc attestation (attest_shift): a reasoned write
  -- on their own CLOSED entry that resolves ONLY pending states — meal
  -- pending → missed/unrecorded, rest pending → ok/missed. Times,
  -- provenance, review stamps and the flag stay untouchable.
  IF _reason IS NOT NULL
     AND auth.uid() = OLD.user_id
     AND OLD.clock_out IS NOT NULL
     AND NEW.clock_in IS NOT DISTINCT FROM OLD.clock_in
     AND NEW.clock_out IS NOT DISTINCT FROM OLD.clock_out
     AND NEW.log_date IS NOT DISTINCT FROM OLD.log_date
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at
     AND NEW.entry_source IS NOT DISTINCT FROM OLD.entry_source
     AND NEW.second_meal_status IS NOT DISTINCT FROM OLD.second_meal_status
     AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at
     AND NEW.reviewed_by IS NOT DISTINCT FROM OLD.reviewed_by
     AND NOT (OLD.needs_correction AND NOT NEW.needs_correction)
     AND (NEW.meal_status IS NOT DISTINCT FROM OLD.meal_status
          OR (OLD.meal_status = 'pending' AND NEW.meal_status IN ('missed', 'unrecorded')))
     AND (NEW.rest_break_status IS NOT DISTINCT FROM OLD.rest_break_status
          OR (OLD.rest_break_status = 'pending' AND NEW.rest_break_status IN ('ok', 'missed')))
  THEN
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
     OR NEW.second_meal_status IS DISTINCT FROM OLD.second_meal_status
     OR NEW.flag_reasons IS DISTINCT FROM OLD.flag_reasons
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by THEN
    RAISE EXCEPTION 'only clock-out and the attestations can change on a punch-out';
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
  IF NEW.rest_break_status IS DISTINCT FROM OLD.rest_break_status
     AND NEW.rest_break_status NOT IN ('ok', 'missed') THEN
    RAISE EXCEPTION 'attestation can only mark rest breaks ok or missed';
  END IF;
  RETURN NEW;
END $$;

-- ── 4) guard_meal_write v4: HR joins the privileged tier ─────────────────────
-- Identical to v3 (20261002140000) except _privileged.

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
  _privileged := public.is_time_admin(auth.uid());

  SELECT user_id, clock_out, log_date INTO _entry
  FROM public.time_entries WHERE id = NEW.time_entry_id;

  IF _entry.log_date IS NOT NULL AND public.week_is_frozen(_entry.log_date) THEN
    RAISE EXCEPTION 'that week''s payroll is approved and locked — an owner must reopen the run to correct records';
  END IF;

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

-- ── 5) approve_time_entry v3: HR approves like the Admins ────────────────────

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

  _is_admin := public.is_time_admin(auth.uid());
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

-- ── 6) Passes v2: HR grants and revokes early/late passes ────────────────────

CREATE OR REPLACE FUNCTION public.grant_time_clock_exception(
  _user_id uuid, _date date, _early_from time, _late_until time, _reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _new_id uuid;
BEGIN
  IF NOT public.is_time_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'a reason is required to grant an early/late pass';
  END IF;
  IF _early_from IS NULL AND _late_until IS NULL THEN
    RAISE EXCEPTION 'grant an early start, a late finish, or both';
  END IF;

  -- Replace any active pass for the same person/day (history kept).
  UPDATE public.time_clock_exceptions
  SET revoked_at = now(), revoked_by = auth.uid()
  WHERE user_id = _user_id AND exception_date = _date AND revoked_at IS NULL;

  INSERT INTO public.time_clock_exceptions
    (user_id, exception_date, early_from, late_until, reason, granted_by)
  VALUES (_user_id, _date, _early_from, _late_until, btrim(_reason), auth.uid())
  RETURNING id INTO _new_id;
  RETURN _new_id;
END $$;

CREATE OR REPLACE FUNCTION public.revoke_time_clock_exception(_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_time_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  UPDATE public.time_clock_exceptions
  SET revoked_at = now(), revoked_by = auth.uid()
  WHERE id = _id AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'pass not found (or already revoked)'; END IF;
END $$;

-- ── 7) Absence RPCs v3: HR records and reviews absences like the Admins ──────
-- Identical to v2 (20261023120000) except _is_admin.

CREATE OR REPLACE FUNCTION public.submit_day_off(
  _user_id uuid, _dates date[], _kind text, _reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _is_admin boolean := public.is_time_admin(auth.uid());
  _is_captain boolean := public.has_role(auth.uid(), 'captain');
  _self boolean := (_user_id = auth.uid());
  _as_record boolean;
  _d date;
  _code text;
  _new_id uuid;
  _results jsonb := '[]'::jsonb;
  _ok int := 0;
  _skipped int := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF _dates IS NULL OR array_length(_dates, 1) IS NULL OR array_length(_dates, 1) > 31 THEN
    RAISE EXCEPTION 'pick 1–31 days';
  END IF;

  IF _self THEN
    IF _kind NOT IN ('day_off','sick','other') THEN
      RAISE EXCEPTION 'you can request a day off or call in sick — other kinds are entered by your captain';
    END IF;
  ELSE
    IF NOT _is_admin THEN
      IF NOT _is_captain THEN RAISE EXCEPTION 'not authorized'; END IF;
      IF public.my_team_id(auth.uid()) IS NULL
         OR public.my_team_id(_user_id) IS DISTINCT FROM public.my_team_id(auth.uid()) THEN
        RAISE EXCEPTION 'captains record absences for their own team only';
      END IF;
    END IF;
  END IF;

  -- A manager/captain entry for someone ELSE is a record, auto-approved.
  -- Anything for yourself — captain included — awaits someone else's review.
  _as_record := NOT _self;

  FOR _d IN SELECT DISTINCT u FROM unnest(_dates) u ORDER BY 1 LOOP
    BEGIN
      _code := NULL;
      IF EXISTS (SELECT 1 FROM public.day_off_requests r
                 WHERE r.user_id = _user_id AND r.absence_date = _d
                   AND r.status IN ('pending','approved')) THEN
        _code := 'already_requested';
      ELSE
        INSERT INTO public.day_off_requests
          (user_id, absence_date, kind, status, reason, requested_by, reviewed_by, reviewed_at)
        VALUES
          (_user_id, _d, _kind,
           CASE WHEN _as_record THEN 'approved' ELSE 'pending' END,
           NULLIF(btrim(COALESCE(_reason, '')), ''),
           auth.uid(),
           CASE WHEN _as_record THEN auth.uid() END,
           CASE WHEN _as_record THEN now() END)
        RETURNING id INTO _new_id;
        -- A recorded (auto-approved) sick day draws paid sick leave now.
        IF _as_record AND _kind = 'sick' THEN
          PERFORM public.apply_sick_usage(_new_id);
        END IF;
        _ok := _ok + 1;
        _results := _results || jsonb_build_object('date', _d, 'status', 'ok', 'id', _new_id);
        CONTINUE;
      END IF;
      _skipped := _skipped + 1;
      _results := _results || jsonb_build_object('date', _d, 'status', 'skipped', 'code', _code);
    EXCEPTION
      WHEN unique_violation THEN
        _skipped := _skipped + 1;
        _results := _results || jsonb_build_object('date', _d, 'status', 'skipped', 'code', 'already_requested');
      WHEN OTHERS THEN
        _skipped := _skipped + 1;
        _results := _results || jsonb_build_object('date', _d, 'status', 'error', 'code', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', _ok, 'skipped', _skipped, 'results', _results);
END $$;

CREATE OR REPLACE FUNCTION public.review_day_off(
  _id uuid, _approve boolean, _deny_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row record;
  _is_admin boolean := public.is_time_admin(auth.uid());
BEGIN
  SELECT user_id, status, kind INTO _row FROM public.day_off_requests WHERE id = _id;
  IF _row.user_id IS NULL THEN RAISE EXCEPTION 'request not found'; END IF;
  IF _row.status <> 'pending' THEN RAISE EXCEPTION 'only pending requests can be reviewed'; END IF;

  IF NOT _is_admin THEN
    IF NOT public.has_role(auth.uid(), 'captain') THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
    IF public.my_team_id(auth.uid()) IS NULL
       OR public.my_team_id(_row.user_id) IS DISTINCT FROM public.my_team_id(auth.uid()) THEN
      RAISE EXCEPTION 'captains review requests for their own team only';
    END IF;
    IF _row.user_id = auth.uid() THEN
      RAISE EXCEPTION 'you cannot review your own request — ask a manager';
    END IF;
  END IF;

  IF NOT _approve AND COALESCE(btrim(_deny_reason), '') = '' THEN
    RAISE EXCEPTION 'a note is required to deny — the worker reads it';
  END IF;

  UPDATE public.day_off_requests
  SET status = CASE WHEN _approve THEN 'approved' ELSE 'denied' END,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      deny_reason = CASE WHEN _approve THEN NULL ELSE btrim(_deny_reason) END
  WHERE id = _id;

  -- An approved sick request draws paid sick leave.
  IF _approve AND _row.kind = 'sick' THEN
    PERFORM public.apply_sick_usage(_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.cancel_day_off(_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row record;
  _is_admin boolean := public.is_time_admin(auth.uid());
  _today_la date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  _allowed boolean := false;
BEGIN
  SELECT user_id, status, absence_date, requested_by, kind, paid_hours INTO _row
  FROM public.day_off_requests WHERE id = _id;
  IF _row.user_id IS NULL THEN RAISE EXCEPTION 'request not found'; END IF;
  IF _row.status NOT IN ('pending','approved') THEN
    RAISE EXCEPTION 'only pending or approved rows can be cancelled';
  END IF;

  IF _is_admin OR _row.requested_by = auth.uid() THEN
    _allowed := true;
  ELSIF _row.user_id = auth.uid() THEN
    _allowed := (_row.status = 'pending' OR _row.absence_date >= _today_la);
  ELSIF public.has_role(auth.uid(), 'captain')
        AND public.my_team_id(auth.uid()) IS NOT NULL
        AND public.my_team_id(_row.user_id) = public.my_team_id(auth.uid()) THEN
    _allowed := true;
  END IF;
  IF NOT _allowed THEN RAISE EXCEPTION 'not authorized'; END IF;

  UPDATE public.day_off_requests
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  WHERE id = _id;

  -- Cancelling a PAID sick day returns the hours to the bank.
  IF _row.status = 'approved' AND _row.kind = 'sick'
     AND COALESCE(_row.paid_hours, 0) > 0 THEN
    INSERT INTO public.sick_leave_ledger
      (user_id, entry_date, kind, hours, absence_id, note, created_by)
    VALUES
      (_row.user_id, _row.absence_date, 'reversal', _row.paid_hours, _id,
       'sick day cancelled', auth.uid());
  END IF;
END $$;
