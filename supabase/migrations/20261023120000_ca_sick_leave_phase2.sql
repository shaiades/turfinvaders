-- ═══════════════════════════════════════════════════════════════════════════
-- CA COMPLIANCE PHASE 2 — PAID SICK LEAVE + ATTENDANCE
-- (owner ask 2026-10-14: "mark people out sick, excused or unexcused…
-- compliant for California HR").
--
-- 1) PAID SICK LEAVE (LC 245.5 / SB 616, 2024). Sick marks existed but paid
--    nothing and tracked nothing. Now:
--      · sick_leave_ledger — append-only hour ledger. Accrual: 1 hour per
--        30 billable hours, per completed Mon–Sun week, bank capped at 80
--        hours (the statutory carryover cap). A weekly cron accrues; this
--        migration backfills accruals for 2026 weeks (earlier true-ups are
--        an owner/accountant decision — add 'adjustment' rows).
--      · Using it: an APPROVED 'sick' day gets paid_hours stamped at
--        approval time — the worker's average day length over the prior 90
--        days (default 8h, capped at 8h), clamped to the remaining balance
--        and the 40-hour annual use cap, zero inside the first 90 days of
--        employment (LC 246(d)). A 'usage' ledger row draws it down;
--        cancelling the absence writes a 'reversal'.
--      · calc_weekly_paycheck v10 pays sick hours at the week's regular
--        rate of compensation (the same Ferra blend as premiums, floored
--        at the tier hourly rate) — sick hours are NOT hours worked: no
--        overtime, no accrual on them.
--      · Balance rides the paycheck: exceptions.sick_balance on every run
--        line (LC 246(i) — the balance must reach the pay stub) and the
--        sick_leave_balances view for the UI/CSV.
--
-- 2) 'unexcused' joins the absence kinds (owner ask): distinct from
--    no_show (vanished, no contact) — present-tense HR language for an
--    absence that was reported but not excused. Workers cannot claim it
--    about themselves; captains (own team) and Admins record it.
--
-- Replaces (full bodies):
--   submit_day_off        v1 → v2   (20261002180000)
--   review_day_off        v1 → v2   (20261002180000)
--   cancel_day_off        v1 → v2   (20261002180000)
--   calc_weekly_paycheck  v9 → v10  (20261022120000; DROP — new columns)
--   create_payroll_run    v5 → v6   (20261022120000)
-- Mirrors to keep in step: src/lib/fleet.functions.ts (PaycheckRow),
-- src/hooks/useDayOff.ts (kinds), src/integrations/supabase/types.ts.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) Schema ────────────────────────────────────────────────────────────────

ALTER TABLE public.day_off_requests DROP CONSTRAINT day_off_requests_kind_check;
ALTER TABLE public.day_off_requests ADD CONSTRAINT day_off_requests_kind_check
  CHECK (kind IN ('day_off','sick','no_show','excused','unexcused','other'));

-- Paid sick hours stamped at approval; NULL = no paid component (unpaid
-- sick, or pre-feature history).
ALTER TABLE public.day_off_requests
  ADD COLUMN IF NOT EXISTS paid_hours numeric;

CREATE TABLE IF NOT EXISTS public.sick_leave_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  entry_date date NOT NULL,              -- LA calendar day the hours apply to
  week_start date,                        -- accruals: the earning week's Monday
  kind text NOT NULL CHECK (kind IN ('accrual','usage','reversal','adjustment')),
  hours numeric NOT NULL,                -- + grants, − draws
  absence_id uuid REFERENCES public.day_off_requests(id),
  note text,
  created_by uuid,                       -- NULL = system (cron/migration)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sick_leave_ledger_user_idx
  ON public.sick_leave_ledger(user_id, entry_date);
-- One accrual per person per earning week — the idempotency key the cron
-- and the backfill both lean on.
CREATE UNIQUE INDEX IF NOT EXISTS sick_leave_ledger_one_accrual
  ON public.sick_leave_ledger(user_id, week_start) WHERE kind = 'accrual';

GRANT SELECT ON public.sick_leave_ledger TO authenticated;
GRANT ALL ON public.sick_leave_ledger TO service_role;
ALTER TABLE public.sick_leave_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sick ledger read own or staff" ON public.sick_leave_ledger
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper'));
-- No client write policies: the definer functions below are the write path.

