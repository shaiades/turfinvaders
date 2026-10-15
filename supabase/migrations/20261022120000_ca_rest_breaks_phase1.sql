-- ═══════════════════════════════════════════════════════════════════════════
-- CA COMPLIANCE PHASE 1 — REST BREAKS + ATTESTATION DEAD-ENDS
-- (owner ask 2026-10-14: "2 ten minute breaks and 30 minute lunch").
--
-- 1) REST BREAKS (IWC Wage Order 4 / LC 226.7): workers are owed a PAID
--    10-minute rest break per 4 hours worked or major fraction (≥3.5h day).
--    Rest breaks are paid, on-the-clock time the law does NOT require us to
--    record, so there is no rest punch — recording is by WORKER ATTESTATION
--    at clock-out ("got my breaks" / "missed one"), the same doctrine as the
--    meal attestation. A missed rest break pays ONE premium hour per day at
--    the regular rate — separate from and additive to the meal premium (a
--    day can owe both, LC 226.7; one of each at most, Donohue).
--      · time_entries.rest_break_status: pending | ok | missed |
--        not_required (<3.5h day). Premium on 'missed' only; 'pending'
--        surfaces as a run-review chip but never blocks approval (unlike
--        meal 'pending' — meals are recorded punches we can resolve to
--        times; rest has no times to enter).
--      · Reminder nudges to the WORKER at ~2h and ~6h on the clock
--        (rest_reminder_sent + cron → notify-rest-reminder edge fn).
--
-- 2) ATTESTATION DEAD-ENDS closed. Shifts the worker didn't close
--    themselves (crew bulk punch, auto-close, manager-created) could never
--    be attested: meal_status sat 'pending', payroll approval was blocked,
--    and the only way out was inventing meal times.
--      · attest_shift(_entry_id, _meal, _rest): the WORKER resolves a
--        recent closed shift's pending meal ('missed'/'unrecorded') and
--        pending rest ('ok'/'missed') after the fact — Mission shows the
--        card next time they open the app.
--      · admin_set_shift_status(_entry_id, _meal, _rest, _reason): the
--        manager/captain resolution for the same states, reasoned+audited
--        (admin_set_meal remains the path when the real TIMES are known).
--
-- 3) log_date IS SERVER TRUTH. Self clock-ins sent log_date from the
--    client; nothing checked it, and it drives the Sunday flag, the daily
--    OT buckets, and the payroll week. Both guards and compute now derive
--    it from clock_in (LA calendar day) on every insert, and compute
--    re-derives whenever clock_in changes.
--
-- 4) MEAL TIMING IS NOW PER WORKDAY, not per shift (the per-shift
--    approximation was a documented gap in p0). All of a person's shifts on
--    one log_date pool together: a split day of 4h + 4h now owes a meal.
--    Deadlines walk cumulative on-the-clock time across the day's shifts
--    (raw spans — the conservative basis v7 already used). The day's
--    verdict rides the entry whose close crossed the threshold; the adjust
--    RPCs re-poke the whole day so edits reprice every sibling.
--
-- Replaces (full bodies, triggers unchanged):
--   compute_time_entry_hours  v7 → v8   (20261002150000)
--   guard_time_entry_write    v6 → v7   (20261002150000)
--   audit_time_entry          v3 → v4   (20261002150000)
--   admin_update_time_entry   v2 → v3   (20261002120000)
--   void_time_entry           v2 → v3   (20261002120000)
--   admin_set_meal            v3 → v4   (20261002120000)
--   admin_create_time_entry   v3 → v4   (20261002120000)
--   calc_weekly_paycheck      v8 → v9   (20261002150000; DROP — new columns)
--   create_payroll_run        v4 → v5   (20261002140000)
--   timesheet_day_detail      +rest_break_status (20261002170000)
-- Mirrors to keep in step: src/lib/pay.ts, src/lib/fleet.functions.ts
-- (PaycheckRow), src/integrations/supabase/types.ts.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) Columns and tables ───────────────────────────────────────────────────

-- Pre-feature history lands as 'not_required' (no claim either way — past
-- weeks are an owner/accountant true-up decision, same doctrine as the
-- second-meal migration); rows created from here default 'pending' until
-- the close recomputes them.
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS rest_break_status text NOT NULL DEFAULT 'not_required';
ALTER TABLE public.time_entries
  ALTER COLUMN rest_break_status SET DEFAULT 'pending';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.time_entries'::regclass
                   AND conname = 'time_entries_rest_break_status_chk') THEN
    ALTER TABLE public.time_entries ADD CONSTRAINT time_entries_rest_break_status_chk
      CHECK (rest_break_status IN ('pending','ok','missed','not_required'));
  END IF;
END $$;

ALTER TABLE public.payroll_run_lines
  ADD COLUMN IF NOT EXISTS rest_premium_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rest_premium_pay numeric NOT NULL DEFAULT 0;

