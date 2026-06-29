
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS recruits_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS consecutive_weeks_3_plus_sits integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS consecutive_weeks_7_plus_sits integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rolling_4_week_sit_avg numeric NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.refresh_canvasser_rank(_canvasser_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _all_time_leads int := 0;
  _consec_3 int := 0;
  _consec_7 int := 0;
  _rolling4 numeric := 0;
  _recruits int := 0;
  _this_week date := (date_trunc('week', CURRENT_DATE))::date;
  _wk date;
  _wk_sits int;
  _rank text;
  _broke_3 boolean := false;
  _broke_7 boolean := false;
  _sum4 int := 0;
  _i int;
BEGIN
  SELECT COALESCE(SUM(COALESCE(demos_sits,0) + COALESCE(sales,0) + COALESCE(no_demo,0)
                      + COALESCE(one_legs,0) + COALESCE(future_leads,0)), 0)
    INTO _all_time_leads
  FROM public.daily_logs WHERE canvasser_id = _canvasser_id;

  FOR _i IN 1..12 LOOP
    _wk := _this_week - (_i * 7);
    SELECT COALESCE(SUM(demos_sits), 0) INTO _wk_sits
    FROM public.daily_logs
    WHERE canvasser_id = _canvasser_id
      AND log_date BETWEEN _wk AND _wk + 5;

    IF NOT _broke_3 THEN
      IF _wk_sits >= 3 THEN _consec_3 := _consec_3 + 1; ELSE _broke_3 := true; END IF;
    END IF;
    IF NOT _broke_7 THEN
      IF _wk_sits >= 7 THEN _consec_7 := _consec_7 + 1; ELSE _broke_7 := true; END IF;
    END IF;
    IF _i <= 4 THEN _sum4 := _sum4 + _wk_sits; END IF;
  END LOOP;

  _rolling4 := _sum4::numeric / 4.0;

  SELECT COALESCE(recruits_count, 0) INTO _recruits
  FROM public.profiles WHERE id = _canvasser_id;

  IF _consec_7 >= 4 AND _rolling4 >= 7 AND _recruits >= 2 THEN
    _rank := 'Captain';
  ELSIF _rolling4 >= 7 AND _recruits >= 1 THEN
    _rank := 'Sr. Diamond';
  ELSIF _consec_7 >= 3 AND _recruits >= 1 THEN
    _rank := 'Jr. Diamond';
  ELSIF _consec_7 >= 3 THEN
    _rank := 'Sr. Gold';
  ELSIF _consec_3 >= 2 THEN
    _rank := 'Jr. Gold';
  ELSIF _all_time_leads >= 6 THEN
    _rank := 'Sr. Silver';
  ELSE
    _rank := 'Jr. Silver';
  END IF;

  UPDATE public.profiles
  SET consecutive_weeks_3_plus_sits = _consec_3,
      consecutive_weeks_7_plus_sits = _consec_7,
      rolling_4_week_sit_avg = _rolling4,
      current_rank = _rank,
      updated_at = now()
  WHERE id = _canvasser_id;

  RETURN _rank;
END $$;

CREATE OR REPLACE FUNCTION public.trg_refresh_rank_from_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.refresh_canvasser_rank(NEW.canvasser_id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS daily_logs_refresh_rank ON public.daily_logs;
CREATE TRIGGER daily_logs_refresh_rank
  AFTER INSERT OR UPDATE ON public.daily_logs
  FOR EACH ROW EXECUTE FUNCTION public.trg_refresh_rank_from_log();

DROP FUNCTION IF EXISTS public.calc_weekly_paycheck(uuid, date);

CREATE FUNCTION public.calc_weekly_paycheck(_canvasser_id uuid, _week_start date)
 RETURNS TABLE(week_start date, week_end date, sits integer, points integer, sales integer, sale_price_total numeric, hours numeric, hourly_rate numeric, base_pay numeric, commission_rate numeric, commission numeric, sit_bonus numeric, monster_bonus numeric, total_pay numeric, rank text)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  _week_end date := _week_start + 5;
  _sits int := 0; _points int := 0; _sales int := 0;
  _sale_total numeric := 0; _hours numeric := 0;
  _rate numeric := 18.00; _comm_rate numeric := 0.01;
  _sit_bonus numeric := 0; _monster numeric := 0;
  _commission numeric := 0; _base numeric := 0;
  _rank text;
  _sit_bonus_per numeric := 50;
BEGIN
  SELECT COALESCE(SUM(dl.demos_sits),0), COALESCE(SUM(dl.demos_sits+dl.sales),0), COALESCE(SUM(dl.sales),0)
    INTO _sits,_points,_sales
  FROM public.daily_logs dl
  WHERE dl.canvasser_id=_canvasser_id AND dl.log_date BETWEEN _week_start AND _week_end;

  SELECT COALESCE(SUM(l.sale_amount),0) INTO _sale_total
  FROM public.leads l
  WHERE l.canvasser_id=_canvasser_id AND l.status='confirmed'
    AND COALESCE(l.reviewed_at,l.created_at)::date BETWEEN _week_start AND _week_end;

  SELECT COALESCE(SUM(CASE WHEN EXTRACT(ISODOW FROM dl.log_date) BETWEEN 1 AND 5 THEN 7.5
                            WHEN EXTRACT(ISODOW FROM dl.log_date) = 6 THEN 6.5 ELSE 0 END),0)
    INTO _hours
  FROM public.daily_logs dl
  WHERE dl.canvasser_id=_canvasser_id AND dl.log_date BETWEEN _week_start AND _week_end
    AND (COALESCE(dl.leads_called_in,0)+COALESCE(dl.confirmed_leads,0)
       +COALESCE(dl.demos_sits,0)+COALESCE(dl.sales,0)+COALESCE(dl.people_talked_to,0))>0;

  SELECT COALESCE(current_rank,'Jr. Silver') INTO _rank FROM public.profiles WHERE id=_canvasser_id;

  IF _points >= 7 THEN _rate := 35.00;
  ELSIF _points >= 3 THEN _rate := 30.00;
  ELSE _rate := 18.00; END IF;

  IF _points >= 7 THEN _comm_rate := 0.02; ELSE _comm_rate := 0.01; END IF;

  IF _rank IN ('Jr. Diamond','Sr. Diamond','Captain') THEN
    _rate := 35.00;
    _comm_rate := 0.02;
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

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.profiles LOOP
    PERFORM public.refresh_canvasser_rank(r.id);
  END LOOP;
END $$;
