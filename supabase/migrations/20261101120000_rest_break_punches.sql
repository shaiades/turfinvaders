-- ═══════════════════════════════════════════════════════════════════════════
-- PUNCHED REST BREAKS (owner ask 2026-10-19: "we should build it to cover
-- ourselves").
--
-- The 10-minute rest breaks gain real punches — a timestamped record on top
-- of the phase-1 attestation, which stays as the backstop:
--
--   · rest_breaks: Start Break / End Break punches, one open break per
--     shift, modeled on meal_periods. Breaks are PAID, on-the-clock time —
--     they deduct NOTHING from billable hours (the whole point vs meals).
--   · compute v9 derives the day's duty: breaks owed = DLSE chart (3.5–6h
--     → 1, >6–10h → 2, >10–14h → 3 …  "one per 4 hours or major
--     fraction"); a punched break counts when it ran 10+ minutes (dangling
--     opens clamp to clock-out). When the day's punches meet the quota,
--     rest_break_status resolves to 'ok' BY RECORD — no attestation needed.
--     Short of the quota, the clock-out question still asks (unpunched
--     breaks are still legal breaks); a worker's explicit 'missed' always
--     wins over punch counts (records are rebuttable, never erasing a
--     worker's claim).
--   · crew_start_break / crew_end_break: the van breaks together, same
--     skip-and-report shape as the crew lunch RPCs.
--   · send_rest_reminders v2: the ~2h nudge skips a shift that already
--     punched (or is on) a break; the ~6h nudge skips shifts with two.
--   · timesheet_day_detail +rest_break_count/_minutes/break_windows — the
--     LC 1174-grade record now shows the actual break windows.
--
-- Replaces (full bodies):
--   compute_time_entry_hours  v8 → v9   (20261022120000 + hr-access guard)
--   send_rest_reminders       v1 → v2   (20261022120000)
--   timesheet_day_detail      +3 cols   (20261024120000)
-- Mirrors in the same PR: src/lib/pay.ts (restBreaksRequired), TimeClock,
-- VanClockConsole/useVanClock, TimesheetEditor, payroll-export, types.ts.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) The punches ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.rest_breaks (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  time_entry_id uuid NOT NULL REFERENCES public.time_entries(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  break_start timestamptz NOT NULL DEFAULT now(),
  break_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rest_breaks_entry_idx ON public.rest_breaks(time_entry_id);
CREATE UNIQUE INDEX IF NOT EXISTS rest_breaks_one_open_per_entry
  ON public.rest_breaks(time_entry_id) WHERE break_end IS NULL;

GRANT SELECT, INSERT, UPDATE ON public.rest_breaks TO authenticated;
GRANT ALL ON public.rest_breaks TO service_role;
ALTER TABLE public.rest_breaks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "breaks read own or staff" ON public.rest_breaks
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper')
         OR public.has_role(auth.uid(), 'hr'));
CREATE POLICY "breaks insert own" ON public.rest_breaks
  FOR INSERT TO authenticated WITH CHECK (true);  -- the guard trigger decides
CREATE POLICY "breaks update own" ON public.rest_breaks
  FOR UPDATE TO authenticated USING (true);       -- the guard trigger decides

-- Live van-clock pills.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.rest_breaks;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

-- ── 2) Guard: same doctrine as guard_meal_write v4 ───────────────────────────
-- Self punches are "now" on your own OPEN shift; reasoned time-admin /
-- own-team-captain writes pass (the crew RPCs, future manager fixes);
-- frozen weeks are locked.

CREATE OR REPLACE FUNCTION public.guard_rest_break_write()
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
    RETURN NEW; -- reasoned manager/captain fix (crew break RPCs)
  END IF;

  IF _entry.user_id IS NULL OR _entry.user_id <> auth.uid() OR NEW.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'not your shift';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF _entry.clock_out IS NOT NULL THEN
      RAISE EXCEPTION 'breaks can only start while clocked in';
    END IF;
    IF NEW.break_end IS NOT NULL OR abs(extract(epoch FROM (NEW.break_start - now()))) > 300 THEN
      RAISE EXCEPTION 'a break must start now — past breaks need a manager correction';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.break_end IS NOT NULL THEN
    RAISE EXCEPTION 'closed breaks are read-only — ask a manager for a correction';
  END IF;
  IF NEW.break_start IS DISTINCT FROM OLD.break_start
     OR NEW.time_entry_id IS DISTINCT FROM OLD.time_entry_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'only the break end time can be set';
  END IF;
  IF NEW.break_end IS NULL OR abs(extract(epoch FROM (NEW.break_end - now()))) > 300 THEN
    RAISE EXCEPTION 'break end must be now';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER rest_breaks_a_guard
  BEFORE INSERT OR UPDATE ON public.rest_breaks
  FOR EACH ROW EXECUTE FUNCTION public.guard_rest_break_write();

