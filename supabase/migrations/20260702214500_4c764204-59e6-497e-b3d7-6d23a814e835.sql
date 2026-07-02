
-- 1) hype_events: tighten SELECT
DROP POLICY IF EXISTS "hype_events read all authed" ON public.hype_events;
CREATE POLICY "hype_events team or visibility read"
  ON public.hype_events FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.global_visibility_on()
    OR canvasser_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = hype_events.canvasser_id
        AND p.team_id = public.my_team_id(auth.uid())
    )
  );

-- 2) lead_events: add explicit DELETE policies
CREATE POLICY "Canvasser deletes own lead_events"
  ON public.lead_events FOR DELETE
  TO authenticated
  USING (canvasser_id = auth.uid());

CREATE POLICY "Owners delete lead_events"
  ON public.lead_events FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role));

-- 3) webhook_logs: block all client-side writes with restrictive policies
CREATE POLICY "Block client insert webhook_logs"
  ON public.webhook_logs AS RESTRICTIVE FOR INSERT
  TO authenticated, anon
  WITH CHECK (false);

CREATE POLICY "Block client update webhook_logs"
  ON public.webhook_logs AS RESTRICTIVE FOR UPDATE
  TO authenticated, anon
  USING (false) WITH CHECK (false);

CREATE POLICY "Block client delete webhook_logs"
  ON public.webhook_logs AS RESTRICTIVE FOR DELETE
  TO authenticated, anon
  USING (false);

-- 4) Revoke EXECUTE on SECURITY DEFINER functions not intended for direct client RPC.
-- Trigger functions (must not be callable directly):
REVOKE ALL ON FUNCTION public.bump_daily_log_from_pin() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fire_lead_event_on_confirm() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_evaluate_suspension() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_refresh_rank_from_log() FROM PUBLIC, anon, authenticated;

-- Admin/maintenance helpers (server-side only):
REVOKE ALL ON FUNCTION public.auto_clock_out_expired() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.evaluate_canvasser_suspension(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_canvasser_rank(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calc_monthly_paycheck(uuid, date) FROM PUBLIC, anon, authenticated;

-- calc_weekly_paycheck is called from the client — keep authenticated EXECUTE but
-- add an internal owner/self check so it doesn't leak other canvassers' pay.
REVOKE ALL ON FUNCTION public.calc_weekly_paycheck(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calc_weekly_paycheck(uuid, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.calc_weekly_paycheck(_canvasser_id uuid, _week_start date)
 RETURNS TABLE(week_start date, week_end date, sits integer, points integer, sales integer, sale_price_total numeric, hours numeric, hourly_rate numeric, base_pay numeric, commission_rate numeric, commission numeric, sit_bonus numeric, monster_bonus numeric, total_pay numeric, rank text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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
  -- Access check: caller must be the canvasser themselves, an owner, or a captain of their team.
  IF NOT (
    auth.uid() = _canvasser_id
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
