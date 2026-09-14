-- ═══════════════════════════════════════════════════════════════════════════
-- PAY-ENGINE CLAWBACK FOR CANCELLED SALES (2026-09-13).
-- PR #203/#204 made WCC cancellations visible to canvassers
-- (leads.sale_cancelled_at); the pay engine still paid them. Prod audit
-- today: 22 confirmed-cancelled sales totalling ~$577k volume, and e.g. the
-- week of 8/31 was paying $682 commission on the cancelled $68,200 Dang sale.
-- payroll_runs is EMPTY in prod (the office pays off the live-ledger CSV;
-- the draft→approve→freeze flow has never been used), so the widening has
-- two halves with different urgency:
--
--  A) ENGINE TRUTH (bites immediately): calc_weekly_paycheck v7 and
--     calc_monthly_paycheck exclude sale_cancelled_at sales from commission
--     and the monthly volume bonus. Because nothing is frozen, live
--     recomputes of past weeks drop those commissions too — the ledger UI
--     itemizes the excluded sales so the office can reconcile checks it
--     already cut by hand (they were paid outside the system; no snapshot
--     exists to claw from automatically — "never invent numbers").
--
--  B) CROSS-WEEK CLAWBACK (dormant until runs freeze): a sale paid in an
--     APPROVED run and cancelled later generates an itemized negative
--     commission_adjustment on the next draft run, ledgered per lead in
--     commission_clawbacks. Corrections stay next-run adjustments — approved
--     runs are never rewritten (guard_payroll_freeze doctrine).
--
-- POLICY GUARDRAILS (CA wage law — deliberately the conservative posture):
--  · Clawback recovers from COMMISSION ONLY: the deduction on any draft is
--    capped at that week's commission earnings (commission chargebacks are
--    enforceable against commissions; deducting them from base wages is
--    not a fight worth having — Barnhill/LC 221-224 territory). The
--    unrecovered remainder stays outstanding and is retried on later runs;
--    the commission_clawback_outstanding view surfaces it for the office.
--  · Principal only: the OT-premium and meal-premium share the original
--    commission fed (DLSE 49.2.4 / Ferra blends) is NOT recovered —
--    under-recovery in the worker's favor, never over-recovery.
--  · A healed stamp (Can/Save rescue, label fix) generates the symmetric
--    refund of whatever was actually clawed on approved runs.
--  · Wage-statement itemization (LC 226(b)): the deduction is its own
--    payroll_run_lines.commission_adjustment column + per-lead ledger rows
--    readable by the worker, never a silent commission rewrite.
--  · The paid amount is read from the APPROVED run line's snapshot
--    commission_rate — what was actually paid, never a recomputation.
--  · Timing guard sale_cancelled_at > run.created_at: a sale already
--    stamped when the draft was snapshotted was never paid (v7 excluded
--    it), so it must never be clawed.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) Itemized adjustment column (additive; frozen CSV exports it) ─────────
ALTER TABLE public.payroll_run_lines
  ADD COLUMN IF NOT EXISTS commission_adjustment numeric NOT NULL DEFAULT 0;

