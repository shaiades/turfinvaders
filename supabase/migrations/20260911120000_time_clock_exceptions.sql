-- ═══════════════════════════════════════════════════════════════════════════
-- TIME CLOCK EARLY/LATE PASSES (owner request 2026-09-11): Owners and
-- Managers can pre-approve a specific person to clock in early or work
-- past the auto-close cutoff on a specific day.
--
-- Context: editing/backfilling everyone's punches has been owner+Manager
-- (office_staff) since the P0 RPCs — this migration adds the missing
-- PRE-approval piece, so a known early start or late finish never lands in
-- the review queue or gets a fabricated auto-close end time:
--
--   1) time_clock_exceptions: one active pass per person per LA calendar
--      day. early_from = earliest permitted clock-in (LA wall time);
--      late_until = latest the shift may run before auto-close (LA wall
--      time). Either may be NULL; at least one is required. Passes are
--      revoked, never deleted — the row IS the audit record (who granted,
--      why, who revoked).
--   2) grant/revoke RPCs, owner+office_staff only, reason required.
--      Granting over an existing active pass revokes it first (history
--      kept). Writes go ONLY through the RPCs — no table write policies.
--   3) compute v6: a covered early clock-in (pass exists and the punch is
--      at/after early_from) raises NO early_clock_in flag. An earlier-
--      than-permitted punch still flags.
--   4) auto-close v3: a pass's late_until extends that person's cutoff for
--      that day (GREATEST of default and pass — a pass can never SHORTEN
--      the window). The evening-shift midnight rule keeps working against
--      the extended cutoff.
--
-- Sunday shifts still flag (a pass is about hours, not the unscheduled-day
-- exception), and very_long_shift (>12h raw) still flags — double-time
-- territory always deserves eyes.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) The passes table ─────────────────────────────────────────────────────

CREATE TABLE public.time_clock_exceptions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  exception_date date NOT NULL,      -- the LA calendar day the pass covers
  early_from time,                   -- earliest permitted clock-in, LA wall time
  late_until time,                   -- latest permitted shift end before auto-close, LA wall time
  reason text NOT NULL,
  granted_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  CONSTRAINT time_clock_exceptions_some_grant_chk
    CHECK (early_from IS NOT NULL OR late_until IS NOT NULL)
);

CREATE INDEX time_clock_exceptions_user_date_idx
  ON public.time_clock_exceptions(user_id, exception_date);
CREATE UNIQUE INDEX time_clock_exceptions_one_active
  ON public.time_clock_exceptions(user_id, exception_date) WHERE revoked_at IS NULL;

-- Reads: the worker sees their own passes (the clock screen tells them
-- their early start is pre-approved); staff and captains see all. Writes:
-- none for authenticated — the reasoned RPCs below are the only path.
GRANT SELECT ON public.time_clock_exceptions TO authenticated;
GRANT ALL ON public.time_clock_exceptions TO service_role;
ALTER TABLE public.time_clock_exceptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "passes read own or staff" ON public.time_clock_exceptions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain'));