-- Service-only bookkeeping for the reminder nudges (one per shift+stage).
CREATE TABLE IF NOT EXISTS public.rest_reminder_sent (
  time_entry_id uuid NOT NULL
    REFERENCES public.time_entries(id) ON DELETE CASCADE,
  stage smallint NOT NULL CHECK (stage IN (1, 2)),
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (time_entry_id, stage)
);
ALTER TABLE public.rest_reminder_sent ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.rest_reminder_sent TO service_role;

-- ── 2) compute v8: server log_date, per-WORKDAY meals, rest status ──────────

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
  -- Cumulative-work meal deadlines across the whole LA workday.
  _first_meal_deadline timestamptz;
  _second_meal_deadline timestamptz;
  _rem_first numeric := 5.0;
  _rem_second numeric := 10.0;
  _span numeric;
  _r record;
BEGIN
  -- log_date is server truth: the LA calendar day of clock-in, never a
  -- client-sent value (it drives the Sunday flag, daily OT buckets, and the
  -- payroll week). Re-derived whenever clock_in changes.
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

  -- Billable deduction stays per entry: this shift's span minus ITS
  -- recorded meals, clamped to the shift.
  SELECT COALESCE(SUM(GREATEST(0,
           EXTRACT(EPOCH FROM (LEAST(mp.meal_end, NEW.clock_out)
                             - GREATEST(mp.meal_start, NEW.clock_in))) / 3600.0)), 0)
    INTO _meal_hours
  FROM public.meal_periods mp
  WHERE mp.time_entry_id = NEW.id AND mp.meal_end IS NOT NULL;

  NEW.billable_hours := ROUND(GREATEST(_raw_hours - _meal_hours, 0)::numeric, 2);

  -- ── The WORKDAY (all closed, non-voided shifts on this log_date, this
  --    one included): total on-the-clock hours and the LC 512 deadlines.
  --    Deadlines accumulate raw spans in clock-in order — "before the end
  --    of the 5th/10th hour of work", on the same conservative raw-span
  --    basis v7 used (a deadline too early can only over-protect).
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

  -- Meals anywhere on the workday count toward its compliance. On INSERT
  -- this row isn't in the table yet (and can have no meals); the explicit
  -- NEW.id arm covers UPDATEs.
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

  -- First meal: owed once the DAY passes 5 worked hours. The day's verdict
  -- rides the entry whose close crossed the line (earlier short siblings
  -- keep their statuses; the premium counts per day, so one carrier is
  -- enough — the adjust RPCs re-poke the day after every edit).
  IF _day_raw_hours <= 5.0 THEN
    NEW.meal_status := CASE WHEN _meal_hours > 0 THEN 'taken' ELSE 'not_required' END;
  ELSIF COALESCE(_has_compliant_meal, false) THEN
    NEW.meal_status := 'taken';
  ELSIF COALESCE(_has_late_meal, false) THEN
    NEW.meal_status := 'taken_late';
  ELSIF NEW.meal_status NOT IN ('missed', 'unrecorded') THEN
    NEW.meal_status := 'pending';
  END IF;

  -- Second meal (LC 512): a workday over 10 hours owes a SECOND 30+ minute
  -- meal starting before the end of the 10th hour of work. The
  -- second-earliest 30-minute meal of the DAY decides; 'missed' pays the
  -- premium and flags for review.
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

  -- Rest breaks (Wage Order 4): owed from 3.5 worked hours in the day.
  -- There are no rest punches — the worker attests at clock-out (or later
  -- via attest_shift); a manager resolves stragglers. 'missed' pays the
  -- day's rest premium; 'pending' is a review chip, never a premium.
  IF _day_raw_hours < 3.5 THEN
    NEW.rest_break_status := 'not_required';
  ELSIF NEW.rest_break_status NOT IN ('ok', 'missed') THEN
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

-- ── 3) guard v7: server log_date on insert, rest joins the pure-touch and
--       punch-out rules, and the worker's post-hoc attestation pass ──────────

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

-- ── 4) audit v4: rest_break_status changes are auditable, not skipped ───────

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
     AND NEW.second_meal_status IS NOT DISTINCT FROM OLD.second_meal_status
     AND NEW.rest_break_status IS NOT DISTINCT FROM OLD.rest_break_status
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

-- ── 5) Day re-poke: meal/rest compliance is per workday, so any edit must
--       reprice every closed sibling on that date (a pure touch the guards
--       admit; compute re-derives everything) ────────────────────────────────

CREATE OR REPLACE FUNCTION public.recompute_day_entries(_user_id uuid, _d date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _user_id IS NULL OR _d IS NULL THEN RETURN; END IF;
  UPDATE public.time_entries
  SET updated_at = now()
  WHERE user_id = _user_id
    AND log_date = _d
    AND clock_out IS NOT NULL
    AND voided_at IS NULL;
END $$;

REVOKE ALL ON FUNCTION public.recompute_day_entries(uuid, date) FROM PUBLIC, anon, authenticated;

-- ── 6) attest_shift: the worker resolves a shift they didn't close ───────────
-- Crew bulk punches, auto-closes and manager-created shifts leave meal/rest
-- 'pending' with nobody allowed to answer. The worker now can, from Mission,
-- for recent unfrozen shifts. Only pending → attested transitions exist;
-- everything else stays manager territory.

