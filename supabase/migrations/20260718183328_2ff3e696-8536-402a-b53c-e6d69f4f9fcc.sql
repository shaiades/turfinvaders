-- Jr. Diamond "Starting Pay Lock" automation (owner-confirmed policy):
--   * Jr. Diamond / Sr. Diamond / Captain ranks become STICKY: once attained,
--     the rank engine no longer demotes them ("comp reverts to weekly reset
--     (rank retained)" — the poster's discipline is the pay-lock lifecycle,
--     not demotion). Owners can still change a rank manually.
--   * The $35/hr + 2% rate lock for those ranks now has a lifecycle:
--     active -> warned -> reverted -> (reinstated) active.
--   * Violation = rolling 4-week sit average (completed Mon-Sat weeks) < 5.
--   * First violation issues a warning; a second violation within 90 days
--     reverts comp to the normal weekly point tiers (rank retained).
--     A violation after the 90-day window restarts the warning instead;
--     a clean 90 days after a warning clears it.
--   * Reinstatement from reverted = 3 consecutive completed weeks at 7+ sits.
--   * Evaluated inside refresh_canvasser_rank. The old per-row daily_logs
--     trigger was dropped in 20260630015535 (bulk-import cost) and stays
--     dropped; instead the app's write paths call the function explicitly
--     (live webhook, manual weekly entry, legacy webhook, CSV import) plus a
--     Monday cron covers zero-activity weeks.
--     The week's verdict is RE-DERIVED on every run from a start-of-week
--     snapshot, so late data (CSV backfills, corrections) self-heals the
--     verdict instead of freezing the first partial-data outcome.
-- Also: guard pay-affecting profile columns from client tampering — the
-- "Users update own profile" RLS policy allowed a canvasser to update ANY
-- column of their own row, including current_rank (which drives the pay lock).

-- ── A) Pay-lock state ────────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS pay_lock_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS pay_lock_warned_on date,
  ADD COLUMN IF NOT EXISTS pay_lock_reverted_on date,
  ADD COLUMN IF NOT EXISTS pay_lock_evaluated_week date,
  ADD COLUMN IF NOT EXISTS pay_lock_prev_status text,
  ADD COLUMN IF NOT EXISTS pay_lock_prev_warned_on date,
  ADD COLUMN IF NOT EXISTS pay_lock_prev_reverted_on date;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_pay_lock_status_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_pay_lock_status_check
  CHECK (pay_lock_status IN ('active', 'warned', 'reverted'));

-- ── B) Column guard ──────────────────────────────────────────────────────────
-- Pay-affecting columns may only be written by the pay/rank engine (which sets
-- a transaction-local flag), the service role, or an owner. Any other UPDATE
-- silently keeps the old values (the rest of the update still applies).
CREATE OR REPLACE FUNCTION public.guard_profile_pay_columns()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF COALESCE(current_setting('app.pay_engine_write', true), '') = 'on'
     OR auth.uid() IS NULL
     OR public.has_role(auth.uid(), 'owner'::app_role) THEN
    RETURN NEW;
  END IF;
  NEW.current_rank := OLD.current_rank;
  NEW.rolling_4_week_sit_avg := OLD.rolling_4_week_sit_avg;
  NEW.consecutive_weeks_3_plus_sits := OLD.consecutive_weeks_3_plus_sits;
  NEW.consecutive_weeks_7_plus_sits := OLD.consecutive_weeks_7_plus_sits;
  NEW.recruits_count := OLD.recruits_count;
  NEW.pay_lock_status := OLD.pay_lock_status;
  NEW.pay_lock_warned_on := OLD.pay_lock_warned_on;
  NEW.pay_lock_reverted_on := OLD.pay_lock_reverted_on;
  NEW.pay_lock_evaluated_week := OLD.pay_lock_evaluated_week;
  NEW.pay_lock_prev_status := OLD.pay_lock_prev_status;
  NEW.pay_lock_prev_warned_on := OLD.pay_lock_prev_warned_on;
  NEW.pay_lock_prev_reverted_on := OLD.pay_lock_prev_reverted_on;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.guard_profile_pay_columns() FROM PUBLIC, authenticated, anon;

DROP TRIGGER IF EXISTS profiles_guard_pay_columns ON public.profiles;
CREATE TRIGGER profiles_guard_pay_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_pay_columns();

