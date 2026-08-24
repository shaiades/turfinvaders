-- ═══════════════════════════════════════════════════════════════════════════
-- TIME CLOCK P0 (owner-approved 2026-08-19, per the Punches-to-Paychecks
-- audit F1–F11). Makes the clock defensible as the payroll system of record.
--
--   1) Meals: new meal_periods table (lunch start/end punches). Billable
--      hours deduct ONLY recorded meal time — the blanket 30-min deduction
--      is gone (F1). meal_status tracks compliance per entry; missed/late
--      meals auto-pay a premium hour in the pay engine (Ferra v. Loews).
--   2) Sundays are PAID when worked (F2). "We don't schedule Sundays" is
--      now an exception surfaced in payroll-run review, not a $0 rule.
--   3) Overtime (F3): the workweek is Mon–Sun (7 consecutive days, LA time).
--      Daily 8/12, weekly 40, and 7th-consecutive-day rules, with premiums
--      on the blended regular rate: flat-sum bonuses divide by non-OT hours
--      (Alvarado v. Dart), commissions divide by all hours (DLSE 49.2.4).
--      Stats/commission windows follow the same Mon–Sun week (Sunday rows
--      were previously excluded and normally empty).
--   4) Auto-close no longer fabricates punches silently (F4): closed
--      entries are stamped entry_source='auto_closed' + needs_correction,
--      and a clock-in after the cutoff closes at LA midnight, never at its
--      own start (the zero-hour bug).
--   5) Workers are punch-only (F6): inserts must be "now", the only edit a
--      worker may make is closing their own open shift/meal "now" (plus a
--      meal attestation). History is manager-only via reasoned RPCs.
--   6) Append-only audit (F7): every insert/update on time_entries and
--      meal_periods writes time_entry_audit with actor, reason, old, new.
--   7) No hard deletes (F9): entries are VOIDED with a reason; the delete
--      policy is dropped and the auth.users FK no longer cascades.
--   8) Payroll runs (F8): create_payroll_run snapshots the week per person
--      into payroll_runs/payroll_run_lines; approve_payroll_run freezes it
--      immutably. Corrections after approval are next-run adjustments.
--   9) office_staff (Managers) can read time data (F11) and operate runs.
--
-- BACKFILL NOTE: closed entries are recomputed under the new rules. Every
-- historical shift gains its 30 minutes back and Sunday shifts gain their
-- hours — past weeks WILL show higher totals than what was paid. That delta
-- is real (it is what the old rules under-recorded); owner + accountant
-- decide the true-up. Historical entries get meal_status 'not_required'
-- (≤5h) or 'unrecorded' (>5h) and keep entry_source='self' — pre-migration
-- auto-closes were never flagged and cannot be identified retroactively.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) time_entries: provenance, meal status, voiding ───────────────────────

ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS entry_source text NOT NULL DEFAULT 'self',
  ADD COLUMN IF NOT EXISTS needs_correction boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS meal_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by uuid,
  ADD COLUMN IF NOT EXISTS void_reason text;

ALTER TABLE public.time_entries
  ADD CONSTRAINT time_entries_source_chk
    CHECK (entry_source IN ('self','auto_closed','manager_edit','manager_created')),
  ADD CONSTRAINT time_entries_meal_status_chk
    CHECK (meal_status IN ('pending','not_required','taken','taken_late','missed','unrecorded'));

-- Retention: deleting an auth user must never erase time records (LC 1174).
ALTER TABLE public.time_entries
  DROP CONSTRAINT IF EXISTS time_entries_user_id_fkey;
ALTER TABLE public.time_entries
  ADD CONSTRAINT time_entries_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

-- ── 2) meal_periods: the lunch punches ──────────────────────────────────────