-- Audit every punch into the same append-only trail as meals.
CREATE OR REPLACE FUNCTION public.audit_rest_break()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.time_entry_audit (time_entry_id, actor, action, reason, old_row, new_row)
  VALUES (NEW.time_entry_id, auth.uid(),
          CASE WHEN TG_OP = 'INSERT' THEN 'break_insert' ELSE 'break_update' END,
          NULLIF(current_setting('app.edit_reason', true), ''),
          CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, to_jsonb(NEW));
  RETURN NEW;
END $$;

CREATE TRIGGER rest_breaks_zz_audit
  AFTER INSERT OR UPDATE ON public.rest_breaks
  FOR EACH ROW EXECUTE FUNCTION public.audit_rest_break();

-- A break punch closing after the shift's compute must re-derive the day's
-- rest status (same poke as meals).
CREATE TRIGGER rest_breaks_zz_recompute
  AFTER INSERT OR UPDATE ON public.rest_breaks
  FOR EACH ROW EXECUTE FUNCTION public.recompute_entry_from_meal();

-- ── 3) compute v9: punched breaks satisfy the day's rest duty ────────────────
-- Identical to v8 except the rest section (and the new helper counts).

CREATE OR REPLACE FUNCTION public.compute_time_entry_hours()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _raw_hours numeric;
  _meal_hours numeric := 0;
  _day_raw_hours numeric := 0;
  _has_compliant_meal boolean := false;
  _has_late_meal boolean := false;
  _local_hour int;
  _early_ok boolean := false;
  _second_meal_start timestamptz;
  _first_meal_deadline timestamptz;
  _second_meal_deadline timestamptz;
  _rem_first numeric := 5.0;
  _rem_second numeric := 10.0;
  _span numeric;
  _r record;
  -- Rest punches (day-pooled, like meals).
  _breaks_required int := 0;
  _breaks_punched int := 0;
