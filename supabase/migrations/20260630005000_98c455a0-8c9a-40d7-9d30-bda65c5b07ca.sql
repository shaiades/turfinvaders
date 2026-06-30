
CREATE TABLE public.time_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  clock_in TIMESTAMPTZ NOT NULL DEFAULT now(),
  clock_out TIMESTAMPTZ,
  log_date DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  billable_hours NUMERIC(5,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX time_entries_user_date_idx ON public.time_entries(user_id, log_date);
CREATE UNIQUE INDEX time_entries_one_open_per_user
  ON public.time_entries(user_id) WHERE clock_out IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.time_entries TO authenticated;
GRANT ALL ON public.time_entries TO service_role;

ALTER TABLE public.time_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own time entries" ON public.time_entries
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'captain'));

CREATE POLICY "Users insert own time entries" ON public.time_entries
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users update own time entries" ON public.time_entries
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'owner'))
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(), 'owner'));

CREATE POLICY "Owners delete time entries" ON public.time_entries
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'owner'));

CREATE TRIGGER time_entries_touch_updated_at
  BEFORE UPDATE ON public.time_entries
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.compute_time_entry_hours()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _raw_hours NUMERIC;
  _cap NUMERIC;
  _dow INT;
  _billable NUMERIC;
BEGIN
  IF NEW.clock_out IS NULL THEN
    NEW.billable_hours := 0;
    RETURN NEW;
  END IF;

  _raw_hours := EXTRACT(EPOCH FROM (NEW.clock_out - NEW.clock_in)) / 3600.0;
  IF _raw_hours < 0 THEN _raw_hours := 0; END IF;

  _dow := EXTRACT(ISODOW FROM NEW.log_date)::int;
  IF _dow BETWEEN 1 AND 5 THEN _cap := 7.5;
  ELSIF _dow = 6 THEN _cap := 6.5;
  ELSE _cap := 0; END IF;

  IF _raw_hours > _cap THEN
    _billable := _cap;
  ELSE
    _billable := _raw_hours;
  END IF;

  NEW.billable_hours := ROUND(_billable::numeric, 2);
  RETURN NEW;
END $$;

CREATE TRIGGER time_entries_compute_hours
  BEFORE INSERT OR UPDATE ON public.time_entries
  FOR EACH ROW EXECUTE FUNCTION public.compute_time_entry_hours();

REVOKE EXECUTE ON FUNCTION public.compute_time_entry_hours() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.calc_weekly_paycheck(_canvasser_id uuid, _week_start date)
 RETURNS TABLE(week_start date, week_end date, sits integer, points integer, sales integer, sale_price_total numeric, hours numeric, hourly_rate numeric, base_pay numeric, commission_rate numeric, commission numeric, sit_bonus numeric, monster_bonus numeric, total_pay numeric, rank text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _week_end date := _week_start + 5;
  _sits int := 0; _points int := 0; _sales int := 0;
  _sale_total numeric := 0; _hours numeric := 0; _clocked numeric := 0;
  _rate numeric := 18.00; _comm_rate numeric := 0.01;
  _sit_bonus numeric := 0; _monster numeric := 0;
  _commission numeric := 0; _base numeric := 0;
  _rank text; _sit_bonus_per numeric := 50;
BEGIN
  SELECT COALESCE(SUM(dl.demos_sits),0), COALESCE(SUM(dl.demos_sits+dl.sales),0), COALESCE(SUM(dl.sales),0)
    INTO _sits,_points,_sales
  FROM public.daily_logs dl
  WHERE dl.canvasser_id=_canvasser_id AND dl.log_date BETWEEN _week_start AND _week_end;

  SELECT COALESCE(SUM(l.sale_amount),0) INTO _sale_total
  FROM public.leads l
  WHERE l.canvasser_id=_canvasser_id AND l.status='confirmed'
    AND COALESCE(l.reviewed_at,l.created_at)::date BETWEEN _week_start AND _week_end;

  SELECT COALESCE(SUM(te.billable_hours),0) INTO _clocked
  FROM public.time_entries te
  WHERE te.user_id = _canvasser_id
    AND te.log_date BETWEEN _week_start AND _week_end
    AND te.clock_out IS NOT NULL;

  IF _clocked > 0 THEN
    _hours := _clocked;
  ELSE
    SELECT COALESCE(SUM(CASE WHEN EXTRACT(ISODOW FROM dl.log_date) BETWEEN 1 AND 5 THEN 7.5
                              WHEN EXTRACT(ISODOW FROM dl.log_date) = 6 THEN 6.5 ELSE 0 END),0)
      INTO _hours
    FROM public.daily_logs dl
    WHERE dl.canvasser_id=_canvasser_id AND dl.log_date BETWEEN _week_start AND _week_end
      AND (COALESCE(dl.leads_called_in,0)+COALESCE(dl.confirmed_leads,0)
         +COALESCE(dl.demos_sits,0)+COALESCE(dl.sales,0)+COALESCE(dl.people_talked_to,0))>0;
  END IF;

  SELECT COALESCE(current_rank,'Jr. Silver') INTO _rank FROM public.profiles WHERE id=_canvasser_id;

  IF _points >= 7 THEN _rate := 35.00;
  ELSIF _points >= 3 THEN _rate := 30.00;
  ELSE _rate := 18.00; END IF;

  IF _points >= 7 THEN _comm_rate := 0.02; ELSE _comm_rate := 0.01; END IF;

  IF _rank IN ('Jr. Diamond','Sr. Diamond','Captain') THEN
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

REVOKE EXECUTE ON FUNCTION public.calc_weekly_paycheck(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calc_weekly_paycheck(uuid, date) TO authenticated;