CREATE TABLE public.meal_periods (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  time_entry_id uuid NOT NULL REFERENCES public.time_entries(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  meal_start timestamptz NOT NULL DEFAULT now(),
  meal_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX meal_periods_entry_idx ON public.meal_periods(time_entry_id);
CREATE UNIQUE INDEX meal_periods_one_open_per_entry
  ON public.meal_periods(time_entry_id) WHERE meal_end IS NULL;

GRANT SELECT, INSERT, UPDATE ON public.meal_periods TO authenticated;
GRANT ALL ON public.meal_periods TO service_role;
ALTER TABLE public.meal_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "meal read own or staff" ON public.meal_periods
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain'));

CREATE POLICY "meal insert own or staff" ON public.meal_periods
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid()
              OR public.has_role(auth.uid(), 'owner')
              OR public.has_role(auth.uid(), 'office_staff'));

CREATE POLICY "meal update own or staff" ON public.meal_periods
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff'))
  WITH CHECK (user_id = auth.uid()
              OR public.has_role(auth.uid(), 'owner')
              OR public.has_role(auth.uid(), 'office_staff'));
-- No DELETE policy: meals are never hard-deleted (zero-length = voided meal).

CREATE TRIGGER meal_periods_touch_updated_at
  BEFORE UPDATE ON public.meal_periods
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 3) time_entries RLS: office_staff reads; no client deletes ──────────────

DROP POLICY IF EXISTS "Users view own time entries" ON public.time_entries;
CREATE POLICY "Users view own time entries" ON public.time_entries
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain'));

DROP POLICY IF EXISTS "Users update own time entries" ON public.time_entries;
CREATE POLICY "Users update own time entries" ON public.time_entries
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff'))
  WITH CHECK (user_id = auth.uid()
              OR public.has_role(auth.uid(), 'owner')
              OR public.has_role(auth.uid(), 'office_staff'));

-- Hard deletes end here (F9). Voiding is the only removal path.
DROP POLICY IF EXISTS "Owners delete time entries" ON public.time_entries;
REVOKE DELETE ON public.time_entries FROM authenticated;

-- ── 4) Append-only audit trail ──────────────────────────────────────────────

CREATE TABLE public.time_entry_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  time_entry_id uuid NOT NULL,
  happened_at timestamptz NOT NULL DEFAULT now(),
  actor uuid,               -- auth.uid(); NULL = system (cron / service role)
  action text NOT NULL,     -- insert | update | punch_out | void | auto_close | meal_insert | meal_update
  reason text,
  old_row jsonb,
  new_row jsonb
);

CREATE INDEX time_entry_audit_entry_idx ON public.time_entry_audit(time_entry_id, happened_at);

-- Append-only: SELECT for staff + the worker's own rows; INSERT only via the
-- SECURITY DEFINER trigger below; no UPDATE/DELETE for anyone but service_role.
GRANT SELECT ON public.time_entry_audit TO authenticated;
GRANT ALL ON public.time_entry_audit TO service_role;
ALTER TABLE public.time_entry_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit read own or staff" ON public.time_entry_audit
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.time_entries te
                 WHERE te.id = time_entry_audit.time_entry_id
                   AND te.user_id = auth.uid())
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain'));

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
  -- Pure recompute touches (meal-trigger pokes that changed nothing
  -- material) don't earn an audit row.
  IF TG_OP = 'UPDATE'
     AND NEW.clock_in IS NOT DISTINCT FROM OLD.clock_in
     AND NEW.clock_out IS NOT DISTINCT FROM OLD.clock_out
     AND NEW.log_date IS NOT DISTINCT FROM OLD.log_date
     AND NEW.billable_hours IS NOT DISTINCT FROM OLD.billable_hours
     AND NEW.meal_status IS NOT DISTINCT FROM OLD.meal_status
     AND NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at
     AND NEW.entry_source IS NOT DISTINCT FROM OLD.entry_source
     AND NEW.needs_correction IS NOT DISTINCT FROM OLD.needs_correction THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    _action := 'insert';
  ELSIF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    _action := 'void';
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