BEGIN
  -- log_date is server truth: the LA calendar day of clock-in.
  IF TG_OP = 'INSERT' OR NEW.clock_in IS DISTINCT FROM OLD.clock_in THEN
    NEW.log_date := (NEW.clock_in AT TIME ZONE 'America/Los_Angeles')::date;
  END IF;

  IF NEW.voided_at IS NOT NULL THEN
    NEW.billable_hours := 0;
    RETURN NEW;
  END IF;

  -- Punch-time anomaly flags (INSERT): early start and Sunday work.
  IF TG_OP = 'INSERT' THEN
    _local_hour := EXTRACT(HOUR FROM (NEW.clock_in AT TIME ZONE 'America/Los_Angeles'))::int;
    IF _local_hour < 7 THEN
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

  -- Billable: span minus RECORDED MEALS only. Rest breaks are PAID time —
  -- they never deduct (LC 226.7; that is the entire difference from lunch).
  SELECT COALESCE(SUM(GREATEST(0,
           EXTRACT(EPOCH FROM (LEAST(mp.meal_end, NEW.clock_out)
                             - GREATEST(mp.meal_start, NEW.clock_in))) / 3600.0)), 0)
    INTO _meal_hours
  FROM public.meal_periods mp
  WHERE mp.time_entry_id = NEW.id AND mp.meal_end IS NOT NULL;

  NEW.billable_hours := ROUND(GREATEST(_raw_hours - _meal_hours, 0)::numeric, 2);

  -- The WORKDAY: total on-the-clock hours + the LC 512 meal deadlines.
  FOR _r IN
    SELECT s.clock_in, s.clock_out FROM (
      SELECT te.clock_in, te.clock_out
      FROM public.time_entries te
      WHERE te.user_id = NEW.user_id
        AND te.log_date = NEW.log_date
        AND te.id <> NEW.id
        AND te.clock_out IS NOT NULL
        AND te.voided_at IS NULL
      UNION ALL
      SELECT NEW.clock_in, NEW.clock_out
    ) s ORDER BY s.clock_in
  LOOP
    _span := EXTRACT(EPOCH FROM (_r.clock_out - _r.clock_in)) / 3600.0;
    IF _span < 0 THEN _span := 0; END IF;
    _day_raw_hours := _day_raw_hours + _span;
    IF _first_meal_deadline IS NULL THEN
      IF _span >= _rem_first THEN
        _first_meal_deadline := _r.clock_in + make_interval(secs => _rem_first * 3600.0);
      ELSE
        _rem_first := _rem_first - _span;
      END IF;
    END IF;
    IF _second_meal_deadline IS NULL THEN
      IF _span >= _rem_second THEN
        _second_meal_deadline := _r.clock_in + make_interval(secs => _rem_second * 3600.0);
      ELSE
        _rem_second := _rem_second - _span;
      END IF;
    END IF;
  END LOOP;

  -- Meals anywhere on the workday count toward its compliance.
  SELECT bool_or(mp.meal_end - mp.meal_start >= interval '30 minutes'
                 AND mp.meal_start <= _first_meal_deadline),
         bool_or(mp.meal_end - mp.meal_start >= interval '30 minutes'
                 AND mp.meal_start > _first_meal_deadline)
    INTO _has_compliant_meal, _has_late_meal
  FROM public.meal_periods mp
  WHERE mp.meal_end IS NOT NULL
    AND (mp.time_entry_id = NEW.id
         OR mp.time_entry_id IN (
           SELECT te.id FROM public.time_entries te
           WHERE te.user_id = NEW.user_id
             AND te.log_date = NEW.log_date
             AND te.id <> NEW.id
             AND te.voided_at IS NULL));

  -- First meal: owed once the DAY passes 5 worked hours.
  IF _day_raw_hours <= 5.0 THEN
    NEW.meal_status := CASE WHEN _meal_hours > 0 THEN 'taken' ELSE 'not_required' END;
  ELSIF COALESCE(_has_compliant_meal, false) THEN
    NEW.meal_status := 'taken';
  ELSIF COALESCE(_has_late_meal, false) THEN
    NEW.meal_status := 'taken_late';
  ELSIF NEW.meal_status NOT IN ('missed', 'unrecorded') THEN
    NEW.meal_status := 'pending';
  END IF;

  -- Second meal (LC 512): workday over 10 hours.
  IF _day_raw_hours <= 10.0 THEN
    NEW.second_meal_status := 'not_required';
  ELSE
    SELECT mp.meal_start INTO _second_meal_start
    FROM public.meal_periods mp
    WHERE mp.meal_end IS NOT NULL
      AND mp.meal_end - mp.meal_start >= interval '30 minutes'
      AND (mp.time_entry_id = NEW.id
           OR mp.time_entry_id IN (
             SELECT te.id FROM public.time_entries te
             WHERE te.user_id = NEW.user_id
               AND te.log_date = NEW.log_date
               AND te.id <> NEW.id
               AND te.voided_at IS NULL))
    ORDER BY mp.meal_start
    OFFSET 1 LIMIT 1;
    IF _second_meal_start IS NULL THEN
      NEW.second_meal_status := 'missed';
    ELSIF _second_meal_deadline IS NOT NULL
          AND _second_meal_start <= _second_meal_deadline THEN
      NEW.second_meal_status := 'taken';
    ELSE
      NEW.second_meal_status := 'taken_late';
    END IF;
  END IF;

  -- Rest breaks (Wage Order 4): one per 4 hours worked or major fraction —
  -- the DLSE chart: <3.5h → 0, 3.5–6h → 1, >6–10h → 2, >10–14h → 3, …
  IF _day_raw_hours >= 3.5 THEN
    _breaks_required := GREATEST(1,
      FLOOR(_day_raw_hours / 4)::int
      + CASE WHEN _day_raw_hours - FLOOR(_day_raw_hours / 4) * 4 > 2 THEN 1 ELSE 0 END);
  END IF;

  -- Punched breaks of 10+ minutes anywhere on the workday (a break left
  -- open clamps to this shift's clock-out — still paid time, still counts).
  SELECT COUNT(*) INTO _breaks_punched
  FROM public.rest_breaks rb
  WHERE COALESCE(rb.break_end, NEW.clock_out) - rb.break_start >= interval '10 minutes'
    AND (rb.time_entry_id = NEW.id
         OR rb.time_entry_id IN (
           SELECT te.id FROM public.time_entries te
           WHERE te.user_id = NEW.user_id
             AND te.log_date = NEW.log_date
             AND te.id <> NEW.id
             AND te.voided_at IS NULL));

  -- Status: a worker's explicit 'missed' always stands (the record is
  -- rebuttable — punches never erase a worker's claim); otherwise punches
  -- meeting the quota resolve the day BY RECORD; otherwise the clock-out /
  -- attest_shift answer ('ok') or 'pending' as before.
  IF _breaks_required = 0 THEN
    NEW.rest_break_status := 'not_required';
  ELSIF NEW.rest_break_status = 'missed' THEN
    NULL; -- keep
  ELSIF _breaks_punched >= _breaks_required THEN
    NEW.rest_break_status := 'ok';
  ELSIF NEW.rest_break_status <> 'ok' THEN
    NEW.rest_break_status := 'pending';
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
  IF NEW.second_meal_status IN ('missed', 'taken_late')
     AND NOT ('missed_second_meal' = ANY(NEW.flag_reasons)) THEN
    NEW.flag_reasons := array_append(NEW.flag_reasons, 'missed_second_meal');
    NEW.needs_correction := true;
  END IF;
  IF NEW.rest_break_status = 'missed'
     AND NOT ('missed_rest_break' = ANY(NEW.flag_reasons)) THEN
    NEW.flag_reasons := array_append(NEW.flag_reasons, 'missed_rest_break');
    NEW.needs_correction := true;
  END IF;

  RETURN NEW;
END $$;

-- ── 4) Crew bulk breaks: the van takes its 10 together ──────────────────────