-- ── 2) Grant / revoke RPCs ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.grant_time_clock_exception(
  _user_id uuid, _date date, _early_from time, _late_until time, _reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _new_id uuid;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')) THEN
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
  IF NOT (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  UPDATE public.time_clock_exceptions
  SET revoked_at = now(), revoked_by = auth.uid()
  WHERE id = _id AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'pass not found (or already revoked)'; END IF;
END $$;

REVOKE ALL ON FUNCTION public.grant_time_clock_exception(uuid, date, time, time, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_time_clock_exception(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grant_time_clock_exception(uuid, date, time, time, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_time_clock_exception(uuid) TO authenticated;

-- ── 3) compute v6: a covered early clock-in doesn't flag ────────────────────

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
  _early_ok boolean := false;
BEGIN
  IF NEW.voided_at IS NOT NULL THEN
    NEW.billable_hours := 0;
    RETURN NEW;
  END IF;

  -- Punch-time anomaly flags (INSERT): early start and Sunday work.
  IF TG_OP = 'INSERT' THEN
    _local_hour := EXTRACT(HOUR FROM (NEW.clock_in AT TIME ZONE 'America/Los_Angeles'))::int;
    IF _local_hour < 7 THEN
      -- Pre-approved early start (owner/Manager pass): no flag when the
      -- punch is at or after the permitted time. Earlier than permitted
      -- still flags.
      SELECT EXISTS (
        SELECT 1 FROM public.time_clock_exceptions e
        WHERE e.user_id = NEW.user_id
          AND e.exception_date = (NEW.clock_in AT TIME ZONE 'America/Los_Angeles')::date
          AND e.revoked_at IS NULL
          AND e.early_from IS NOT NULL
          AND (NEW.clock_in AT TIME ZONE 'America/Los_Angeles')::time >= e.early_from
      ) INTO _early_ok;
      IF NOT _early_ok AND NOT ('early_clock_in' = ANY(NEW.flag_reasons)) THEN
        NEW.flag_reasons := array_append(NEW.flag_reasons, 'early_clock_in');
        NEW.needs_correction := true;
      END IF;
    END IF;
    IF EXTRACT(ISODOW FROM NEW.log_date)::int = 7
       AND NOT ('sunday_shift' = ANY(NEW.flag_reasons)) THEN
      NEW.flag_reasons := array_append(NEW.flag_reasons, 'sunday_shift');
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

  -- Close-time anomaly flags.
  IF _raw_hours > 12 AND NOT ('very_long_shift' = ANY(NEW.flag_reasons)) THEN
    NEW.flag_reasons := array_append(NEW.flag_reasons, 'very_long_shift');
    NEW.needs_correction := true;
  END IF;
  IF NEW.meal_status IN ('missed', 'taken_late')
     AND NOT ('missed_meal' = ANY(NEW.flag_reasons)) THEN
    NEW.flag_reasons := array_append(NEW.flag_reasons, 'missed_meal');
    NEW.needs_correction := true;
  END IF;
  IF NEW.meal_status = 'unrecorded'
     AND NOT ('unrecorded_lunch' = ANY(NEW.flag_reasons)) THEN
    NEW.flag_reasons := array_append(NEW.flag_reasons, 'unrecorded_lunch');
    NEW.needs_correction := true;
  END IF;

  RETURN NEW;
END $$;

-- ── 4) Backfill entries arrive pre-reviewed ─────────────────────────────────
-- A reasoned manager creation IS the human review: the same hand that typed
-- the times just vouched for them, so the anomaly flags the compute trigger
-- stamps on INSERT (early / Sunday / very long) must not bounce the entry
-- into the review queue. flag_reasons stays as history — only the
-- needs_correction gate clears, exactly like admin_update_time_entry.

CREATE OR REPLACE FUNCTION public.admin_create_time_entry(
  _user_id uuid, _clock_in timestamptz, _clock_out timestamptz, _reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _new_id uuid;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'a reason is required to create a time record';
  END IF;
  IF _clock_out IS NOT NULL AND _clock_out <= _clock_in THEN
    RAISE EXCEPTION 'clock-out must be after clock-in';
  END IF;
  PERFORM set_config('app.edit_reason', _reason, true);
  INSERT INTO public.time_entries (user_id, clock_in, clock_out, log_date, entry_source)
  VALUES (_user_id, _clock_in, _clock_out,
          (_clock_in AT TIME ZONE 'America/Los_Angeles')::date, 'manager_created')
  RETURNING id INTO _new_id;
  UPDATE public.time_entries
  SET needs_correction = false,
      reviewed_by = auth.uid(),
      reviewed_at = now()
  WHERE id = _new_id AND needs_correction;
  RETURN _new_id;
END $$;

-- ── 5) Auto-close v3: a late pass extends that person's cutoff ──────────────

CREATE OR REPLACE FUNCTION public.auto_clock_out_expired()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _rec RECORD;
  _local_date date;
  _dow int;
  _cutoff_local timestamp;
  _late_until time;
  _close_at_utc timestamptz;
  _now_local timestamp := (now() AT TIME ZONE 'America/Los_Angeles');
  _affected int := 0;
BEGIN
  FOR _rec IN
    SELECT id, user_id, clock_in FROM public.time_entries
    WHERE clock_out IS NULL AND voided_at IS NULL
  LOOP
    _local_date := (_rec.clock_in AT TIME ZONE 'America/Los_Angeles')::date;
    _dow := EXTRACT(ISODOW FROM _local_date)::int;

    IF _dow BETWEEN 1 AND 5 THEN _cutoff_local := _local_date + time '18:00';
    ELSIF _dow = 6 THEN            _cutoff_local := _local_date + time '17:00';
    ELSE                           _cutoff_local := _local_date + time '18:00';
    END IF;

    -- Late pass: extend (never shorten) this person's cutoff for the day.
    SELECT e.late_until INTO _late_until
    FROM public.time_clock_exceptions e
    WHERE e.user_id = _rec.user_id
      AND e.exception_date = _local_date
      AND e.revoked_at IS NULL
      AND e.late_until IS NOT NULL;
    IF _late_until IS NOT NULL THEN
      _cutoff_local := GREATEST(_cutoff_local, _local_date + _late_until);
    END IF;

    IF (_rec.clock_in AT TIME ZONE 'America/Los_Angeles') >= _cutoff_local THEN
      -- Evening shift: close at LA midnight of the clock-in day, never at
      -- its own start (the old zero-hour bug wiped evening work).
      _cutoff_local := _local_date + interval '1 day';
    END IF;

    IF _now_local >= _cutoff_local THEN
      _close_at_utc := _cutoff_local AT TIME ZONE 'America/Los_Angeles';
      UPDATE public.time_entries
      SET clock_out = GREATEST(_close_at_utc, clock_in),
          entry_source = 'auto_closed',
          needs_correction = true
      WHERE id = _rec.id;
      _affected := _affected + 1;
    END IF;
  END LOOP;
  RETURN _affected;
END $$;