CREATE TRIGGER time_entries_zz_audit
  AFTER INSERT OR UPDATE ON public.time_entries
  FOR EACH ROW EXECUTE FUNCTION public.audit_time_entry();

CREATE OR REPLACE FUNCTION public.audit_meal_period()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.time_entry_audit (time_entry_id, actor, action, reason, old_row, new_row)
  VALUES (NEW.time_entry_id, auth.uid(),
          CASE WHEN TG_OP = 'INSERT' THEN 'meal_insert' ELSE 'meal_update' END,
          NULLIF(current_setting('app.edit_reason', true), ''),
          CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, to_jsonb(NEW));
  RETURN NEW;
END $$;

CREATE TRIGGER meal_periods_zz_audit
  AFTER INSERT OR UPDATE ON public.meal_periods
  FOR EACH ROW EXECUTE FUNCTION public.audit_meal_period();

-- ── 5) Worker punch-only guards (F6) ────────────────────────────────────────
-- Named a_guard so they run before the compute trigger (BEFORE triggers fire
-- alphabetically). auth.uid() IS NULL = cron/service/definer contexts pass.

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
      -- Reasoned manager creation (admin_create_time_entry stamps the reason).
      NEW.entry_source := 'manager_created';
      RETURN NEW;
    END IF;
    -- Self-punch: must be a live clock-in, not a backdated record.
    IF NEW.user_id <> auth.uid() THEN
      RAISE EXCEPTION 'creating an entry for someone else requires a reason (use the timesheet editor)';
    END IF;
    IF NEW.clock_out IS NOT NULL
       OR abs(extract(epoch FROM (NEW.clock_in - now()))) > 300 THEN
      RAISE EXCEPTION 'clock-in must be now — past or future punches need a manager correction';
    END IF;
    NEW.entry_source := 'self';
    NEW.needs_correction := false;
    NEW.voided_at := NULL; NEW.voided_by := NULL; NEW.void_reason := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE. Pure touches (recompute pokes from the meal trigger — nothing
  -- material in the row changes) pass for anyone RLS already admitted.
  IF NEW.clock_in IS NOT DISTINCT FROM OLD.clock_in
     AND NEW.clock_out IS NOT DISTINCT FROM OLD.clock_out
     AND NEW.log_date IS NOT DISTINCT FROM OLD.log_date
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.meal_status IS NOT DISTINCT FROM OLD.meal_status
     AND NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at
     AND NEW.entry_source IS NOT DISTINCT FROM OLD.entry_source
     AND NEW.needs_correction IS NOT DISTINCT FROM OLD.needs_correction THEN
    RETURN NEW;
  END IF;

  IF _privileged THEN
    -- Any reasoned edit is allowed (the RPCs stamp reasons); a reasonless
    -- privileged update may only be their own live punch-out, below.
    IF _reason IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF NOT (auth.uid() = OLD.user_id AND OLD.clock_out IS NULL
            AND NEW.clock_out IS NOT NULL AND NEW.voided_at IS NULL) THEN
      RAISE EXCEPTION 'editing time records requires a reason (use the timesheet editor)';
    END IF;
  END IF;

  -- Worker path: the only permitted write is closing YOUR OWN OPEN shift at
  -- "now", optionally attesting the meal outcome. Everything else is frozen.
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
     OR NEW.needs_correction IS DISTINCT FROM OLD.needs_correction THEN
    RAISE EXCEPTION 'only clock-out and meal attestation can change on a punch-out';
  END IF;
  IF NEW.meal_status IS DISTINCT FROM OLD.meal_status
     AND NEW.meal_status NOT IN ('missed', 'unrecorded') THEN
    RAISE EXCEPTION 'attestation can only mark a meal missed or unrecorded';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER time_entries_a_guard
  BEFORE INSERT OR UPDATE ON public.time_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_time_entry_write();