-- Balance rollup (security_invoker: RLS decides who sees whom). Usage is
-- stored negative; 'used' columns read positive for humans.
CREATE OR REPLACE VIEW public.sick_leave_balances
WITH (security_invoker = on) AS
SELECT l.user_id,
       ROUND(COALESCE(SUM(l.hours) FILTER (WHERE l.kind IN ('accrual','adjustment')), 0), 2)
         AS accrued_hours,
       ROUND(COALESCE(-SUM(l.hours) FILTER (WHERE l.kind IN ('usage','reversal')), 0), 2)
         AS used_hours,
       ROUND(COALESCE(SUM(l.hours), 0), 2) AS balance_hours,
       ROUND(COALESCE(-SUM(l.hours) FILTER (
               WHERE l.kind IN ('usage','reversal')
                 AND l.entry_date >= date_trunc('year',
                       (now() AT TIME ZONE 'America/Los_Angeles'))::date), 0), 2)
         AS used_this_year
FROM public.sick_leave_ledger l
GROUP BY l.user_id;

GRANT SELECT ON public.sick_leave_balances TO authenticated;

-- ── 2) Policy knobs (one place to change; mirrored nowhere) ──────────────────
--   accrual 1h/30h · bank cap 80h · annual USE cap 40h · 90-day wait ·
--   a paid sick day maxes at 8 hours.

