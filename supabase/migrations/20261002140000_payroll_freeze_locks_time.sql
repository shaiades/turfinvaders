-- ═══════════════════════════════════════════════════════════════════════════
-- PAYROLL FREEZE LOCKS TIME (owner-approved 2026-10-01).
--
-- Closes the biggest wage-records hole: approving a payroll run froze the
-- RUN, but the week's time_entries/meal_periods stayed editable, so the
-- live ledger could silently drift from the frozen snapshot that was paid.
-- From here:
--
--   1) An APPROVED week's punches are locked — the time guards reject every
--      non-service write ("owner must reopen the run").
--   2) Corrections go through an explicit, audited owner-only flow:
--      reopen_payroll_run(reason) → fix entries (reasoned RPCs) →
--      create_payroll_run (new draft) → approve again. The reopened run
--      stays forever as terminal history (revoke-not-delete); its lines
--      remain frozen.
--   3) approve_payroll_run refuses while the week still has OPEN shifts —
--      otherwise the auto-close cron (service context, guard-exempt) would
--      mutate an approved week after the fact.
--
-- Documented limitation: a reopened run stops acting as a clawback "paid"
-- source (the clawback pass keys on status='approved'). Prod has never used
-- runs; revisit if that changes before clawbacks meet reopens.
--
-- Replaces (full bodies, triggers unchanged):
--   guard_payroll_freeze    v1 → v2   (20260819120000)
--   guard_time_entry_write  v4 → v5   (20261002120000)
--   guard_meal_write        v2 → v3   (20261002120000)
--   approve_payroll_run     v1 → v2   (20260819120000)
--   create_payroll_run      v3 → v4   (20260913040000)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) payroll_runs: the 'reopened' terminal status ─────────────────────────

ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS reopened_by uuid,
  ADD COLUMN IF NOT EXISTS reopened_at timestamptz,
  ADD COLUMN IF NOT EXISTS reopen_reason text;

-- The status CHECK was inline at CREATE TABLE (auto-named) — drop by lookup.
DO $$
DECLARE _con text;
BEGIN
  SELECT conname INTO _con
  FROM pg_constraint
  WHERE conrelid = 'public.payroll_runs'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%';
  IF _con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.payroll_runs DROP CONSTRAINT %I', _con);
  END IF;
END $$;
ALTER TABLE public.payroll_runs ADD CONSTRAINT payroll_runs_status_check
  CHECK (status IN ('draft','approved','reopened'));

-- One LIVE run per week; reopened runs stay behind as history.
DROP INDEX IF EXISTS public.payroll_runs_one_per_week;
CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_one_live_per_week
  ON public.payroll_runs(week_start) WHERE status <> 'reopened';

-- ── 2) guard_payroll_freeze v2: the only exit from 'approved' is 'reopened' ─

CREATE OR REPLACE FUNCTION public.guard_payroll_freeze()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE _status text; _run_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'payroll_runs' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.status IN ('approved','reopened') THEN
        RAISE EXCEPTION 'approved payroll runs cannot be deleted';
      END IF;
      RETURN OLD;
    END IF;
    IF OLD.status = 'reopened' THEN
      RAISE EXCEPTION 'reopened payroll runs are terminal history — create a fresh draft instead';
    END IF;
    IF OLD.status = 'approved' THEN
      -- The one sanctioned transition: reopen_payroll_run sets the reason
      -- setting (unreachable via PostgREST) and the audit columns.
      IF NEW.status = 'reopened'
         AND NULLIF(current_setting('app.reopen_reason', true), '') IS NOT NULL THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'approved payroll runs are frozen — an owner must reopen the run';
    END IF;
    RETURN NEW;
  END IF;

  _run_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END;
  SELECT status INTO _status FROM public.payroll_runs WHERE id = _run_id;
  IF _status IN ('approved','reopened') THEN
    RAISE EXCEPTION 'lines of an approved payroll run are frozen';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

-- ── 3) The owner-only reopen (deliberately tighter than the Admin tier:
--       it unlocks wage history) ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reopen_payroll_run(_run_id uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'reopening approved payroll is owner-only';
  END IF;
  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'a reason is required to reopen approved payroll';
  END IF;
  PERFORM set_config('app.reopen_reason', btrim(_reason), true);
  UPDATE public.payroll_runs
  SET status = 'reopened',
      reopened_by = auth.uid(),
      reopened_at = now(),
      reopen_reason = btrim(_reason)
  WHERE id = _run_id AND status = 'approved';
  IF NOT FOUND THEN RAISE EXCEPTION 'run not found or not approved'; END IF;
END $$;

REVOKE ALL ON FUNCTION public.reopen_payroll_run(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_payroll_run(uuid, text) TO authenticated;

-- ── 4) week_is_frozen + the time guards enforce it ──────────────────────────

CREATE OR REPLACE FUNCTION public.week_is_frozen(_d date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.payroll_runs
    WHERE week_start = _d - (EXTRACT(ISODOW FROM _d)::int - 1)
      AND status = 'approved')
$$;

-- guard_time_entry_write v5: v4 (20261002120000) + the freeze lock. The
-- freeze check sits AFTER the pure-touch pass (harmless recompute pokes
-- stay harmless) and AFTER the auth NULL pass (cron/service exempt —
-- approve_payroll_run's open-shift blocker below keeps that honest).
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

-- guard_meal_write v3: v2 (20261002120000) + the freeze lock via the parent
-- entry's week.
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

-- ── 5) approve_payroll_run v2: no open shifts in an approved week ───────────

CREATE OR REPLACE FUNCTION public.approve_payroll_run(_run_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _blockers int; _open int; _ws date;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  SELECT week_start INTO _ws FROM public.payroll_runs WHERE id = _run_id;
  IF _ws IS NULL THEN RAISE EXCEPTION 'run not found'; END IF;
  -- An open shift would be closed LATER by the auto-close cron — a service
  -- write the freeze guards exempt — silently changing an approved week.
  SELECT COUNT(*) INTO _open
  FROM public.time_entries te
  WHERE te.log_date BETWEEN _ws AND _ws + 6
    AND te.clock_out IS NULL AND te.voided_at IS NULL;
  IF _open > 0 THEN
    RAISE EXCEPTION '% open shift(s) in this week — close them before approving', _open;
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

-- ── 6) create_payroll_run v4: two changes over v3 (20260913040000) ──────────
--       · the approved-week check ignores reopened runs (the one-live-run
--         index enforces the same rule at the storage layer)
--       · each line's exceptions carry the worker's attestation state
--         ('confirmed' / 'disputed' / 'none' — 20261002130000), run-review
--         chips only, never an approval blocker

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
