-- ═══════════════════════════════════════════════════════════════════════════
-- HR RUNS PAYROLL (owner ask 2026-10-15: "can Zuleyma also approve payroll
-- runs? she might need that").
--
-- HR joins the payroll-run workflow: read the ledger and paycheck amounts,
-- create draft runs, approve/freeze them. REOPENING an approved run stays
-- OWNER-ONLY (it unlocks paid wage history — reopen_payroll_run untouched).
--
-- Also fixes two holes in the original HR access (found by inspection, not
-- yet reported by users):
--   · HR was missing from the profiles/teams/user_roles read policies, so
--     her timesheet surfaces would render without names.
--   · auto_archive_agents would have archived her after 14 days — a desk
--     role with no door metrics. HR joins the desk-role exemption.
--
-- Re-emitted full bodies (one auth-list change each):
--   calc_weekly_paycheck  v10 → v11  (20261023120000)
--   create_payroll_run    v6  → v7   (20261023120000)
--   approve_payroll_run   v3  → v4   (20261024120000)
--   auto_archive_agents   v4  → v5   (20261002170000)
-- Client mirrors in the same PR: PAYROLL_READ_ROLES + PAYROLL_RUN_ROLES
-- (role-policy.ts), the paycheck server fns, PayrollLedger buttons, HR nav.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) Read policies: HR joins the payroll-grade read set ────────────────────

DROP POLICY IF EXISTS "Managers view all profiles" ON public.profiles;
CREATE POLICY "Managers view all profiles"
  ON public.profiles FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'captain'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'bookkeeper'::app_role)
    OR public.has_role(auth.uid(), 'hr'::app_role)
  );

DROP POLICY IF EXISTS "Managers view all teams" ON public.teams;
CREATE POLICY "Managers view all teams"
  ON public.teams FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'captain'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'bookkeeper'::app_role)
    OR public.has_role(auth.uid(), 'hr'::app_role)
  );

DROP POLICY IF EXISTS "Managers read all roles" ON public.user_roles;
CREATE POLICY "Managers read all roles"
  ON public.user_roles FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'captain'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'bookkeeper'::app_role)
    OR public.has_role(auth.uid(), 'hr'::app_role)
  );

DROP POLICY IF EXISTS "leads read scoped" ON public.leads;
CREATE POLICY "leads read scoped"
  ON public.leads FOR SELECT
  USING (
    canvasser_id = auth.uid()
    OR public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'captain'::app_role)
    OR public.has_role(auth.uid(), 'bookkeeper'::app_role)
    OR public.has_role(auth.uid(), 'hr'::app_role)
  );

DROP POLICY IF EXISTS "daily_logs read scoped" ON public.daily_logs;
CREATE POLICY "daily_logs read scoped"
  ON public.daily_logs FOR SELECT
  USING (
    canvasser_id = auth.uid()
    OR public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'captain'::app_role)
    OR public.has_role(auth.uid(), 'bookkeeper'::app_role)
    OR public.has_role(auth.uid(), 'hr'::app_role)
  );

DROP POLICY IF EXISTS "runs staff read" ON public.payroll_runs;
CREATE POLICY "runs staff read" ON public.payroll_runs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'bookkeeper')
         OR public.has_role(auth.uid(), 'hr'));

DROP POLICY IF EXISTS "lines read own or staff" ON public.payroll_run_lines;
CREATE POLICY "lines read own or staff" ON public.payroll_run_lines
  FOR SELECT TO authenticated
  USING (canvasser_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'bookkeeper')
         OR public.has_role(auth.uid(), 'hr'));

DROP POLICY IF EXISTS "clawbacks read own or staff" ON public.commission_clawbacks;
CREATE POLICY "clawbacks read own or staff" ON public.commission_clawbacks
  FOR SELECT TO authenticated
  USING (canvasser_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'bookkeeper')
         OR public.has_role(auth.uid(), 'hr'));

-- ── 2) calc v11, create v7, approve v4: HR joins the run workflow ────────────

