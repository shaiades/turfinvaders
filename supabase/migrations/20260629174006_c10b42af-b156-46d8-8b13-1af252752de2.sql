-- Paycheck Engine: California Pay Structure
-- Points: PM=1, SALE=2 (derived from daily_logs.demos_sits & sales where sales counts both)
-- Note: in our schema, a SALE increments both demos_sits and sales, so:
--   sits_count   = demos_sits
--   points       = (demos_sits - sales) * 1 + sales * 2  = demos_sits + sales
--   sales_count  = sales

-- ============ Weekly paycheck calculator ============
CREATE OR REPLACE FUNCTION public.calc_weekly_paycheck(
  _canvasser_id uuid,
  _week_start date  -- Monday
)
RETURNS TABLE(
  week_start date,
  week_end date,
  sits int,
  points int,
  sales int,
  sale_price_total numeric,
  hours numeric,
  hourly_rate numeric,
  base_pay numeric,
  commission_rate numeric,
  commission numeric,
  sit_bonus numeric,
  monster_bonus numeric,
  total_pay numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _week_end date := _week_start + 5; -- Mon..Sat
  _sits int := 0;
  _points int := 0;
  _sales int := 0;
  _sale_total numeric := 0;
  _hours numeric := 0;
  _rate numeric := 18.00;
  _comm_rate numeric := 0.01;
  _sit_bonus numeric := 0;
  _monster numeric := 0;
  _commission numeric := 0;
  _base numeric := 0;
BEGIN
  -- Aggregate sits / points / sales from daily_logs (Mon..Sat)
  SELECT
    COALESCE(SUM(dl.demos_sits), 0),
    COALESCE(SUM(dl.demos_sits + dl.sales), 0),
    COALESCE(SUM(dl.sales), 0)
  INTO _sits, _points, _sales
  FROM public.daily_logs dl
  WHERE dl.canvasser_id = _canvasser_id
    AND dl.log_date BETWEEN _week_start AND _week_end;

  -- Sale price revenue from confirmed leads in same window
  SELECT COALESCE(SUM(l.sale_amount), 0)
  INTO _sale_total
  FROM public.leads l
  WHERE l.canvasser_id = _canvasser_id
    AND l.status = 'confirmed'
    AND COALESCE(l.reviewed_at, l.created_at)::date BETWEEN _week_start AND _week_end;

  -- Auto hours: 7.5 Mon-Fri, 6.5 Sat for any day with activity
  SELECT COALESCE(SUM(
    CASE
      WHEN EXTRACT(ISODOW FROM dl.log_date) BETWEEN 1 AND 5 THEN 7.5
      WHEN EXTRACT(ISODOW FROM dl.log_date) = 6 THEN 6.5
      ELSE 0
    END
  ), 0)
  INTO _hours
  FROM public.daily_logs dl
  WHERE dl.canvasser_id = _canvasser_id
    AND dl.log_date BETWEEN _week_start AND _week_end
    AND (COALESCE(dl.leads_called_in,0) + COALESCE(dl.confirmed_leads,0)
       + COALESCE(dl.demos_sits,0) + COALESCE(dl.sales,0)
       + COALESCE(dl.people_talked_to,0)) > 0;

  -- Hourly tier by points
  IF _points >= 7 THEN _rate := 35.00;
  ELSIF _points >= 3 THEN _rate := 30.00;
  ELSE _rate := 18.00;
  END IF;

  -- Commission tier by points
  IF _points >= 7 THEN _comm_rate := 0.02; ELSE _comm_rate := 0.01; END IF;

  _base       := _hours * _rate;
  _commission := _sale_total * _comm_rate;
  _sit_bonus  := GREATEST(_sits - 3, 0) * 50;
  _monster    := CASE WHEN _points >= 10 THEN 500 ELSE 0 END;

  week_start := _week_start;
  week_end := _week_end;
  sits := _sits;
  points := _points;
  sales := _sales;
  sale_price_total := _sale_total;
  hours := _hours;
  hourly_rate := _rate;
  base_pay := _base;
  commission_rate := _comm_rate;
  commission := _commission;
  sit_bonus := _sit_bonus;
  monster_bonus := _monster;
  total_pay := _base + _commission + _sit_bonus + _monster;
  RETURN NEXT;
END $$;

GRANT EXECUTE ON FUNCTION public.calc_weekly_paycheck(uuid, date) TO authenticated, service_role;

-- ============ Monthly paycheck (adds Volume Bonus) ============
CREATE OR REPLACE FUNCTION public.calc_monthly_paycheck(
  _canvasser_id uuid,
  _month_start date -- first day of month
)
RETURNS TABLE(
  month_start date,
  month_end date,
  total_sits int,
  total_points int,
  total_sales int,
  sale_price_total numeric,
  weekly_pay_total numeric,
  volume_bonus numeric,
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
  _wk date;
BEGIN
  -- Walk Mondays that overlap the month
  _wk := _month_start - ((EXTRACT(ISODOW FROM _month_start)::int - 1));
  WHILE _wk <= _month_end LOOP
    SELECT _weekly_total + COALESCE((SELECT total_pay FROM public.calc_weekly_paycheck(_canvasser_id, _wk)), 0)
      INTO _weekly_total;
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
    AND COALESCE(l.reviewed_at, l.created_at)::date BETWEEN _month_start AND _month_end;

  -- $1,500 per full $100,000 in closed sale price
  _volume := FLOOR(_sale_total / 100000.0) * 1500;

  month_start := _month_start;
  month_end := _month_end;
  total_sits := _sits;
  total_points := _points;
  total_sales := _sales;
  sale_price_total := _sale_total;
  weekly_pay_total := _weekly_total;
  volume_bonus := _volume;
  total_pay := _weekly_total + _volume;
  RETURN NEXT;
END $$;

GRANT EXECUTE ON FUNCTION public.calc_monthly_paycheck(uuid, date) TO authenticated, service_role;

-- ============ Survival Standard suspension rule ============
-- Replaces '2 consecutive 0-lead weekdays' with
-- '<3 POINTS for 2 consecutive ISO weeks' → status 'suspension_review'
CREATE OR REPLACE FUNCTION public.evaluate_canvasser_suspension(_canvasser_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _this_week_start date := (date_trunc('week', CURRENT_DATE))::date;          -- Monday
  _last_week_start date := _this_week_start - 7;
  _prev_week_start date := _this_week_start - 14;
  _last_pts int := 0;
  _prev_pts int := 0;
BEGIN
  SELECT COALESCE(SUM(demos_sits + sales), 0) INTO _last_pts
  FROM public.daily_logs
  WHERE canvasser_id = _canvasser_id
    AND log_date BETWEEN _last_week_start AND _last_week_start + 5;

  SELECT COALESCE(SUM(demos_sits + sales), 0) INTO _prev_pts
  FROM public.daily_logs
  WHERE canvasser_id = _canvasser_id
    AND log_date BETWEEN _prev_week_start AND _prev_week_start + 5;

  IF _last_pts < 3 AND _prev_pts < 3 THEN
    UPDATE public.profiles
    SET status = 'suspension_review'
    WHERE id = _canvasser_id
      AND COALESCE(status, '') <> 'suspension_review';
  END IF;
END $$;