CREATE OR REPLACE FUNCTION public.crew_start_break(_user_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _is_admin boolean := public.is_time_admin(auth.uid());
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
  PERFORM set_config('app.edit_reason', 'crew break start (live bulk punch)', true);
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
        ELSIF EXISTS (SELECT 1 FROM public.rest_breaks rb
                      WHERE rb.time_entry_id = _open_id AND rb.break_end IS NULL) THEN
          _code := 'already_on_break';
        ELSE
          INSERT INTO public.rest_breaks (time_entry_id, user_id, break_start)
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
        _skipped := _skipped + 1;
        _results := _results || jsonb_build_object('user_id', _uid, 'status', 'skipped', 'code', 'already_on_break');
      WHEN OTHERS THEN
        _skipped := _skipped + 1;
        _results := _results || jsonb_build_object('user_id', _uid, 'status', 'error', 'code', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('ok', _ok, 'skipped', _skipped, 'results', _results);
END $$;

CREATE OR REPLACE FUNCTION public.crew_end_break(_user_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _is_admin boolean := public.is_time_admin(auth.uid());
  _my_team uuid := public.my_team_id(auth.uid());
  _uid uuid;
  _break_id uuid;
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
  PERFORM set_config('app.edit_reason', 'crew break end (live bulk punch)', true);
  FOR _uid IN SELECT DISTINCT u FROM unnest(_user_ids) u LOOP
    BEGIN
      _code := NULL; _break_id := NULL;
      IF NOT _is_admin AND public.my_team_id(_uid) IS DISTINCT FROM _my_team THEN
        _code := 'not_your_team';
      ELSE
        SELECT rb.id INTO _break_id
        FROM public.rest_breaks rb
        JOIN public.time_entries te ON te.id = rb.time_entry_id
        WHERE te.user_id = _uid AND te.clock_out IS NULL AND te.voided_at IS NULL
          AND rb.break_end IS NULL
        LIMIT 1;
        IF _break_id IS NULL THEN
          _code := 'not_on_break';
        ELSE
          UPDATE public.rest_breaks SET break_end = now() WHERE id = _break_id;
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

REVOKE ALL ON FUNCTION public.crew_start_break(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crew_end_break(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crew_start_break(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_end_break(uuid[]) TO authenticated;

-- Crew clock-out must end an open BREAK too (same as it ends an open lunch)
-- — but that lives in crew_clock_out, whose body is otherwise unchanged; a
-- dangling open break is harmless anyway (compute clamps it to clock-out,
-- and it deducts nothing). Self clock-outs end the break in the app first.

-- ── 5) send_rest_reminders v2: don't nag a shift that already punched ────────

CREATE OR REPLACE FUNCTION public.send_rest_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _rec RECORD;
  _secret text;
  _sent int := 0;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'send_rest_reminders runs from cron/service contexts only';
  END IF;

  SELECT decrypted_secret INTO _secret
  FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
  IF _secret IS NULL OR _secret = '' THEN RETURN 0; END IF;

  FOR _rec IN
    SELECT te.id, te.user_id, s.stage,
           FLOOR(EXTRACT(EPOCH FROM (now() - te.clock_in)) / 60)::int AS worked_minutes
    FROM public.time_entries te
    CROSS JOIN (VALUES (1), (2)) AS s(stage)
    WHERE te.clock_out IS NULL
      AND te.voided_at IS NULL
      AND ((s.stage = 1 AND now() - te.clock_in >= interval '2 hours'
                       AND now() - te.clock_in <  interval '3 hours')
        OR (s.stage = 2 AND now() - te.clock_in >= interval '6 hours'
                       AND now() - te.clock_in <  interval '7 hours'))
      AND NOT EXISTS (
        SELECT 1 FROM public.meal_periods mp
        WHERE mp.time_entry_id = te.id AND mp.meal_end IS NULL)
      -- Already punching breaks: the nudge has done its job. Stage 1 skips
      -- a shift with any break (open ones included); stage 2 skips two.
      AND (
        SELECT COUNT(*) FROM public.rest_breaks rb
        WHERE rb.time_entry_id = te.id
          AND (rb.break_end IS NULL OR rb.break_end - rb.break_start >= interval '10 minutes')
      ) < s.stage
      AND NOT EXISTS (
        SELECT 1 FROM public.rest_reminder_sent r
        WHERE r.time_entry_id = te.id AND r.stage = s.stage)
  LOOP
    BEGIN
      INSERT INTO public.rest_reminder_sent (time_entry_id, stage)
      VALUES (_rec.id, _rec.stage);
      PERFORM net.http_post(
        url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/notify-rest-reminder',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-notify-secret', _secret
        ),
        body := jsonb_build_object(
          'time_entry_id', _rec.id,
          'user_id', _rec.user_id,
          'stage', _rec.stage,
          'worked_minutes', _rec.worked_minutes
        )
      );
      _sent := _sent + 1;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
  RETURN _sent;
END $$;

-- ── 6) timesheet_day_detail: the record shows the actual break windows ───────

CREATE OR REPLACE VIEW public.timesheet_day_detail
WITH (security_invoker = on) AS
SELECT te.id,
       te.user_id,
       p.display_name,
       t.name AS team_name,
       te.log_date,
       te.clock_in,
       te.clock_out,
       te.billable_hours,
       te.meal_status,
       te.second_meal_status,
       te.entry_source,
       te.flag_reasons,
       te.needs_correction,
       te.reviewed_by,
       te.reviewed_at,
       te.voided_at,
       te.void_reason,
       m.meal_count,
       m.meal_minutes,
       m.first_meal_start,
       m.last_meal_end,
       te.rest_break_status,
       m.meal_windows,
       b.rest_break_count,
       b.rest_break_minutes,
       b.break_windows
FROM public.time_entries te
LEFT JOIN public.profiles p ON p.id = te.user_id
LEFT JOIN public.teams t ON t.id = p.team_id
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS meal_count,
         ROUND(SUM(EXTRACT(EPOCH FROM (mp.meal_end - mp.meal_start)) / 60.0)) AS meal_minutes,
         MIN(mp.meal_start) AS first_meal_start,
         MAX(mp.meal_end)  AS last_meal_end,
         string_agg(
           to_char(mp.meal_start AT TIME ZONE 'America/Los_Angeles', 'HH24:MI')
             || '–'
             || to_char(mp.meal_end AT TIME ZONE 'America/Los_Angeles', 'HH24:MI'),
           '; ' ORDER BY mp.meal_start) AS meal_windows
  FROM public.meal_periods mp
  WHERE mp.time_entry_id = te.id AND mp.meal_end IS NOT NULL
    AND mp.meal_end > mp.meal_start
) m ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS rest_break_count,
         ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(rb.break_end, te.clock_out) - rb.break_start)) / 60.0))
           AS rest_break_minutes,
         string_agg(
           to_char(rb.break_start AT TIME ZONE 'America/Los_Angeles', 'HH24:MI')
             || '–'
             || COALESCE(to_char(rb.break_end AT TIME ZONE 'America/Los_Angeles', 'HH24:MI'), '…'),
           '; ' ORDER BY rb.break_start) AS break_windows
  FROM public.rest_breaks rb
  WHERE rb.time_entry_id = te.id
    AND COALESCE(rb.break_end, te.clock_out, now()) > rb.break_start
) b ON true;

GRANT SELECT ON public.timesheet_day_detail TO authenticated;