CREATE OR REPLACE FUNCTION public.sick_balance(_user_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(SUM(hours), 0) FROM public.sick_leave_ledger WHERE user_id = _user_id
$$;

-- Hours a 'sick' day pays for this worker on this date: average worked-day
-- length over the prior 90 days (default 8h when there's no history, never
-- more than 8h), clamped to the remaining balance and the 40h/year use cap;
-- zero inside the first 90 days of employment (profiles.created_at).
CREATE OR REPLACE FUNCTION public.compute_sick_paid_hours(_user_id uuid, _d date)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  _hired timestamptz;
  _avg numeric;
  _balance numeric;
  _used_year numeric;
  _allowed numeric;
BEGIN
  SELECT created_at INTO _hired FROM public.profiles WHERE id = _user_id;
  IF _hired IS NULL OR _d < (_hired AT TIME ZONE 'America/Los_Angeles')::date + 90 THEN
    RETURN 0;
  END IF;

  SELECT AVG(day_h) INTO _avg FROM (
    SELECT SUM(te.billable_hours) AS day_h
    FROM public.time_entries te
    WHERE te.user_id = _user_id
      AND te.log_date >= _d - 90 AND te.log_date < _d
      AND te.clock_out IS NOT NULL AND te.voided_at IS NULL
    GROUP BY te.log_date
    HAVING SUM(te.billable_hours) > 0) days;
  _avg := LEAST(COALESCE(_avg, 8), 8);

  _balance := public.sick_balance(_user_id);
  SELECT COALESCE(-SUM(hours), 0) INTO _used_year
  FROM public.sick_leave_ledger
  WHERE user_id = _user_id AND kind IN ('usage','reversal')
    AND entry_date >= date_trunc('year', _d::timestamp)::date;

  _allowed := LEAST(_avg, _balance, 40 - _used_year);
  RETURN GREATEST(ROUND(_allowed, 2), 0);
END $$;

REVOKE ALL ON FUNCTION public.sick_balance(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.compute_sick_paid_hours(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sick_balance(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compute_sick_paid_hours(uuid, date) TO authenticated;

-- Stamp a freshly APPROVED sick row with its paid hours + the usage draw.
-- Internal: called by submit_day_off / review_day_off below.
CREATE OR REPLACE FUNCTION public.apply_sick_usage(_absence_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row record;
  _paid numeric;
BEGIN
  SELECT id, user_id, absence_date, kind, status, paid_hours INTO _row
  FROM public.day_off_requests WHERE id = _absence_id;
  IF _row.id IS NULL OR _row.kind <> 'sick' OR _row.status <> 'approved' THEN RETURN; END IF;
  IF _row.paid_hours IS NOT NULL THEN RETURN; END IF;  -- already applied

  _paid := public.compute_sick_paid_hours(_row.user_id, _row.absence_date);
  UPDATE public.day_off_requests SET paid_hours = _paid WHERE id = _absence_id;
  IF _paid > 0 THEN
    INSERT INTO public.sick_leave_ledger
      (user_id, entry_date, kind, hours, absence_id, note, created_by)
    VALUES
      (_row.user_id, _row.absence_date, 'usage', -_paid, _absence_id,
       'paid sick day', auth.uid());
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.apply_sick_usage(uuid) FROM PUBLIC, anon, authenticated;

-- ── 3) Weekly accrual (cron + 2026 backfill) ─────────────────────────────────
-- 1 hour per 30 billable hours per COMPLETED Mon–Sun week, chronological so
-- the 80-hour bank cap clamps correctly. Idempotent per (user, week): safe
-- to run any time, from the Monday cron or by hand after corrections.

CREATE OR REPLACE FUNCTION public.accrue_sick_leave()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _rec record;
  _accrue numeric;
  _balance numeric;
  _today_la date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  _rows int := 0;
BEGIN
  -- Cron / service / migration contexts only.
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'accrue_sick_leave runs from cron/service contexts only';
  END IF;

  FOR _rec IN
    SELECT te.user_id,
           (te.log_date - (EXTRACT(ISODOW FROM te.log_date)::int - 1)) AS wk,
           SUM(te.billable_hours) AS hours
    FROM public.time_entries te
    WHERE te.clock_out IS NOT NULL
      AND te.voided_at IS NULL
      -- Sick leave launches with 2026 (owner note: earlier true-ups are
      -- 'adjustment' rows, an accountant decision, not an auto-backfill).
      AND te.log_date >= DATE '2026-01-05'
      -- Completed weeks only: the week's Sunday is behind LA today.
      AND (te.log_date - (EXTRACT(ISODOW FROM te.log_date)::int - 1)) + 6 < _today_la
    GROUP BY te.user_id, wk
    HAVING SUM(te.billable_hours) > 0
    ORDER BY wk
  LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM public.sick_leave_ledger l
                 WHERE l.user_id = _rec.user_id AND l.kind = 'accrual'
                   AND l.week_start = _rec.wk) THEN
        CONTINUE;
      END IF;
      _balance := public.sick_balance(_rec.user_id);
      _accrue := LEAST(ROUND(_rec.hours / 30.0, 2), GREATEST(80 - _balance, 0));
      IF _accrue <= 0 THEN
        -- Bank is at the 80h cap: record a zero-hour row so the week is
        -- marked processed and never re-examined.
        _accrue := 0;
      END IF;
      INSERT INTO public.sick_leave_ledger
        (user_id, entry_date, week_start, kind, hours, note)
      VALUES
        (_rec.user_id, _rec.wk + 6, _rec.wk, 'accrual', _accrue,
         ROUND(_rec.hours, 2) || 'h worked ÷ 30');
      _rows := _rows + 1;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- one bad row must never kill the sweep
    END;
  END LOOP;
  RETURN _rows;
END $$;

REVOKE ALL ON FUNCTION public.accrue_sick_leave() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accrue_sick_leave() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sick-leave-accrual') THEN
    PERFORM cron.unschedule('sick-leave-accrual');
  END IF;
  -- Mondays 12:00 UTC (4–5 AM LA): the finished week accrues before anyone
  -- marks a Monday sick day against it.
  PERFORM cron.schedule(
    'sick-leave-accrual',
    '0 12 * * 1',
    $CRON$ SELECT public.accrue_sick_leave(); $CRON$
  );
END $$;

-- Backfill: accrue every completed 2026 week now, so balances exist the
-- moment the feature lands.
SELECT public.accrue_sick_leave();

-- ── 4) Absence RPCs v2: 'unexcused', paid sick wiring ────────────────────────

CREATE OR REPLACE FUNCTION public.submit_day_off(
  _user_id uuid, _dates date[], _kind text, _reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _is_admin boolean := public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff');
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
  _is_admin boolean := public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff');
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
  _is_admin boolean := public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff');
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

-- ── 5) calc v10: sick pay joins the paycheck ─────────────────────────────────

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
   sick_hours numeric, sick_pay numeric,
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
  _sick_hours numeric := 0; _sick_pay numeric := 0; _sick_days int := 0;
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

  -- Paid sick leave (LC 245.5): approved sick days with paid_hours stamped
  -- at approval (balance/caps applied there). Sick hours are not hours
  -- worked — no overtime, no accrual on them.
  SELECT COALESCE(SUM(r.paid_hours), 0), COUNT(*) INTO _sick_hours, _sick_days
  FROM public.day_off_requests r
  WHERE r.user_id = _canvasser_id
    AND r.absence_date BETWEEN _week_start AND _week_end
    AND r.kind = 'sick' AND r.status = 'approved'
    AND COALESCE(r.paid_hours, 0) > 0;

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

  -- Sick pay: LC 246(l) wants the regular rate of pay for the workweek —
  -- the same blend, floored at the tier hourly rate (an all-sick week has
  -- no blend to read).
  _sick_pay := _sick_hours * GREATEST(_reg_rate, _rate);

  week_start := _week_start; week_end := _week_end;
  sits := _sits; points := _points; sales := _sales;
  sale_price_total := _sale_total;
  hours := _hours; reg_hours := _reg; ot_hours := _ot; dt_hours := _dt;
  hourly_rate := _rate; regular_rate := ROUND(_reg_rate, 4);
  base_pay := ROUND(_base, 2); ot_premium_pay := ROUND(_ot_prem, 2);
  meal_premium_count := _meal_days; meal_premium_pay := ROUND(_meal_prem, 2);
  rest_premium_count := _rest_days; rest_premium_pay := ROUND(_rest_prem, 2);
  sick_hours := ROUND(_sick_hours, 2); sick_pay := ROUND(_sick_pay, 2);
  commission_rate := _comm_rate; commission := ROUND(_commission, 2);
  sit_bonus := _sit_bonus; monster_bonus := _monster;
  total_pay := ROUND(_base + _ot_prem + _meal_prem + _rest_prem + _sick_pay
                     + _commission + _sit_bonus + _monster, 2);
  rank := _rank;
  exceptions := jsonb_build_object(
    'sunday_hours', _sunday_hours,
    'auto_closed_entries', _auto_closed,
    'needs_correction', _needs_corr,
    'meal_pending', _meal_pending,
    'meal_unrecorded', _meal_unrecorded,
    'second_meal_missed', _second_meal_missed,
    'rest_pending', _rest_pending,
    'sick_days', _sick_days,
    'below_min_wage', (_rate < _min_wage)
  );
  RETURN NEXT;
END $function$;

REVOKE ALL ON FUNCTION public.calc_weekly_paycheck(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calc_weekly_paycheck(uuid, date) TO service_role;

-- ── 6) create_payroll_run v6: snapshot sick columns + the stub balance ───────
-- Identical to v5 (20261022120000) except: sick_hours/sick_pay line columns,
-- paid-sick workers join the roster, and every line's exceptions carry
-- 'sick_balance' (LC 246(i): the available balance must reach the pay stub).

ALTER TABLE public.payroll_run_lines
  ADD COLUMN IF NOT EXISTS sick_hours numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sick_pay numeric NOT NULL DEFAULT 0;

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
      UNION
      -- Paid sick days with no other activity still produce a paycheck.
      SELECT r.user_id FROM public.day_off_requests r
       WHERE r.absence_date BETWEEN _week_start AND _week_end
         AND r.kind = 'sick' AND r.status = 'approved'
         AND COALESCE(r.paid_hours, 0) > 0
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
      sick_hours, sick_pay,
      commission, sit_bonus, monster_bonus, total_pay,
      exceptions, snapshot)
    VALUES (
      _run_id, _cid, COALESCE(_name, _cid::text), _pc.rank,
      _pc.hours, _pc.reg_hours, _pc.ot_hours, _pc.dt_hours,
      _pc.hourly_rate, _pc.regular_rate, _pc.base_pay, _pc.ot_premium_pay,
      _pc.meal_premium_count, _pc.meal_premium_pay,
      _pc.rest_premium_count, _pc.rest_premium_pay,
      _pc.sick_hours, _pc.sick_pay,
      _pc.commission, _pc.sit_bonus, _pc.monster_bonus, _pc.total_pay,
      COALESCE(_pc.exceptions, '{}'::jsonb), to_jsonb(_pc));
  END LOOP;

  -- Worker sign-off state + the pay-stub sick balance on every line.
  UPDATE public.payroll_run_lines l
  SET exceptions = l.exceptions
        || jsonb_build_object(
             'attestation',
             COALESCE((SELECT a.status FROM public.time_week_attestations a
                       WHERE a.user_id = l.canvasser_id
                         AND a.week_start = _week_start
                         AND a.superseded_at IS NULL), 'none'))
        || jsonb_build_object('sick_balance', public.sick_balance(l.canvasser_id))
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
