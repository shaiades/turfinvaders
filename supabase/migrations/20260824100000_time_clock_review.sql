-- ═══════════════════════════════════════════════════════════════════════════
-- TIME CLOCK REVIEW LAYER (owner directive 2026-08-24): managers and
-- captains get notified of anything that doesn't look right — early
-- clock-ins, Sunday work, very long shifts, missed/unrecorded lunches,
-- auto-closed shifts — and approve or fix each one before payroll freezes.
--
--   1) time_entries grows flag_reasons[] + reviewed_by/reviewed_at. The
--      compute trigger stamps flags as punches happen; any flag raises
--      needs_correction, which the P0 engine already surfaces in paycheck
--      exceptions and which already BLOCKS payroll-run approval.
--   2) approve_time_entry(_id): owners/Managers approve anything; captains
--      approve entries for their own team but never their own. Approval
--      stamps reviewed_by/at, clears needs_correction, audits as 'approve'.
--      Fixing the entry instead (admin_update_time_entry / admin_set_meal /
--      void_time_entry) also resolves it — a human touched it either way.
--   3) time_entries joins the realtime publication so the review queue on
--      the captain/manager dashboards updates live ("notification" today is
--      the in-app queue; push/email can ride on these flags later).
--
-- Thresholds (owner-adjustable, live here only):
--   · early clock-in: before 07:00 America/Los_Angeles
--   · very long shift: raw span over 12 hours (double-time territory)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) Columns ──────────────────────────────────────────────────────────────

ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS flag_reasons text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

-- ── 2) compute v4: stamp anomaly flags as punches happen ────────────────────

CREATE OR REPLACE FUNCTION public.compute_time_entry_hours()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _raw_hours numeric;
  _meal_hours numeric := 0;
  _has_compliant_meal boolean := false;
  _has_late_meal boolean := false;
  _local_hour int;
BEGIN
  IF NEW.voided_at IS NOT NULL THEN
    NEW.billable_hours := 0;
    RETURN NEW;
  END IF;

  -- Punch-time anomaly flags (INSERT): early start and Sunday work. Flags
  -- accumulate in flag_reasons and raise needs_correction until a captain/
  -- manager approves or fixes the entry.
  IF TG_OP = 'INSERT' THEN
    _local_hour := EXTRACT(HOUR FROM (NEW.clock_in AT TIME ZONE 'America/Los_Angeles'))::int;
    IF _local_hour < 7 AND NOT ('early_clock_in' = ANY(NEW.flag_reasons)) THEN
      NEW.flag_reasons := NEW.flag_reasons || 'early_clock_in';
      NEW.needs_correction := true;
    END IF;
    IF EXTRACT(ISODOW FROM NEW.log_date)::int = 7
       AND NOT ('sunday_shift' = ANY(NEW.flag_reasons)) THEN
      NEW.flag_reasons := NEW.flag_reasons || 'sunday_shift';
      NEW.needs_correction := true;
    END IF;
  END IF;

  IF NEW.clock_out IS NULL THEN
    NEW.billable_hours := 0;
    RETURN NEW;
  END IF;

  _raw_hours := EXTRACT(EPOCH FROM (NEW.clock_out - NEW.clock_in)) / 3600.0;
  IF _raw_hours < 0 THEN _raw_hours := 0; END IF;

  SELECT COALESCE(SUM(GREATEST(0,
           EXTRACT(EPOCH FROM (LEAST(mp.meal_end, NEW.clock_out)
                             - GREATEST(mp.meal_start, NEW.clock_in))) / 3600.0)), 0),
         bool_or(mp.meal_end - mp.meal_start >= interval '30 minutes'
                 AND mp.meal_start <= NEW.clock_in + interval '5 hours'),
         bool_or(mp.meal_end - mp.meal_start >= interval '30 minutes'
                 AND mp.meal_start > NEW.clock_in + interval '5 hours')
    INTO _meal_hours, _has_compliant_meal, _has_late_meal
  FROM public.meal_periods mp
  WHERE mp.time_entry_id = NEW.id AND mp.meal_end IS NOT NULL;

  NEW.billable_hours := ROUND(GREATEST(_raw_hours - _meal_hours, 0)::numeric, 2);

  IF _raw_hours <= 5.0 THEN
    NEW.meal_status := CASE WHEN _meal_hours > 0 THEN 'taken' ELSE 'not_required' END;
  ELSIF COALESCE(_has_compliant_meal, false) THEN
    NEW.meal_status := 'taken';
  ELSIF COALESCE(_has_late_meal, false) THEN
    NEW.meal_status := 'taken_late';
  ELSIF NEW.meal_status NOT IN ('missed', 'unrecorded') THEN
    NEW.meal_status := 'pending';
  END IF;

  -- Close-time anomaly flags: double-time-length shifts and meal problems.
  -- (A resolved meal clears the chip via meal_status; the flag stays as the
  -- history of why the entry once needed eyes.)
  IF _raw_hours > 12 AND NOT ('very_long_shift' = ANY(NEW.flag_reasons)) THEN
    NEW.flag_reasons := NEW.flag_reasons || 'very_long_shift';
    NEW.needs_correction := true;
  END IF;
  IF NEW.meal_status IN ('missed', 'taken_late')
     AND NOT ('missed_meal' = ANY(NEW.flag_reasons)) THEN
    NEW.flag_reasons := NEW.flag_reasons || 'missed_meal';
    NEW.needs_correction := true;
  END IF;
  IF NEW.meal_status = 'unrecorded'
     AND NOT ('unrecorded_lunch' = ANY(NEW.flag_reasons)) THEN
    NEW.flag_reasons := NEW.flag_reasons || 'unrecorded_lunch';
    NEW.needs_correction := true;
  END IF;

  RETURN NEW;