CREATE OR REPLACE FUNCTION public.attest_shift(
  _entry_id uuid, _meal text DEFAULT NULL, _rest text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row record;
  _today_la date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;
  SELECT user_id, clock_out, voided_at, log_date, meal_status, rest_break_status
    INTO _row FROM public.time_entries WHERE id = _entry_id;
  IF _row.user_id IS NULL THEN RAISE EXCEPTION 'time entry not found'; END IF;
  IF _row.user_id <> auth.uid() THEN RAISE EXCEPTION 'not your time entry'; END IF;
  IF _row.voided_at IS NOT NULL THEN RAISE EXCEPTION 'entry is voided'; END IF;
  IF _row.clock_out IS NULL THEN
    RAISE EXCEPTION 'this shift is still open — attest at clock-out';
  END IF;
  IF _row.log_date < _today_la - 14 THEN
    RAISE EXCEPTION 'this shift is too old to attest from the app — talk to your manager';
  END IF;
  IF public.week_is_frozen(_row.log_date) THEN
    RAISE EXCEPTION 'that week''s payroll is closed — talk to your manager';
  END IF;
  IF _meal IS NULL AND _rest IS NULL THEN RAISE EXCEPTION 'nothing to attest'; END IF;
  IF _meal IS NOT NULL AND _meal NOT IN ('missed', 'unrecorded') THEN
    RAISE EXCEPTION 'meal attestation must be missed or unrecorded';
  END IF;
  IF _rest IS NOT NULL AND _rest NOT IN ('ok', 'missed') THEN
    RAISE EXCEPTION 'rest attestation must be ok or missed';
  END IF;
  IF _meal IS NOT NULL AND _row.meal_status <> 'pending' THEN
    RAISE EXCEPTION 'the lunch on this shift is already resolved';
  END IF;
  IF _rest IS NOT NULL AND _row.rest_break_status <> 'pending' THEN
    RAISE EXCEPTION 'the rest breaks on this shift are already resolved';
  END IF;

  PERFORM set_config('app.edit_reason', 'worker shift attestation', true);
  UPDATE public.time_entries
  SET meal_status = COALESCE(_meal, meal_status),
      rest_break_status = COALESCE(_rest, rest_break_status)
  WHERE id = _entry_id;
END $$;

REVOKE ALL ON FUNCTION public.attest_shift(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attest_shift(uuid, text, text) TO authenticated;

-- ── 7) admin_set_shift_status: the manager/captain resolution for the same
--       states — reasoned + audited; admin_set_meal stays the path when the
--       real meal TIMES are known ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_set_shift_status(
  _entry_id uuid, _meal text, _rest text, _reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row record;
  _is_admin boolean;
  _flag_review boolean;
BEGIN
  SELECT user_id, clock_out, voided_at, log_date INTO _row
  FROM public.time_entries WHERE id = _entry_id;
  IF _row.user_id IS NULL THEN RAISE EXCEPTION 'time entry not found'; END IF;
  _is_admin := public.assert_time_adjust_rights(_row.user_id);
  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'a reason is required to set attestation states';
  END IF;
  IF _row.voided_at IS NOT NULL THEN RAISE EXCEPTION 'entry is voided'; END IF;
  IF _row.clock_out IS NULL THEN
    RAISE EXCEPTION 'close the shift first — statuses are derived at close';
  END IF;
  IF _meal IS NULL AND _rest IS NULL THEN RAISE EXCEPTION 'nothing to set'; END IF;
  IF _meal IS NOT NULL AND _meal NOT IN ('missed', 'unrecorded') THEN
    RAISE EXCEPTION 'meal status can only be set to missed or unrecorded — enter real lunch times to mark it taken';
  END IF;
  IF _rest IS NOT NULL AND _rest NOT IN ('ok', 'missed') THEN
    RAISE EXCEPTION 'rest status can only be set to ok or missed';
  END IF;

  _flag_review := NOT _is_admin AND public.captain_edit_needs_review();
  PERFORM set_config('app.edit_reason', _reason, true);
  UPDATE public.time_entries
  SET meal_status = COALESCE(_meal, meal_status),
      rest_break_status = COALESCE(_rest, rest_break_status)
  WHERE id = _entry_id;

  IF _flag_review THEN
    UPDATE public.time_entries
    SET needs_correction = true,
        flag_reasons = CASE WHEN NOT ('captain_edit' = ANY(flag_reasons))
                            THEN array_append(flag_reasons, 'captain_edit')
                            ELSE flag_reasons END
    WHERE id = _entry_id;
  ELSE
    UPDATE public.time_entries
    SET needs_correction = false,
        reviewed_by = auth.uid(),
        reviewed_at = now()
    WHERE id = _entry_id;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.admin_set_shift_status(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_shift_status(uuid, text, text, text) TO authenticated;

-- ── 8) Adjust RPCs v+1: identical bodies + the day re-poke (per-workday
--       compliance must reprice siblings after any edit) ─────────────────────

CREATE OR REPLACE FUNCTION public.admin_update_time_entry(
  _id uuid, _clock_in timestamptz, _clock_out timestamptz, _reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _target uuid;
  _old_date date;
  _is_admin boolean;
  _flag_review boolean;
BEGIN
  SELECT user_id, log_date INTO _target, _old_date FROM public.time_entries WHERE id = _id;
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
  -- Per-workday compliance: reprice the old day and (on a date move) the new.
  PERFORM public.recompute_day_entries(_target, _old_date);
  IF (_clock_in AT TIME ZONE 'America/Los_Angeles')::date IS DISTINCT FROM _old_date THEN
    PERFORM public.recompute_day_entries(_target, (_clock_in AT TIME ZONE 'America/Los_Angeles')::date);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.void_time_entry(_id uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _target uuid;
  _old_date date;
BEGIN
  SELECT user_id, log_date INTO _target, _old_date FROM public.time_entries WHERE id = _id;
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
  -- The voided hours leave the day — siblings' meal/rest duties may shrink.
  PERFORM public.recompute_day_entries(_target, _old_date);
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
  _d date;
  _first uuid;
  _is_admin boolean;
  _flag_review boolean;
BEGIN
  SELECT user_id, log_date INTO _uid, _d FROM public.time_entries WHERE id = _time_entry_id;
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
  -- A corrected lunch can satisfy the whole day's meal duty.
  PERFORM public.recompute_day_entries(_uid, _d);
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
  -- The backfilled hours join the day — siblings' meal/rest duties may grow.
  PERFORM public.recompute_day_entries(_user_id, (_clock_in AT TIME ZONE 'America/Los_Angeles')::date);
  RETURN _new_id;
END $$;

-- ── 9) calc v9: the rest premium joins the paycheck ─────────────────────────
-- New OUT columns require a DROP (CREATE OR REPLACE cannot change the row
-- type). Grants are re-stated below.

DROP FUNCTION IF EXISTS public.calc_weekly_paycheck(uuid, date);

CREATE FUNCTION public.calc_weekly_paycheck(_canvasser_id uuid, _week_start date)
 RETURNS TABLE(
   week_start date, week_end date,
   sits integer, points integer, sales integer, sale_price_total numeric,
   hours numeric, reg_hours numeric, ot_hours numeric, dt_hours numeric,
   hourly_rate numeric, regular_rate numeric,
   base_pay numeric, ot_premium_pay numeric,
   meal_premium_count integer, meal_premium_pay numeric,
   rest_premium_count integer, rest_premium_pay numeric,
   commission_rate numeric, commission numeric,
   sit_bonus numeric, monster_bonus numeric,
   total_pay numeric, rank text, exceptions jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- Workweek: Monday through Sunday, LA time — 7 consecutive days, as CA
  -- overtime law requires. (Sundays are unscheduled but PAID when worked;
  -- they surface in exceptions for run review.)
  _week_end date := _week_start + 6;
  _sits int := 0; _points int := 0; _sales int := 0;
  _sale_total numeric := 0;
  _rate numeric := 18.00; _comm_rate numeric := 0.01;
  _sit_bonus numeric := 0; _monster numeric := 0;
  _commission numeric := 0;
  _rank text; _sit_bonus_per numeric := 50;
  _pay_lock text := 'active';
  -- hours buckets
  _hours numeric := 0; _reg numeric := 0; _ot numeric := 0; _dt numeric := 0;
  _days_worked int := 0;
  _d record;
  _day_reg numeric; _day_ot numeric; _day_dt numeric;
  _is_7th boolean;
  -- money
  _base numeric := 0; _ot_prem numeric := 0;
  _flat_bonus numeric := 0; _reg_rate numeric := 0;
  _meal_days int := 0; _meal_prem numeric := 0;
  _rest_days int := 0; _rest_prem numeric := 0;
  -- exceptions
  _sunday_hours numeric := 0; _auto_closed int := 0; _needs_corr int := 0;
  _meal_pending int := 0; _meal_unrecorded int := 0;
  _second_meal_missed int := 0; _rest_pending int := 0;
  -- San Diego city minimum wage, 2026 (indexed annually — re-verify each Jan).
  _min_wage numeric := 17.75;
BEGIN
  IF NOT (
    auth.uid() IS NULL
    OR auth.uid() = _canvasser_id
    OR public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR (
      public.has_role(auth.uid(), 'captain'::app_role)
      AND public.my_team_id(_canvasser_id) = public.my_team_id(auth.uid())
    )
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT COALESCE(SUM(dl.demos_sits),0), COALESCE(SUM(dl.demos_sits+dl.sales),0), COALESCE(SUM(dl.sales),0)
    INTO _sits,_points,_sales
  FROM public.daily_logs dl
  WHERE dl.canvasser_id=_canvasser_id AND dl.log_date BETWEEN _week_start AND _week_end;

  -- WCC-cancelled sales pay nothing (owner, 2026-09-12): the
  -- sale_cancelled_at stamp (mirror_wcc_cancel_to_leads, PRs #203/#204)
  -- excludes the sale from commission. Cross-week: a sale paid in an
  -- already-APPROVED run is recovered by create_payroll_run's clawback
  -- pass, never by rewriting history.
  SELECT COALESCE(SUM(l.sale_amount),0) INTO _sale_total
  FROM public.leads l
  WHERE l.canvasser_id=_canvasser_id AND l.status='confirmed'
    AND l.sale_cancelled_at IS NULL
    AND (COALESCE(l.reviewed_at,l.created_at) AT TIME ZONE 'America/Los_Angeles')::date BETWEEN _week_start AND _week_end;

  -- Daily hours → CA overtime buckets. Straight-time-hours per day feed
  -- daily 8/12 splits; the 7th-consecutive-day rule applies when all seven
  -- days of the workweek were worked; weekly >40 catches the remainder.
  SELECT COUNT(*) INTO _days_worked FROM (
    SELECT te.log_date FROM public.time_entries te
    WHERE te.user_id = _canvasser_id
      AND te.log_date BETWEEN _week_start AND _week_end
      AND te.clock_out IS NOT NULL AND te.voided_at IS NULL
      AND te.billable_hours > 0
    GROUP BY te.log_date) dw;

  FOR _d IN
    SELECT te.log_date, SUM(te.billable_hours) AS day_hours
    FROM public.time_entries te
    WHERE te.user_id = _canvasser_id
      AND te.log_date BETWEEN _week_start AND _week_end
      AND te.clock_out IS NOT NULL AND te.voided_at IS NULL
    GROUP BY te.log_date
  LOOP
    _is_7th := (_days_worked = 7 AND _d.log_date = _week_end);
    IF _is_7th THEN
      -- 7th consecutive day: first 8 hours at 1.5x, beyond 8 at 2x.
      _day_reg := 0;
      _day_ot  := LEAST(_d.day_hours, 8);
      _day_dt  := GREATEST(_d.day_hours - 8, 0);
    ELSE
      _day_reg := LEAST(_d.day_hours, 8);
      _day_ot  := LEAST(GREATEST(_d.day_hours - 8, 0), 4);
      _day_dt  := GREATEST(_d.day_hours - 12, 0);
    END IF;
    _reg := _reg + _day_reg; _ot := _ot + _day_ot; _dt := _dt + _day_dt;
    IF EXTRACT(ISODOW FROM _d.log_date)::int = 7 THEN
      _sunday_hours := _sunday_hours + _d.day_hours;
    END IF;
  END LOOP;

  -- Weekly overtime: straight-time hours beyond 40 shift to 1.5x (hours
  -- already premium under the daily rules don't count twice).
  IF _reg > 40 THEN
    _ot := _ot + (_reg - 40);
    _reg := 40;
  END IF;
  _hours := _reg + _ot + _dt;

  -- Meal premiums: ONE premium hour per day with ANY meal violation —
  -- first meal missed/late OR second meal (>10h day, LC 512) missed/late
  -- (LC 226.7 caps it at one meal premium per day; Donohue). 'pending' /
  -- 'unrecorded' first-meal days pay no premium yet — they are run-review
  -- exceptions to resolve first.
  SELECT COUNT(*) INTO _meal_days FROM (
    SELECT te.log_date FROM public.time_entries te
    WHERE te.user_id = _canvasser_id
      AND te.log_date BETWEEN _week_start AND _week_end
      AND te.clock_out IS NOT NULL AND te.voided_at IS NULL
      AND (te.meal_status IN ('missed', 'taken_late')
        OR te.second_meal_status IN ('missed', 'taken_late'))
    GROUP BY te.log_date) md;

  -- Rest premiums (LC 226.7): ONE premium hour per day the worker attested
  -- a missed rest break — separate from and additive to the meal premium
  -- (a day can owe one of each). 'pending' rest days pay no premium; they
  -- surface as run-review chips but never block approval.
  SELECT COUNT(*) INTO _rest_days FROM (
    SELECT te.log_date FROM public.time_entries te
    WHERE te.user_id = _canvasser_id
      AND te.log_date BETWEEN _week_start AND _week_end
      AND te.clock_out IS NOT NULL AND te.voided_at IS NULL
      AND te.rest_break_status = 'missed'
    GROUP BY te.log_date) rd;

  SELECT COUNT(*) FILTER (WHERE te.entry_source = 'auto_closed'),
         COUNT(*) FILTER (WHERE te.needs_correction),
         COUNT(*) FILTER (WHERE te.meal_status = 'pending'),
         COUNT(*) FILTER (WHERE te.meal_status = 'unrecorded'),
         COUNT(*) FILTER (WHERE te.second_meal_status IN ('missed', 'taken_late')),
         COUNT(*) FILTER (WHERE te.rest_break_status = 'pending')
    INTO _auto_closed, _needs_corr, _meal_pending, _meal_unrecorded,
         _second_meal_missed, _rest_pending
  FROM public.time_entries te
  WHERE te.user_id = _canvasser_id
    AND te.log_date BETWEEN _week_start AND _week_end
    AND te.clock_out IS NOT NULL AND te.voided_at IS NULL;

  SELECT COALESCE(current_rank,'Jr. Silver'), COALESCE(pay_lock_status,'active')
    INTO _rank, _pay_lock
  FROM public.profiles WHERE id=_canvasser_id;

  IF _points >= 7 THEN _rate := 35.00;
  ELSIF _points >= 3 THEN _rate := 30.00;
  ELSE _rate := 18.00; END IF;

  IF _points >= 7 THEN _comm_rate := 0.02; ELSE _comm_rate := 0.01; END IF;

  IF _rank IN ('Jr. Diamond','Sr. Diamond','Captain') AND _pay_lock <> 'reverted' THEN
    _rate := 35.00; _comm_rate := 0.02;
  END IF;

  IF _rank IN ('Sr. Gold','Jr. Diamond','Sr. Diamond','Captain') THEN
    _sit_bonus_per := 75;
  END IF;

  _commission := _sale_total * _comm_rate;
  _sit_bonus := GREATEST(_sits - 3, 0) * _sit_bonus_per;
  _monster := CASE WHEN _points >= 10 THEN 500 ELSE 0 END;
  _flat_bonus := _sit_bonus + _monster;

  -- Straight time on ALL hours at the tier rate, then premiums on top:
  --   · hourly: +0.5x on OT hours, +1.0x on DT hours
  --   · flat-sum bonuses (sit + Monster): per-hour value divides by NON-OT
  --     hours; premium is 1.5x / 2x that value per OT/DT hour (Alvarado)
  --   · commission (percentage of production): per-hour value divides by
  --     ALL hours; premium is +0.5x / +1.0x per OT/DT hour (DLSE 49.2.4)
  _base := _hours * _rate;
  _ot_prem := (0.5 * _rate * _ot) + (1.0 * _rate * _dt);
  IF _reg > 0 AND _flat_bonus > 0 THEN
    _ot_prem := _ot_prem + (_flat_bonus / _reg) * (1.5 * _ot + 2.0 * _dt);
  END IF;
  IF _hours > 0 AND _commission > 0 THEN
    _ot_prem := _ot_prem + (_commission / _hours) * (0.5 * _ot + 1.0 * _dt);
  END IF;

  -- Regular rate of compensation for meal AND rest premiums (Ferra v.
  -- Loews: includes nondiscretionary payments, same blend as overtime).
  _reg_rate := CASE WHEN _hours > 0
                    THEN (_base + _flat_bonus + _commission) / _hours
                    ELSE _rate END;
  _meal_prem := _meal_days * _reg_rate;
  _rest_prem := _rest_days * _reg_rate;

  week_start := _week_start; week_end := _week_end;
  sits := _sits; points := _points; sales := _sales;
  sale_price_total := _sale_total;
  hours := _hours; reg_hours := _reg; ot_hours := _ot; dt_hours := _dt;
  hourly_rate := _rate; regular_rate := ROUND(_reg_rate, 4);
  base_pay := ROUND(_base, 2); ot_premium_pay := ROUND(_ot_prem, 2);
  meal_premium_count := _meal_days; meal_premium_pay := ROUND(_meal_prem, 2);
  rest_premium_count := _rest_days; rest_premium_pay := ROUND(_rest_prem, 2);
  commission_rate := _comm_rate; commission := ROUND(_commission, 2);
  sit_bonus := _sit_bonus; monster_bonus := _monster;
  total_pay := ROUND(_base + _ot_prem + _meal_prem + _rest_prem + _commission + _sit_bonus + _monster, 2);
  rank := _rank;
  exceptions := jsonb_build_object(
    'sunday_hours', _sunday_hours,
    'auto_closed_entries', _auto_closed,
    'needs_correction', _needs_corr,
    'meal_pending', _meal_pending,
    'meal_unrecorded', _meal_unrecorded,
    'second_meal_missed', _second_meal_missed,
    'rest_pending', _rest_pending,
    'below_min_wage', (_rate < _min_wage)
  );
  RETURN NEXT;
END $function$;

REVOKE ALL ON FUNCTION public.calc_weekly_paycheck(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calc_weekly_paycheck(uuid, date) TO service_role;

-- ── 10) create_payroll_run v5: snapshot the rest premium columns ─────────────
-- Identical to v4 (20261002140000) except the two new line columns.

CREATE OR REPLACE FUNCTION public.create_payroll_run(_week_start date)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _run_id uuid;
  _week_end date := _week_start + 6;
  _cid uuid;
  _pc record;
  _name text;
  _cb record;
  _rv record;
  _line_id uuid;
  _pool numeric;
  _outstanding numeric;
  _apply numeric;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  DELETE FROM public.payroll_runs WHERE week_start = _week_start AND status = 'draft';
  IF EXISTS (SELECT 1 FROM public.payroll_runs
             WHERE week_start = _week_start AND status = 'approved') THEN
    RAISE EXCEPTION 'week % already has an approved run — reopen it (owner) or correct on the next run', _week_start;
  END IF;

  INSERT INTO public.payroll_runs (week_start, created_by)
  VALUES (_week_start, auth.uid())
  RETURNING id INTO _run_id;

  FOR _cid IN
    SELECT DISTINCT u FROM (
      SELECT te.user_id AS u FROM public.time_entries te
       WHERE te.log_date BETWEEN _week_start AND _week_end
         AND te.clock_out IS NOT NULL AND te.voided_at IS NULL
      UNION
      SELECT dl.canvasser_id FROM public.daily_logs dl
       WHERE dl.log_date BETWEEN _week_start AND _week_end
      UNION
      SELECT l.canvasser_id FROM public.leads l
       WHERE l.status = 'confirmed'
         AND (COALESCE(l.reviewed_at, l.created_at) AT TIME ZONE 'America/Los_Angeles')::date
             BETWEEN _week_start AND _week_end
    ) ids WHERE u IS NOT NULL
  LOOP
    SELECT * INTO _pc FROM public.calc_weekly_paycheck(_cid, _week_start);
    IF _pc.total_pay IS NULL OR (_pc.total_pay = 0 AND _pc.hours = 0) THEN CONTINUE; END IF;
    SELECT COALESCE(display_name, _cid::text) INTO _name FROM public.profiles WHERE id = _cid;
    INSERT INTO public.payroll_run_lines (
      run_id, canvasser_id, display_name, rank,
      hours, reg_hours, ot_hours, dt_hours,
      hourly_rate, regular_rate, base_pay, ot_premium_pay,
      meal_premium_count, meal_premium_pay,
      rest_premium_count, rest_premium_pay,
      commission, sit_bonus, monster_bonus, total_pay,
      exceptions, snapshot)
    VALUES (
      _run_id, _cid, COALESCE(_name, _cid::text), _pc.rank,
      _pc.hours, _pc.reg_hours, _pc.ot_hours, _pc.dt_hours,
      _pc.hourly_rate, _pc.regular_rate, _pc.base_pay, _pc.ot_premium_pay,
      _pc.meal_premium_count, _pc.meal_premium_pay,
      _pc.rest_premium_count, _pc.rest_premium_pay,
      _pc.commission, _pc.sit_bonus, _pc.monster_bonus, _pc.total_pay,
      COALESCE(_pc.exceptions, '{}'::jsonb), to_jsonb(_pc));
  END LOOP;

  -- Worker sign-off state on every line (soft gate — review chips only).
  UPDATE public.payroll_run_lines l
  SET exceptions = l.exceptions || jsonb_build_object(
        'attestation',
        COALESCE((SELECT a.status FROM public.time_week_attestations a
                  WHERE a.user_id = l.canvasser_id
                    AND a.week_start = _week_start
                    AND a.superseded_at IS NULL), 'none'))
  WHERE l.run_id = _run_id;

  -- ── Reversals first (money owed BACK to the worker): a lead whose cancel
  --    stamp healed after claws were taken on APPROVED runs refunds the net
  --    clawed amount. Draft-run claws are not refunded — re-creating that
  --    draft recomputes them away instead.
  FOR _rv IN
    SELECT cc.lead_id, cc.canvasser_id,
           ROUND(SUM(CASE WHEN cc.kind = 'clawback' THEN cc.amount ELSE -cc.amount END), 2) AS net
    FROM public.commission_clawbacks cc
    JOIN public.payroll_runs cr ON cr.id = cc.run_id AND cr.status = 'approved'
    JOIN public.leads l ON l.id = cc.lead_id
    WHERE l.sale_cancelled_at IS NULL
    GROUP BY cc.lead_id, cc.canvasser_id
    HAVING SUM(CASE WHEN cc.kind = 'clawback' THEN cc.amount ELSE -cc.amount END) > 0.005
  LOOP
    SELECT id INTO _line_id FROM public.payroll_run_lines
     WHERE run_id = _run_id AND canvasser_id = _rv.canvasser_id;
    IF _line_id IS NULL THEN CONTINUE; END IF; -- inactive this week: stays outstanding
    UPDATE public.payroll_run_lines SET
      commission_adjustment = commission_adjustment + _rv.net,
      total_pay = total_pay + _rv.net,
      exceptions = exceptions || jsonb_build_object('commission_clawback',
        ROUND(COALESCE((exceptions->>'commission_clawback')::numeric, 0) + _rv.net, 2))
    WHERE id = _line_id;
    INSERT INTO public.commission_clawbacks
      (run_id, line_id, lead_id, canvasser_id, source_run_id, kind, amount)
    VALUES (_run_id, _line_id, _rv.lead_id, _rv.canvasser_id, NULL, 'reversal', _rv.net);
  END LOOP;

  -- ── Clawbacks: cancelled sales that were PAID (line in an approved run
  --    snapshotted before the stamp existed). Recovery is capped at this
  --    week's commission pool (commission + adjustments so far); the
  --    remainder stays outstanding for later runs. All ledger rows count
  --    toward "already recovered" — rows on other pending drafts included,
  --    so two open drafts can never claw the same dollars twice.
  FOR _cb IN
    SELECT l.id AS lead_id, l.canvasser_id, r0.id AS source_run_id,
           ROUND(l.sale_amount * COALESCE((prl.snapshot->>'commission_rate')::numeric, 0), 2)
             AS paid_comm
    FROM public.leads l
    JOIN public.payroll_runs r0
      ON r0.status = 'approved'
     AND r0.week_start < _week_start
     AND r0.week_start = (date_trunc('week',
           ((COALESCE(l.reviewed_at, l.created_at) AT TIME ZONE 'America/Los_Angeles')::date)::timestamp))::date
    JOIN public.payroll_run_lines prl
      ON prl.run_id = r0.id AND prl.canvasser_id = l.canvasser_id
    WHERE l.status = 'confirmed'
      AND l.sale_cancelled_at IS NOT NULL
      AND l.sale_cancelled_at > r0.created_at
      AND COALESCE(l.sale_amount, 0) > 0
    ORDER BY r0.week_start, COALESCE(l.reviewed_at, l.created_at)
  LOOP
    _outstanding := _cb.paid_comm - COALESCE((
      SELECT SUM(CASE WHEN cc.kind = 'clawback' THEN cc.amount ELSE -cc.amount END)
      FROM public.commission_clawbacks cc
      WHERE cc.lead_id = _cb.lead_id), 0);
    IF _outstanding <= 0.005 THEN CONTINUE; END IF;
    SELECT id, commission + commission_adjustment INTO _line_id, _pool
      FROM public.payroll_run_lines
     WHERE run_id = _run_id AND canvasser_id = _cb.canvasser_id;
    IF _line_id IS NULL OR _pool IS NULL OR _pool <= 0 THEN CONTINUE; END IF;
    _apply := ROUND(LEAST(_outstanding, _pool), 2);
    IF _apply <= 0 THEN CONTINUE; END IF;
    UPDATE public.payroll_run_lines SET
      commission_adjustment = commission_adjustment - _apply,
      total_pay = total_pay - _apply,
      exceptions = exceptions || jsonb_build_object('commission_clawback',
        ROUND(COALESCE((exceptions->>'commission_clawback')::numeric, 0) - _apply, 2))
    WHERE id = _line_id;
    INSERT INTO public.commission_clawbacks
      (run_id, line_id, lead_id, canvasser_id, source_run_id, kind, amount)
    VALUES (_run_id, _line_id, _cb.lead_id, _cb.canvasser_id, _cb.source_run_id, 'clawback', _apply);
  END LOOP;

  RETURN _run_id;
END $$;

-- ── 11) timesheet_day_detail: the punch-detail export shows rest state ───────

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
       te.rest_break_status
FROM public.time_entries te
LEFT JOIN public.profiles p ON p.id = te.user_id
LEFT JOIN public.teams t ON t.id = p.team_id
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS meal_count,
         ROUND(SUM(EXTRACT(EPOCH FROM (mp.meal_end - mp.meal_start)) / 60.0)) AS meal_minutes,
         MIN(mp.meal_start) AS first_meal_start,
         MAX(mp.meal_end)  AS last_meal_end
  FROM public.meal_periods mp
  WHERE mp.time_entry_id = te.id AND mp.meal_end IS NOT NULL
    AND mp.meal_end > mp.meal_start
) m ON true;

GRANT SELECT ON public.timesheet_day_detail TO authenticated;

-- ── 12) Rest-break reminder nudges to the WORKER ─────────────────────────────
-- Prevention first, same shape as the lunch warning: pg_cron every 10
-- minutes; stage 1 lands between 2h00–2h10 on the clock, stage 2 between
-- 6h00–6h10 (the second break's territory). Skipped while they're on lunch
-- (they're resting). Once per shift per stage.

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
  -- Cron / service contexts only (no JWT).
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
      NULL; -- one bad row must never kill the sweep or the cron
    END;
  END LOOP;
  RETURN _sent;
END $$;

REVOKE ALL ON FUNCTION public.send_rest_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_rest_reminders() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rest-break-reminders') THEN
    PERFORM cron.unschedule('rest-break-reminders');
  END IF;
  PERFORM cron.schedule(
    'rest-break-reminders',
    '*/10 * * * *',
    $CRON$ SELECT public.send_rest_reminders(); $CRON$
  );
END $$;