-- ── 2) Per-lead clawback ledger ─────────────────────────────────────────────
CREATE TABLE public.commission_clawbacks (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  line_id uuid NOT NULL REFERENCES public.payroll_run_lines(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  canvasser_id uuid NOT NULL,
  -- The approved run whose line paid this commission (NULL on reversals —
  -- a refund nets across every prior claw of the lead).
  source_run_id uuid REFERENCES public.payroll_runs(id),
  kind text NOT NULL CHECK (kind IN ('clawback', 'reversal')),
  amount numeric NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commission_clawbacks_lead_idx ON public.commission_clawbacks(lead_id);
CREATE INDEX commission_clawbacks_run_idx ON public.commission_clawbacks(run_id);

GRANT SELECT ON public.commission_clawbacks TO authenticated;
GRANT ALL ON public.commission_clawbacks TO service_role;
ALTER TABLE public.commission_clawbacks ENABLE ROW LEVEL SECURITY;

-- Workers see their own deduction detail (LC 226(b)); staff see all.
CREATE POLICY "clawbacks read own or staff" ON public.commission_clawbacks
  FOR SELECT TO authenticated
  USING (canvasser_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff'));

-- Ledger rows are immutable, and rows of an approved run are frozen like the
-- run's lines. A missing parent run means a draft cascade-delete in flight —
-- allowed (approved runs cannot be deleted, so that path can't occur).
CREATE OR REPLACE FUNCTION public.guard_clawback_ledger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE _status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'clawback ledger rows are immutable';
  END IF;
  SELECT status INTO _status FROM public.payroll_runs
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END;
  IF TG_OP = 'INSERT' THEN
    IF _status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'clawback rows attach to draft runs only';
    END IF;
    RETURN NEW;
  END IF;
  IF _status = 'approved' THEN
    RAISE EXCEPTION 'clawback rows of an approved run are frozen';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER commission_clawbacks_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.commission_clawbacks
  FOR EACH ROW EXECUTE FUNCTION public.guard_clawback_ledger();

-- ── 3) calc_weekly_paycheck v7: cancelled sales pay no commission ───────────
--       Identical to v6 (20260819120000) except the sale_cancelled_at
--       exclusion (and its comment). Return shape unchanged.
CREATE OR REPLACE FUNCTION public.calc_weekly_paycheck(_canvasser_id uuid, _week_start date)
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

-- ── 4) calc_monthly_paycheck: cancelled sales earn no volume bonus ──────────
--       Identical to 20260819120000 except the sale_cancelled_at exclusion.
CREATE OR REPLACE FUNCTION public.calc_monthly_paycheck(
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

  -- Cancelled sales earn no volume bonus (same exclusion as the weekly
  -- commission — see calc_weekly_paycheck v7).
  SELECT COALESCE(SUM(l.sale_amount), 0)
  INTO _sale_total
  FROM public.leads l
  WHERE l.canvasser_id = _canvasser_id
    AND l.status = 'confirmed'
    AND l.sale_cancelled_at IS NULL
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

-- ── 5) create_payroll_run v3: clawback + reversal pass on every draft ───────
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

REVOKE ALL ON FUNCTION public.calc_weekly_paycheck(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calc_weekly_paycheck(uuid, date) TO service_role;
REVOKE ALL ON FUNCTION public.calc_monthly_paycheck(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calc_monthly_paycheck(uuid, date) TO service_role;
REVOKE ALL ON FUNCTION public.create_payroll_run(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_payroll_run(date) TO authenticated;

-- ── 6) Outstanding view for run review ──────────────────────────────────────
-- 'collect': paid-but-cancelled commission not yet recovered.
-- 'refund':  approved-run claws on a since-healed lead not yet refunded.
-- security_invoker: readers hit leads/payroll RLS as themselves — staff see
-- everything, a worker sees at most their own rows.
CREATE OR REPLACE VIEW public.commission_clawback_outstanding
WITH (security_invoker = on) AS
SELECT
  'collect'::text AS direction,
  l.id AS lead_id,
  l.canvasser_id,
  p.display_name,
  l.customer_name,
  l.sale_amount,
  r0.week_start AS paid_week,
  ROUND(l.sale_amount * COALESCE((prl.snapshot->>'commission_rate')::numeric, 0), 2) AS paid_commission,
  COALESCE(led.net, 0) AS recovered,
  ROUND(l.sale_amount * COALESCE((prl.snapshot->>'commission_rate')::numeric, 0), 2)
    - COALESCE(led.net, 0) AS outstanding
FROM public.leads l
JOIN public.payroll_runs r0
  ON r0.status = 'approved'
 AND r0.week_start = (date_trunc('week',
       ((COALESCE(l.reviewed_at, l.created_at) AT TIME ZONE 'America/Los_Angeles')::date)::timestamp))::date
JOIN public.payroll_run_lines prl
  ON prl.run_id = r0.id AND prl.canvasser_id = l.canvasser_id
LEFT JOIN public.profiles p ON p.id = l.canvasser_id
LEFT JOIN LATERAL (
  SELECT ROUND(SUM(CASE WHEN cc.kind = 'clawback' THEN cc.amount ELSE -cc.amount END), 2) AS net
  FROM public.commission_clawbacks cc WHERE cc.lead_id = l.id
) led ON true
WHERE l.status = 'confirmed'
  AND l.sale_cancelled_at IS NOT NULL
  AND l.sale_cancelled_at > r0.created_at
  AND COALESCE(l.sale_amount, 0) > 0
  AND ROUND(l.sale_amount * COALESCE((prl.snapshot->>'commission_rate')::numeric, 0), 2)
      - COALESCE(led.net, 0) > 0.005
UNION ALL
SELECT
  'refund'::text,
  l.id,
  l.canvasser_id,
  p.display_name,
  l.customer_name,
  l.sale_amount,
  NULL::date,
  NULL::numeric,
  led.net,
  led.net
FROM public.leads l
JOIN LATERAL (
  SELECT ROUND(SUM(CASE WHEN cc.kind = 'clawback' THEN cc.amount ELSE -cc.amount END), 2) AS net
  FROM public.commission_clawbacks cc
  JOIN public.payroll_runs cr ON cr.id = cc.run_id AND cr.status = 'approved'
  WHERE cc.lead_id = l.id
) led ON led.net > 0.005
LEFT JOIN public.profiles p ON p.id = l.canvasser_id
WHERE l.sale_cancelled_at IS NULL;

GRANT SELECT ON public.commission_clawback_outstanding TO authenticated;