CREATE OR REPLACE FUNCTION public.guard_meal_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _privileged boolean;
  _entry record;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  _privileged := public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff');
  IF _privileged AND NULLIF(current_setting('app.edit_reason', true), '') IS NOT NULL THEN
    RETURN NEW; -- reasoned manager fix (admin_set_meal), any target incl. self
  END IF;

  SELECT user_id, clock_out INTO _entry FROM public.time_entries WHERE id = NEW.time_entry_id;
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

CREATE TRIGGER meal_periods_a_guard
  BEFORE INSERT OR UPDATE ON public.meal_periods
  FOR EACH ROW EXECUTE FUNCTION public.guard_meal_write();

-- ── 6) Billable hours v3: deduct only recorded meals; Sundays paid ──────────

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
BEGIN
  IF NEW.voided_at IS NOT NULL THEN
    NEW.billable_hours := 0;
    RETURN NEW;
  END IF;
  IF NEW.clock_out IS NULL THEN
    NEW.billable_hours := 0;
    RETURN NEW;
  END IF;

  _raw_hours := EXTRACT(EPOCH FROM (NEW.clock_out - NEW.clock_in)) / 3600.0;
  IF _raw_hours < 0 THEN _raw_hours := 0; END IF;

  -- Recorded meals only (F1). Each closed meal is clamped to the shift span.
  SELECT COALESCE(SUM(GREATEST(0,
           EXTRACT(EPOCH FROM (LEAST(mp.meal_end, NEW.clock_out)
                             - GREATEST(mp.meal_start, NEW.clock_in))) / 3600.0)), 0),
         -- Compliant: an uninterrupted 30+ min meal STARTING before the end
         -- of the fifth hour of the shift (per-shift approximation of the
         -- daily rule; single-shift days are the norm).
         bool_or(mp.meal_end - mp.meal_start >= interval '30 minutes'
                 AND mp.meal_start <= NEW.clock_in + interval '5 hours'),
         bool_or(mp.meal_end - mp.meal_start >= interval '30 minutes'
                 AND mp.meal_start > NEW.clock_in + interval '5 hours')
    INTO _meal_hours, _has_compliant_meal, _has_late_meal
  FROM public.meal_periods mp
  WHERE mp.time_entry_id = NEW.id AND mp.meal_end IS NOT NULL;

  NEW.billable_hours := ROUND(GREATEST(_raw_hours - _meal_hours, 0)::numeric, 2);

  -- Meal status: derived when it can be, attested when it can't.
  IF _raw_hours <= 5.0 THEN
    NEW.meal_status := CASE WHEN _meal_hours > 0 THEN 'taken' ELSE 'not_required' END;
  ELSIF COALESCE(_has_compliant_meal, false) THEN
    NEW.meal_status := 'taken';
  ELSIF COALESCE(_has_late_meal, false) THEN
    NEW.meal_status := 'taken_late';   -- recorded, but after the 5th hour: premium due
  ELSIF NEW.meal_status NOT IN ('missed', 'unrecorded') THEN
    NEW.meal_status := 'pending';      -- >5h, nothing recorded, no attestation yet
  END IF;

  RETURN NEW;
END $$;

-- A meal punch closing later than the shift's compute must re-price the shift.
CREATE OR REPLACE FUNCTION public.recompute_entry_from_meal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.time_entries SET updated_at = now() WHERE id = NEW.time_entry_id;
  RETURN NEW;
END $$;

CREATE TRIGGER meal_periods_zz_recompute
  AFTER INSERT OR UPDATE ON public.meal_periods
  FOR EACH ROW EXECUTE FUNCTION public.recompute_entry_from_meal();

-- ── 7) Auto-close v2: flag, never fabricate silently (F4) ───────────────────

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
  _close_at_utc timestamptz;
  _now_local timestamp := (now() AT TIME ZONE 'America/Los_Angeles');
  _affected int := 0;