-- calc_weekly_paycheck v11 (identical to v10 except the HR read arm):

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
    OR public.has_role(auth.uid(), 'hr'::app_role)
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
  IF NOT (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
          OR public.has_role(auth.uid(), 'hr')) THEN
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

CREATE OR REPLACE FUNCTION public.approve_payroll_run(_run_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _flagged int; _meal_pending int; _open int; _ws date;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
          OR public.has_role(auth.uid(), 'hr')) THEN
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
  -- Blockers are counted LIVE (v2 read the draft's snapshotted exceptions,
  -- which drift the moment an entry changes after the draft was created).
  -- The draft's PAY figures can drift too — approving freezes the snapshot,
  -- so the error says to re-create when anything is unresolved.
  SELECT COUNT(*) FILTER (WHERE te.needs_correction),
         COUNT(*) FILTER (WHERE te.meal_status = 'pending')
    INTO _flagged, _meal_pending
  FROM public.time_entries te
  WHERE te.log_date BETWEEN _ws AND _ws + 6
    AND te.clock_out IS NOT NULL AND te.voided_at IS NULL;
  IF _flagged > 0 OR _meal_pending > 0 THEN
    RAISE EXCEPTION '% flagged entr(ies) and % unattested meal(s) in this week — resolve them, then RE-CREATE the draft so the snapshot is current, and approve that',
      _flagged, _meal_pending;
  END IF;
  UPDATE public.payroll_runs
  SET status = 'approved', approved_by = auth.uid(), approved_at = now()
  WHERE id = _run_id AND status = 'draft';
  IF NOT FOUND THEN RAISE EXCEPTION 'run not found or already approved'; END IF;
END $$;


-- ── 3) auto_archive_agents v5: HR joins the desk-role exemption ──────────────
-- (full body from 20261002170000; ONE list change — Zuleyma never knocks a
-- door, so "no door metrics" is her permanent, correct state.)

CREATE OR REPLACE FUNCTION public.auto_archive_agents()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _cutoff timestamptz := now() - interval '14 days';
  _archived integer := 0;
BEGIN
  -- Cron / service contexts carry no JWT. A signed-in user (any role) must
  -- not be able to fire a bulk archive sweep.
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'auto_archive_agents runs from cron/service contexts only';
  END IF;

  WITH last_activity AS (
    -- Time-clock punches count as activity alongside door metrics, so
    -- a working agent whose door counters lag (training days, ride-alongs)
    -- doesn't get archived — and, now that archive bans, locked out.
    SELECT user_id, MAX(last_date) AS last_date
    FROM (
      SELECT canvasser_id AS user_id, MAX(metric_date) AS last_date
      FROM public.daily_metrics GROUP BY 1
      UNION ALL
      SELECT user_id, MAX(clock_in)::date AS last_date
      FROM public.time_entries GROUP BY 1
    ) activity
    GROUP BY 1
  ),
  targets AS (
    SELECT p.id
    FROM public.profiles p
    LEFT JOIN last_activity la ON la.user_id = p.id
    WHERE p.is_active = true
      AND (
        (la.last_date IS NOT NULL AND la.last_date < (_cutoff)::date)
        OR (la.last_date IS NULL AND p.created_at < _cutoff)
      )
      -- Never archive owners.
      AND NOT public.has_role(p.id, 'owner'::app_role)
      -- Never auto-archive desk/closer roles — no door metrics is their
      -- permanent, correct state. Removing THEM is always a human action
      -- (Manage Players), which now also revokes their login. bookkeeper
      -- added 2026-10-02 (Mary); hr added 2026-10-15 (Zuleyma).
      AND NOT EXISTS (
        SELECT 1 FROM public.user_roles r
        WHERE r.user_id = p.id
          AND r.role IN ('sales_rep'::app_role, 'confirmer'::app_role,
                         'office_staff'::app_role, 'bookkeeper'::app_role,
                         'hr'::app_role)
      )
  )
  UPDATE public.profiles p
  SET is_active = false,
      team_id = NULL,
      updated_at = now()
  FROM targets t
  WHERE p.id = t.id;

  GET DIAGNOSTICS _archived = ROW_COUNT;
  RETURN _archived;
END $$;