END $$;

-- ── 3) Guard: allow the approval write shape through for the RPC ────────────
-- Captains aren't privileged in the guard, but approve_time_entry authorizes
-- them and stamps a reason; a reasoned write that ONLY sets the review stamp
-- (times untouched) passes. set_config is reachable only through our RPCs,
-- so a reason's presence proves the write came through an authorized path.

CREATE OR REPLACE FUNCTION public.guard_time_entry_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _privileged boolean;
  _reason text := NULLIF(current_setting('app.edit_reason', true), '');
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  _privileged := public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff');

  IF TG_OP = 'INSERT' THEN
    IF _privileged AND _reason IS NOT NULL THEN
      NEW.entry_source := 'manager_created';
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

  IF _privileged THEN
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

-- ── 4) The approve RPC ──────────────────────────────────────────────────────

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
    IF public.my_team_id(_row.user_id) IS DISTINCT FROM public.my_team_id(auth.uid()) THEN
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

REVOKE ALL ON FUNCTION public.approve_time_entry(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_time_entry(uuid) TO authenticated;

-- Fixing an entry resolves its review too: admin_set_meal now clears
-- needs_correction the way admin_update_time_entry already does.
CREATE OR REPLACE FUNCTION public.admin_set_meal(
  _time_entry_id uuid, _meal_start timestamptz, _meal_end timestamptz, _reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _uid uuid; _first uuid;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'a reason is required to edit meal records';
  END IF;
  IF _meal_end <= _meal_start THEN
    RAISE EXCEPTION 'meal end must be after meal start';
  END IF;
  SELECT user_id INTO _uid FROM public.time_entries WHERE id = _time_entry_id;
  IF _uid IS NULL THEN RAISE EXCEPTION 'time entry not found'; END IF;
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
  UPDATE public.time_entries
  SET needs_correction = false,
      reviewed_by = auth.uid(),
      reviewed_at = now()
  WHERE id = _time_entry_id;
END $$;

-- ── 5) Audit: approvals get their own action ────────────────────────────────

CREATE OR REPLACE FUNCTION public.audit_time_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _action text;
  _reason text := NULLIF(current_setting('app.edit_reason', true), '');
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.clock_in IS NOT DISTINCT FROM OLD.clock_in
     AND NEW.clock_out IS NOT DISTINCT FROM OLD.clock_out
     AND NEW.log_date IS NOT DISTINCT FROM OLD.log_date
     AND NEW.billable_hours IS NOT DISTINCT FROM OLD.billable_hours
     AND NEW.meal_status IS NOT DISTINCT FROM OLD.meal_status
     AND NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at
     AND NEW.entry_source IS NOT DISTINCT FROM OLD.entry_source
     AND NEW.needs_correction IS NOT DISTINCT FROM OLD.needs_correction
     AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    _action := 'insert';
  ELSIF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    _action := 'void';
  ELSIF NEW.reviewed_at IS NOT NULL AND OLD.reviewed_at IS DISTINCT FROM NEW.reviewed_at
        AND NEW.clock_in IS NOT DISTINCT FROM OLD.clock_in
        AND NEW.clock_out IS NOT DISTINCT FROM OLD.clock_out THEN
    _action := 'approve';
  ELSIF NEW.entry_source = 'auto_closed' AND OLD.clock_out IS NULL AND auth.uid() IS NULL THEN
    _action := 'auto_close';
  ELSIF OLD.clock_out IS NULL AND NEW.clock_out IS NOT NULL AND auth.uid() = NEW.user_id THEN
    _action := 'punch_out';
  ELSE
    _action := 'update';
  END IF;

  INSERT INTO public.time_entry_audit (time_entry_id, actor, action, reason, old_row, new_row)
  VALUES (NEW.id, auth.uid(), _action, _reason,
          CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, to_jsonb(NEW));
  RETURN NEW;
END $$;

-- ── 6) Realtime: the review queue updates live ──────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'time_entries'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.time_entries;
  END IF;
END $$;