-- ── C) refresh_canvasser_rank v2: ladder computation unchanged, locked ranks
--       sticky, plus the weekly re-derivable pay-lock state machine ─────────
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
  _stored_rank text;
  _broke_3 boolean := false;
  _broke_7 boolean := false;
  _sum4 int := 0;
  _i int;
  _pl_status text;
  _pl_warned_on date;
  _pl_reverted_on date;
  _pl_eval_week date;
  _pl_prev_status text;
  _pl_prev_warned_on date;
  _pl_prev_reverted_on date;
  _violation boolean;
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

  SELECT COALESCE(recruits_count, 0), current_rank,
         COALESCE(pay_lock_status, 'active'),
         pay_lock_warned_on, pay_lock_reverted_on, pay_lock_evaluated_week,
         pay_lock_prev_status, pay_lock_prev_warned_on, pay_lock_prev_reverted_on
    INTO _recruits, _stored_rank, _pl_status,
         _pl_warned_on, _pl_reverted_on, _pl_eval_week,
         _pl_prev_status, _pl_prev_warned_on, _pl_prev_reverted_on
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

  -- Sticky locked ranks: a held Jr. Diamond / Sr. Diamond / Captain is never
  -- auto-demoted ("rank retained"); the pay-lock lifecycle below is the
  -- discipline mechanism. Upgrades still apply; owners can demote manually.
  IF _stored_rank IN ('Jr. Diamond', 'Sr. Diamond', 'Captain') THEN
    IF (CASE _rank WHEN 'Captain' THEN 7 WHEN 'Sr. Diamond' THEN 6 WHEN 'Jr. Diamond' THEN 5 ELSE 0 END)
     < (CASE _stored_rank WHEN 'Captain' THEN 7 WHEN 'Sr. Diamond' THEN 6 WHEN 'Jr. Diamond' THEN 5 ELSE 0 END) THEN
      _rank := _stored_rank;
    END IF;
  END IF;

  -- Pay-lock state machine. _rolling4/_consec_7 only count completed weeks.
  -- The verdict for the current week is re-derived from a start-of-week
  -- snapshot on every run, so late-arriving data corrects it until the week
  -- rolls over (first run of a new week promotes the last verdict to the
  -- new snapshot).
  IF _pl_eval_week IS DISTINCT FROM _this_week THEN
    _pl_prev_status := _pl_status;
    _pl_prev_warned_on := _pl_warned_on;
    _pl_prev_reverted_on := _pl_reverted_on;
    _pl_eval_week := _this_week;
  ELSE
    _pl_status := COALESCE(_pl_prev_status, _pl_status);
    _pl_warned_on := _pl_prev_warned_on;
    _pl_reverted_on := _pl_prev_reverted_on;
  END IF;

  _violation := _rolling4 < 5;
  IF _pl_status = 'active' THEN
    IF _violation AND _rank IN ('Jr. Diamond', 'Sr. Diamond', 'Captain') THEN
      _pl_status := 'warned';
      _pl_warned_on := _this_week;
    END IF;
  ELSIF _pl_status = 'warned' THEN
    -- Defensive: a warned row should always carry warned_on; if it was
    -- hand-edited without one, anchor it now so the state can't wedge.
    IF _pl_warned_on IS NULL THEN _pl_warned_on := _this_week; END IF;
    IF _violation AND _this_week > _pl_warned_on THEN
      IF _this_week - _pl_warned_on <= 90 THEN
        _pl_status := 'reverted';
        _pl_reverted_on := _this_week;
      ELSE
        _pl_warned_on := _this_week; -- window expired: fresh first violation
      END IF;
    ELSIF NOT _violation AND _this_week - _pl_warned_on > 90 THEN
      _pl_status := 'active';       -- clean 90 days: warning expires
      _pl_warned_on := NULL;
    END IF;
  ELSIF _pl_status = 'reverted' THEN
    IF _consec_7 >= 3 THEN          -- reinstatement: 3 consecutive 7+ weeks
      _pl_status := 'active';
      _pl_warned_on := NULL;
      _pl_reverted_on := NULL;
    END IF;
  END IF;

  PERFORM set_config('app.pay_engine_write', 'on', true);
  UPDATE public.profiles
  SET consecutive_weeks_3_plus_sits = _consec_3,
      consecutive_weeks_7_plus_sits = _consec_7,
      rolling_4_week_sit_avg = _rolling4,
      current_rank = _rank,
      pay_lock_status = _pl_status,
      pay_lock_warned_on = _pl_warned_on,
      pay_lock_reverted_on = _pl_reverted_on,
      pay_lock_evaluated_week = _pl_eval_week,
      pay_lock_prev_status = _pl_prev_status,
      pay_lock_prev_warned_on = _pl_prev_warned_on,
      pay_lock_prev_reverted_on = _pl_prev_reverted_on,
      updated_at = now()
  WHERE id = _canvasser_id;

  RETURN _rank;
END $$;

-- ── D) calc_weekly_paycheck v3: identical formula, but the rank rate lock is
--       suspended while pay_lock_status = 'reverted' (comp falls back to the
--       normal weekly point tiers; rank and the $75 sit bonus are retained) ──
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

-- ── E) Weekly evaluation cron: Monday 15:00 UTC (7-8am PT). Covers canvassers
--       with no daily_logs activity, whose trigger path would never fire.
--       (The re-derivable verdict means later same-week runs self-correct if
--       this fires before the day's data lands.) ────────────────────────────
CREATE OR REPLACE FUNCTION public.weekly_rank_and_pay_lock_refresh()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.profiles WHERE is_active LOOP
    PERFORM public.refresh_canvasser_rank(r.id);
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.weekly_rank_and_pay_lock_refresh() FROM PUBLIC, authenticated, anon;

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weekly-pay-lock-refresh') THEN
    PERFORM cron.unschedule('weekly-pay-lock-refresh');
  END IF;
  PERFORM cron.schedule(
    'weekly-pay-lock-refresh',
    '0 15 * * 1',
    $CRON$ SELECT public.weekly_rank_and_pay_lock_refresh(); $CRON$
  );
END $$;