BEGIN
  FOR _rec IN
    SELECT id, clock_in FROM public.time_entries
    WHERE clock_out IS NULL AND voided_at IS NULL
  LOOP
    _local_date := (_rec.clock_in AT TIME ZONE 'America/Los_Angeles')::date;
    _dow := EXTRACT(ISODOW FROM _local_date)::int;

    IF _dow BETWEEN 1 AND 5 THEN _cutoff_local := _local_date + time '18:00';
    ELSIF _dow = 6 THEN            _cutoff_local := _local_date + time '17:00';
    ELSE                           _cutoff_local := _local_date + time '18:00';
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

-- ── 8) Reasoned manager RPCs (the only path that edits history) ─────────────

CREATE OR REPLACE FUNCTION public.admin_update_time_entry(
  _id uuid, _clock_in timestamptz, _clock_out timestamptz, _reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'a reason is required to edit a time record';
  END IF;
  IF _clock_out IS NOT NULL AND _clock_out <= _clock_in THEN
    RAISE EXCEPTION 'clock-out must be after clock-in';
  END IF;
  PERFORM set_config('app.edit_reason', _reason, true);
  UPDATE public.time_entries
  SET clock_in = _clock_in,
      clock_out = _clock_out,
      log_date = (_clock_in AT TIME ZONE 'America/Los_Angeles')::date,
      entry_source = 'manager_edit',
      needs_correction = false
  WHERE id = _id;
  IF NOT FOUND THEN RAISE EXCEPTION 'time entry not found'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.void_time_entry(_id uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'a reason is required to void a time record';
  END IF;
  PERFORM set_config('app.edit_reason', _reason, true);
  UPDATE public.time_entries
  SET voided_at = now(), voided_by = auth.uid(), void_reason = btrim(_reason)
  WHERE id = _id AND voided_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'time entry not found (or already voided)'; END IF;
END $$;

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
  RETURN _new_id;
END $$;

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
  -- One recorded meal per manager fix: the earliest row carries the
  -- corrected span; any extra rows collapse to zero length (deducting
  -- nothing) so the audit keeps their history without double-counting.
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
END $$;

REVOKE ALL ON FUNCTION public.admin_update_time_entry(uuid, timestamptz, timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_time_entry(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_create_time_entry(uuid, timestamptz, timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_meal(uuid, timestamptz, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_time_entry(uuid, timestamptz, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_time_entry(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_time_entry(uuid, timestamptz, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_meal(uuid, timestamptz, timestamptz, text) TO authenticated;

-- ── 9) Pay engine v6: Mon–Sun workweek, CA overtime, meal premiums (F2, F3) ─
-- Return shape changes, so DROP first. Extra columns are additive for
-- existing readers (they index by name).

DROP FUNCTION IF EXISTS public.calc_weekly_paycheck(uuid, date);

CREATE FUNCTION public.calc_weekly_paycheck(_canvasser_id uuid, _week_start date)
 RETURNS TABLE(
   week_start date, week_end date,
   sits integer, points integer, sales integer, sale_price_total numeric,
   hours numeric, reg_hours numeric, ot_hours numeric, dt_hours numeric,
   hourly_rate numeric, regular_rate numeric,
   base_pay numeric, ot_premium_pay numeric,
   meal_premium_count integer, meal_premium_pay numeric,
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
  -- exceptions
  _sunday_hours numeric := 0; _auto_closed int := 0; _needs_corr int := 0;
  _meal_pending int := 0; _meal_unrecorded int := 0;
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

  SELECT COALESCE(SUM(l.sale_amount),0) INTO _sale_total
  FROM public.leads l
  WHERE l.canvasser_id=_canvasser_id AND l.status='confirmed'
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

  -- Meal premiums: one premium hour per day with a missed or late meal
  -- (LC 226.7; Donohue). 'pending'/'unrecorded' days pay no premium yet —
  -- they are run-review exceptions to resolve first.
  SELECT COUNT(*) INTO _meal_days FROM (
    SELECT te.log_date FROM public.time_entries te
    WHERE te.user_id = _canvasser_id
      AND te.log_date BETWEEN _week_start AND _week_end
      AND te.clock_out IS NOT NULL AND te.voided_at IS NULL
      AND te.meal_status IN ('missed', 'taken_late')
    GROUP BY te.log_date) md;

  SELECT COUNT(*) FILTER (WHERE te.entry_source = 'auto_closed'),
         COUNT(*) FILTER (WHERE te.needs_correction),
         COUNT(*) FILTER (WHERE te.meal_status = 'pending'),
         COUNT(*) FILTER (WHERE te.meal_status = 'unrecorded')
    INTO _auto_closed, _needs_corr, _meal_pending, _meal_unrecorded
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

  -- Regular rate of compensation for meal premiums (Ferra v. Loews:
  -- includes nondiscretionary payments, same blend as overtime).
  _reg_rate := CASE WHEN _hours > 0
                    THEN (_base + _flat_bonus + _commission) / _hours
                    ELSE _rate END;
  _meal_prem := _meal_days * _reg_rate;

  week_start := _week_start; week_end := _week_end;
  sits := _sits; points := _points; sales := _sales;
  sale_price_total := _sale_total;
  hours := _hours; reg_hours := _reg; ot_hours := _ot; dt_hours := _dt;
  hourly_rate := _rate; regular_rate := ROUND(_reg_rate, 4);
  base_pay := ROUND(_base, 2); ot_premium_pay := ROUND(_ot_prem, 2);
  meal_premium_count := _meal_days; meal_premium_pay := ROUND(_meal_prem, 2);
  commission_rate := _comm_rate; commission := ROUND(_commission, 2);
  sit_bonus := _sit_bonus; monster_bonus := _monster;
  total_pay := ROUND(_base + _ot_prem + _meal_prem + _commission + _sit_bonus + _monster, 2);
  rank := _rank;
  exceptions := jsonb_build_object(
    'sunday_hours', _sunday_hours,
    'auto_closed_entries', _auto_closed,
    'needs_correction', _needs_corr,
    'meal_pending', _meal_pending,
    'meal_unrecorded', _meal_unrecorded,
    'below_min_wage', (_rate < _min_wage)
  );
  RETURN NEXT;
END $function$;

REVOKE ALL ON FUNCTION public.calc_weekly_paycheck(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calc_weekly_paycheck(uuid, date) TO service_role;

-- ── 10) calc_monthly_paycheck: volume-bonus OT true-up ──────────────────────
-- The monthly $1,500/$100k volume bonus is nondiscretionary production pay;
-- when the month closes it must retro-raise the regular rate. Allocation:
-- bonus ÷ month total hours, +0.5x per OT hour and +1.0x per DT hour.

DROP FUNCTION IF EXISTS public.calc_monthly_paycheck(uuid, date);

CREATE FUNCTION public.calc_monthly_paycheck(
  _canvasser_id uuid,
  _month_start date
)
RETURNS TABLE(
  month_start date, month_end date,
  total_sits int, total_points int, total_sales int,
  sale_price_total numeric,
  weekly_pay_total numeric,
  volume_bonus numeric,
  volume_bonus_ot_true_up numeric,
  total_pay numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _month_end date := (date_trunc('month', _month_start) + interval '1 month - 1 day')::date;
  _weekly_total numeric := 0;
  _sale_total numeric := 0;
  _sits int := 0; _points int := 0; _sales int := 0;
  _volume numeric := 0;
  _true_up numeric := 0;
  _m_hours numeric := 0; _m_ot numeric := 0; _m_dt numeric := 0;
  _wk date;
  _row record;
BEGIN
  _wk := _month_start - ((EXTRACT(ISODOW FROM _month_start)::int - 1));
  WHILE _wk <= _month_end LOOP
    SELECT * INTO _row FROM public.calc_weekly_paycheck(_canvasser_id, _wk);
    IF _row.total_pay IS NOT NULL THEN
      _weekly_total := _weekly_total + _row.total_pay;
      _m_hours := _m_hours + COALESCE(_row.hours, 0);
      _m_ot := _m_ot + COALESCE(_row.ot_hours, 0);
      _m_dt := _m_dt + COALESCE(_row.dt_hours, 0);
    END IF;
    _wk := _wk + 7;
  END LOOP;

  SELECT
    COALESCE(SUM(dl.demos_sits), 0),
    COALESCE(SUM(dl.demos_sits + dl.sales), 0),
    COALESCE(SUM(dl.sales), 0)
  INTO _sits, _points, _sales
  FROM public.daily_logs dl
  WHERE dl.canvasser_id = _canvasser_id
    AND dl.log_date BETWEEN _month_start AND _month_end;

  SELECT COALESCE(SUM(l.sale_amount), 0)
  INTO _sale_total
  FROM public.leads l
  WHERE l.canvasser_id = _canvasser_id
    AND l.status = 'confirmed'
    AND (COALESCE(l.reviewed_at, l.created_at) AT TIME ZONE 'America/Los_Angeles')::date BETWEEN _month_start AND _month_end;

  _volume := FLOOR(_sale_total / 100000.0) * 1500;
  IF _volume > 0 AND _m_hours > 0 THEN
    _true_up := ROUND((_volume / _m_hours) * (0.5 * _m_ot + 1.0 * _m_dt), 2);
  END IF;

  month_start := _month_start;
  month_end := _month_end;
  total_sits := _sits;
  total_points := _points;
  total_sales := _sales;
  sale_price_total := _sale_total;
  weekly_pay_total := _weekly_total;
  volume_bonus := _volume;
  volume_bonus_ot_true_up := _true_up;
  total_pay := _weekly_total + _volume + _true_up;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.calc_monthly_paycheck(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calc_monthly_paycheck(uuid, date) TO service_role;

-- ── 11) Payroll runs: snapshot, approve, freeze (F8) ────────────────────────

CREATE TABLE public.payroll_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  week_start date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid,
  approved_at timestamptz,
  notes text
);
CREATE UNIQUE INDEX payroll_runs_one_per_week ON public.payroll_runs(week_start);

CREATE TABLE public.payroll_run_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  canvasser_id uuid NOT NULL,
  display_name text NOT NULL,        -- snapshot: names can change later
  rank text,
  hours numeric NOT NULL DEFAULT 0,
  reg_hours numeric NOT NULL DEFAULT 0,
  ot_hours numeric NOT NULL DEFAULT 0,
  dt_hours numeric NOT NULL DEFAULT 0,
  hourly_rate numeric NOT NULL DEFAULT 0,
  regular_rate numeric NOT NULL DEFAULT 0,
  base_pay numeric NOT NULL DEFAULT 0,
  ot_premium_pay numeric NOT NULL DEFAULT 0,
  meal_premium_count int NOT NULL DEFAULT 0,
  meal_premium_pay numeric NOT NULL DEFAULT 0,
  commission numeric NOT NULL DEFAULT 0,
  sit_bonus numeric NOT NULL DEFAULT 0,
  monster_bonus numeric NOT NULL DEFAULT 0,
  total_pay numeric NOT NULL DEFAULT 0,
  exceptions jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb   -- full engine row at freeze time
);
CREATE INDEX payroll_run_lines_run_idx ON public.payroll_run_lines(run_id);

GRANT SELECT ON public.payroll_runs, public.payroll_run_lines TO authenticated;
GRANT ALL ON public.payroll_runs, public.payroll_run_lines TO service_role;
ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_run_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "runs staff read" ON public.payroll_runs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

-- Workers see their own frozen lines — pay transparency (LC 226(b)).
CREATE POLICY "lines read own or staff" ON public.payroll_run_lines
  FOR SELECT TO authenticated
  USING (canvasser_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff'));

-- Approved runs are immutable: block any mutation of an approved run or its
-- lines at the database layer (service_role included — corrections are
-- next-run adjustments, never rewrites).
CREATE OR REPLACE FUNCTION public.guard_payroll_freeze()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE _status text; _run_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'payroll_runs' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.status = 'approved' THEN RAISE EXCEPTION 'approved payroll runs cannot be deleted'; END IF;
      RETURN OLD;
    END IF;
    IF OLD.status = 'approved' THEN
      RAISE EXCEPTION 'approved payroll runs are frozen';
    END IF;
    RETURN NEW;
  END IF;

  _run_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END;
  SELECT status INTO _status FROM public.payroll_runs WHERE id = _run_id;
  IF _status = 'approved' THEN
    RAISE EXCEPTION 'lines of an approved payroll run are frozen';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER payroll_runs_freeze
  BEFORE UPDATE OR DELETE ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.guard_payroll_freeze();
CREATE TRIGGER payroll_run_lines_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_run_lines
  FOR EACH ROW EXECUTE FUNCTION public.guard_payroll_freeze();

-- Snapshot a week into a draft run (replacing any prior draft for the week).
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
BEGIN
  IF NOT (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  DELETE FROM public.payroll_runs WHERE week_start = _week_start AND status = 'draft';
  IF EXISTS (SELECT 1 FROM public.payroll_runs WHERE week_start = _week_start) THEN
    RAISE EXCEPTION 'week % already has an approved run — corrections go on the next run', _week_start;
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
      commission, sit_bonus, monster_bonus, total_pay,
      exceptions, snapshot)
    VALUES (
      _run_id, _cid, COALESCE(_name, _cid::text), _pc.rank,
      _pc.hours, _pc.reg_hours, _pc.ot_hours, _pc.dt_hours,
      _pc.hourly_rate, _pc.regular_rate, _pc.base_pay, _pc.ot_premium_pay,
      _pc.meal_premium_count, _pc.meal_premium_pay,
      _pc.commission, _pc.sit_bonus, _pc.monster_bonus, _pc.total_pay,
      COALESCE(_pc.exceptions, '{}'::jsonb), to_jsonb(_pc));
  END LOOP;

  RETURN _run_id;
END $$;

CREATE OR REPLACE FUNCTION public.approve_payroll_run(_run_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _blockers int;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  -- Unresolved record problems block approval: fix the entries (or attest
  -- the meals) first, then re-create the draft to re-snapshot.
  SELECT COUNT(*) INTO _blockers
  FROM public.payroll_run_lines l
  WHERE l.run_id = _run_id
    AND (COALESCE((l.exceptions->>'needs_correction')::int, 0) > 0
      OR COALESCE((l.exceptions->>'meal_pending')::int, 0) > 0);
  IF _blockers > 0 THEN
    RAISE EXCEPTION '% line(s) still have unresolved corrections or unattested meals', _blockers;
  END IF;
  UPDATE public.payroll_runs
  SET status = 'approved', approved_by = auth.uid(), approved_at = now()
  WHERE id = _run_id AND status = 'draft';
  IF NOT FOUND THEN RAISE EXCEPTION 'run not found or already approved'; END IF;
END $$;

REVOKE ALL ON FUNCTION public.create_payroll_run(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_payroll_run(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_payroll_run(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_payroll_run(uuid) TO authenticated;

-- ── 12) Backfill: recompute every closed entry under the new rules ──────────
-- Historical shifts get their 30 minutes back; Sunday shifts get their
-- hours. Pre-migration entries never had meal punches or attestations, so
-- their status is set directly: not_required (≤5h) or unrecorded (>5h) —
-- 'unrecorded' pays in full, earns no premium, and does NOT block payroll
-- approval, which is the right posture for unknowable history.

UPDATE public.time_entries
SET meal_status = CASE
      WHEN EXTRACT(EPOCH FROM (clock_out - clock_in)) / 3600.0 > 5.0 THEN 'unrecorded'
      ELSE 'not_required'
    END,
    updated_at = now()
WHERE clock_out IS NOT NULL;
