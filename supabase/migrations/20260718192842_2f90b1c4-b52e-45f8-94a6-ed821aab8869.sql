-- Pay rules correction (owner-confirmed 2026-07-18):
--   1) Clocked hours are paid IN FULL — the 7.5/6.5 daily caps are removed
--      (early training time etc. must be paid by law). A 30-minute lunch is
--      deducted from every closed shift (the UI always claimed this; now the
--      math does it). Sundays remain unpaid (owner decision) and the pay week
--      remains Mon–Sat.
--   2) Estimated hours are GONE: base pay comes only from clocked time.
--      Activity on a day no longer credits hours (a lead can land on a day
--      the canvasser did not work). No clock-in => no base pay. Hard cutover:
--      applies to historical weeks too (owner explicitly accepted past
--      unclocked weeks showing $0 base pay).
--   3) Existing closed time entries are recomputed under the new rules.

-- ── A) compute_time_entry_hours v2: no caps, 30-min lunch, Sunday unpaid ────
CREATE OR REPLACE FUNCTION public.compute_time_entry_hours()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _raw_hours numeric;
  _billable numeric;
  _dow int;
BEGIN
  IF NEW.clock_out IS NULL THEN
    NEW.billable_hours := 0;
    RETURN NEW;
  END IF;

  _raw_hours := EXTRACT(EPOCH FROM (NEW.clock_out - NEW.clock_in)) / 3600.0;
  IF _raw_hours < 0 THEN _raw_hours := 0; END IF;

  _dow := EXTRACT(ISODOW FROM NEW.log_date)::int;
  IF _dow = 7 THEN
    -- Sundays are unpaid (and outside the Mon–Sat pay week).
    _billable := 0;
  ELSE
    -- Full clocked time, minus a 30-minute lunch per shift. No daily cap.
    _billable := GREATEST(_raw_hours - 0.5, 0);
  END IF;

  NEW.billable_hours := ROUND(_billable::numeric, 2);
  RETURN NEW;
END $$;

-- ── B) Backfill: recompute every closed shift under the new rules ───────────
UPDATE public.time_entries SET updated_at = now() WHERE clock_out IS NOT NULL;

-- ── C) calc_weekly_paycheck v4: hours = clocked time only ───────────────────
--      The activity-based estimate branch is removed; everything else is
--      identical to v3 (20260718183328): points/tiers/commission/bonuses/
--      rank locks/pay-lock lifecycle/authorization unchanged.
CREATE OR REPLACE FUNCTION public.calc_weekly_paycheck(_canvasser_id uuid, _week_start date)
 RETURNS TABLE(week_start date, week_end date, sits integer, points integer, sales integer, sale_price_total numeric, hours numeric, hourly_rate numeric, base_pay numeric, commission_rate numeric, commission numeric, sit_bonus numeric, monster_bonus numeric, total_pay numeric, rank text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _week_end date := _week_start + 5;
  _sits int := 0; _points int := 0; _sales int := 0;
  _sale_total numeric := 0; _hours numeric := 0;
  _rate numeric := 18.00; _comm_rate numeric := 0.01;
  _sit_bonus numeric := 0; _monster numeric := 0;
  _commission numeric := 0; _base numeric := 0;
  _rank text; _sit_bonus_per numeric := 50;
  _pay_lock text := 'active';
BEGIN
  IF NOT (
    auth.uid() IS NULL
    OR auth.uid() = _canvasser_id
    OR public.has_role(auth.uid(), 'owner'::app_role)
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
    AND COALESCE(l.reviewed_at,l.created_at)::date BETWEEN _week_start AND _week_end;

  -- Base-pay hours come exclusively from clocked time. No clock-in, no base pay.
  SELECT COALESCE(SUM(te.billable_hours),0) INTO _hours
  FROM public.time_entries te
  WHERE te.user_id = _canvasser_id
    AND te.log_date BETWEEN _week_start AND _week_end
    AND te.clock_out IS NOT NULL;

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

  _base := _hours * _rate;
  _commission := _sale_total * _comm_rate;
  _sit_bonus := GREATEST(_sits - 3, 0) * _sit_bonus_per;
  _monster := CASE WHEN _points >= 10 THEN 500 ELSE 0 END;

  week_start := _week_start; week_end := _week_end;
  sits := _sits; points := _points; sales := _sales;
  sale_price_total := _sale_total; hours := _hours;
  hourly_rate := _rate; base_pay := _base;
  commission_rate := _comm_rate; commission := _commission;
  sit_bonus := _sit_bonus; monster_bonus := _monster;
  total_pay := _base + _commission + _sit_bonus + _monster;
  rank := _rank;
  RETURN NEXT;
END $function$;

REVOKE ALL ON FUNCTION public.calc_weekly_paycheck(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calc_weekly_paycheck(uuid, date) TO service_role;
