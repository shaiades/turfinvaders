-- ═══════════════════════════════════════════════════════════════════════════
-- SECOND MEAL PERIOD RULE (owner-approved 2026-10-01).
--
-- CA Labor Code 512: a shift over 10 hours owes a SECOND 30-minute duty-free
-- meal period starting before the end of the 10th hour. The clock tracked
-- only the first meal; >10h days (early-pass mornings + late-pass evenings)
-- slipped through with one lunch and no premium.
--
--   · time_entries.second_meal_status: not_required (≤10h) | taken |
--     taken_late | missed. No 'pending' dead-end: a >10h shift with no
--     second recorded meal is 'missed' — it pays the premium (the meal was
--     not provided) AND flags 'missed_second_meal' for human review, where
--     fixing the real meal times recomputes it away.
--   · calc_weekly_paycheck v8: a day earns its ONE meal premium hour when
--     EITHER meal was missed/late (LC 226.7 allows one meal premium per
--     day, however many meal violations the day had).
--   · Mirrored in src/lib/pay.ts (SECOND_MEAL_AFTER_HOURS) — change the two
--     together; `npm run verify:overtime` must stay green.
--
-- Replaces (full bodies, triggers unchanged):
--   compute_time_entry_hours  v6 → v7   (20260911120000)
--   guard_time_entry_write    v5 → v6   (20261002140000)
--   audit_time_entry          v2 → v3   (20260824100000)
--   calc_weekly_paycheck      v7 → v8   (20260913040000)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS second_meal_status text NOT NULL DEFAULT 'not_required';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.time_entries'::regclass
                   AND conname = 'time_entries_second_meal_status_chk') THEN
    ALTER TABLE public.time_entries ADD CONSTRAINT time_entries_second_meal_status_chk
      CHECK (second_meal_status IN ('not_required','taken','taken_late','missed'));
  END IF;
END $$;

-- ── 1) compute v7: price the second meal ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.compute_time_entry_hours()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _raw_hours numeric;
  _meal_hours numeric := 0;
  _has_compliant_meal boolean := false;
  _has_late_meal boolean := false;
  _local_hour int;
  _early_ok boolean := false;
  _second_meal_start timestamptz;
BEGIN
  IF NEW.voided_at IS NOT NULL THEN
    NEW.billable_hours := 0;
    RETURN NEW;
  END IF;

  -- Punch-time anomaly flags (INSERT): early start and Sunday work.
  IF TG_OP = 'INSERT' THEN
    _local_hour := EXTRACT(HOUR FROM (NEW.clock_in AT TIME ZONE 'America/Los_Angeles'))::int;
    IF _local_hour < 7 THEN
      -- Pre-approved early start (owner/Manager pass): no flag when the
      -- punch is at or after the permitted time. Earlier than permitted
      -- still flags.
      SELECT EXISTS (
        SELECT 1 FROM public.time_clock_exceptions e
        WHERE e.user_id = NEW.user_id
          AND e.exception_date = (NEW.clock_in AT TIME ZONE 'America/Los_Angeles')::date
          AND e.revoked_at IS NULL
          AND e.early_from IS NOT NULL
          AND (NEW.clock_in AT TIME ZONE 'America/Los_Angeles')::time >= e.early_from
      ) INTO _early_ok;
      IF NOT _early_ok AND NOT ('early_clock_in' = ANY(NEW.flag_reasons)) THEN
        NEW.flag_reasons := array_append(NEW.flag_reasons, 'early_clock_in');
        NEW.needs_correction := true;
      END IF;
    END IF;
    IF EXTRACT(ISODOW FROM NEW.log_date)::int = 7
       AND NOT ('sunday_shift' = ANY(NEW.flag_reasons)) THEN
      NEW.flag_reasons := array_append(NEW.flag_reasons, 'sunday_shift');
      NEW.needs_correction := true;
    END IF;
  END IF;

  IF NEW.clock_out IS NULL THEN
    NEW.billable_hours := 0;
    RETURN NEW;
  END IF;

  _raw_hours := EXTRACT(EPOCH FROM (NEW.clock_out - NEW.clock_in)) / 3600.0;
  IF _raw_hours < 0 THEN _raw_hours := 0; END IF;

  SELECT COALESCE(SUM(GREATEST(0,
           EXTRACT(EPOCH FROM (LEAST(mp.meal_end, NEW.clock_out)
                             - GREATEST(mp.meal_start, NEW.clock_in))) / 3600.0)), 0),
         bool_or(mp.meal_end - mp.meal_start >= interval '30 minutes'
                 AND mp.meal_start <= NEW.clock_in + interval '5 hours'),
         bool_or(mp.meal_end - mp.meal_start >= interval '30 minutes'
                 AND mp.meal_start > NEW.clock_in + interval '5 hours')
    INTO _meal_hours, _has_compliant_meal, _has_late_meal
  FROM public.meal_periods mp
  WHERE mp.time_entry_id = NEW.id AND mp.meal_end IS NOT NULL;

  NEW.billable_hours := ROUND(GREATEST(_raw_hours - _meal_hours, 0)::numeric, 2);

  IF _raw_hours <= 5.0 THEN
    NEW.meal_status := CASE WHEN _meal_hours > 0 THEN 'taken' ELSE 'not_required' END;
  ELSIF COALESCE(_has_compliant_meal, false) THEN
    NEW.meal_status := 'taken';
  ELSIF COALESCE(_has_late_meal, false) THEN
    NEW.meal_status := 'taken_late';
  ELSIF NEW.meal_status NOT IN ('missed', 'unrecorded') THEN
    NEW.meal_status := 'pending';
  END IF;

  -- Second meal (LC 512): a shift over 10 hours owes a SECOND 30+ minute
  -- meal starting before the end of the 10th hour. The second-earliest
  -- 30-minute meal decides; 'missed' pays the premium and flags for review
  -- (fixing the real meal rows recomputes it away).
  IF _raw_hours <= 10.0 THEN
    NEW.second_meal_status := 'not_required';
  ELSE
    SELECT mp.meal_start INTO _second_meal_start
    FROM public.meal_periods mp
    WHERE mp.time_entry_id = NEW.id AND mp.meal_end IS NOT NULL
      AND mp.meal_end - mp.meal_start >= interval '30 minutes'
    ORDER BY mp.meal_start
    OFFSET 1 LIMIT 1;
    IF _second_meal_start IS NULL THEN
      NEW.second_meal_status := 'missed';
    ELSIF _second_meal_start <= NEW.clock_in + interval '10 hours' THEN
      NEW.second_meal_status := 'taken';
    ELSE
      NEW.second_meal_status := 'taken_late';
    END IF;
  END IF;

  -- Close-time anomaly flags.
  IF _raw_hours > 12 AND NOT ('very_long_shift' = ANY(NEW.flag_reasons)) THEN
    NEW.flag_reasons := array_append(NEW.flag_reasons, 'very_long_shift');
    NEW.needs_correction := true;
  END IF;
  IF NEW.meal_status IN ('missed', 'taken_late')
     AND NOT ('missed_meal' = ANY(NEW.flag_reasons)) THEN
    NEW.flag_reasons := array_append(NEW.flag_reasons, 'missed_meal');
    NEW.needs_correction := true;
  END IF;
  IF NEW.meal_status = 'unrecorded'
     AND NOT ('unrecorded_lunch' = ANY(NEW.flag_reasons)) THEN
    NEW.flag_reasons := array_append(NEW.flag_reasons, 'unrecorded_lunch');
    NEW.needs_correction := true;
  END IF;
  IF NEW.second_meal_status IN ('missed', 'taken_late')
     AND NOT ('missed_second_meal' = ANY(NEW.flag_reasons)) THEN
    NEW.flag_reasons := array_append(NEW.flag_reasons, 'missed_second_meal');
    NEW.needs_correction := true;
  END IF;

  RETURN NEW;
END $$;

-- ── 2) guard v6: second_meal_status joins the pure-touch pass and the
--       punch-out restriction (compute may change it; workers may not) ──────

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
     AND NEW.second_meal_status IS NOT DISTINCT FROM OLD.second_meal_status
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
     OR NEW.second_meal_status IS DISTINCT FROM OLD.second_meal_status
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

-- ── 3) audit v3: second_meal_status changes are auditable, not skipped ──────

CREATE OR REPLACE FUNCTION public.audit_time_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _action text;
  _reason text := NULLIF(current_setting('app.edit_reason', true), '');
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.clock_in IS NOT DISTINCT FROM OLD.clock_in
     AND NEW.clock_out IS NOT DISTINCT FROM OLD.clock_out
     AND NEW.log_date IS NOT DISTINCT FROM OLD.log_date
     AND NEW.billable_hours IS NOT DISTINCT FROM OLD.billable_hours
     AND NEW.meal_status IS NOT DISTINCT FROM OLD.meal_status
     AND NEW.second_meal_status IS NOT DISTINCT FROM OLD.second_meal_status
     AND NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at
     AND NEW.entry_source IS NOT DISTINCT FROM OLD.entry_source
     AND NEW.needs_correction IS NOT DISTINCT FROM OLD.needs_correction
     AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    _action := 'insert';
  ELSIF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    _action := 'void';
  ELSIF NEW.reviewed_at IS NOT NULL AND OLD.reviewed_at IS DISTINCT FROM NEW.reviewed_at
        AND NEW.clock_in IS NOT DISTINCT FROM OLD.clock_in
        AND NEW.clock_out IS NOT DISTINCT FROM OLD.clock_out THEN
    _action := 'approve';
  ELSIF NEW.entry_source = 'auto_closed' AND OLD.clock_out IS NULL AND auth.uid() IS NULL THEN
    _action := 'auto_close';
  ELSIF OLD.clock_out IS NULL AND NEW.clock_out IS NOT NULL AND auth.uid() = NEW.user_id THEN
    _action := 'punch_out';
  ELSE
    _action := 'update';
  END IF;

  INSERT INTO public.time_entry_audit (time_entry_id, actor, action, reason, old_row, new_row)
  VALUES (NEW.id, auth.uid(), _action, _reason,
          CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, to_jsonb(NEW));
  RETURN NEW;
END $$;

-- ── 4) calc v8: either meal violation earns the day's single premium hour ───

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
  _second_meal_missed int := 0;
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

  SELECT COUNT(*) FILTER (WHERE te.entry_source = 'auto_closed'),
         COUNT(*) FILTER (WHERE te.needs_correction),
         COUNT(*) FILTER (WHERE te.meal_status = 'pending'),
         COUNT(*) FILTER (WHERE te.meal_status = 'unrecorded'),
         COUNT(*) FILTER (WHERE te.second_meal_status IN ('missed', 'taken_late'))
    INTO _auto_closed, _needs_corr, _meal_pending, _meal_unrecorded, _second_meal_missed
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
    'second_meal_missed', _second_meal_missed,
    'below_min_wage', (_rate < _min_wage)
  );
  RETURN NEXT;
END $function$;

REVOKE ALL ON FUNCTION public.calc_weekly_paycheck(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calc_weekly_paycheck(uuid, date) TO service_role;

-- ── 5) Re-price THIS week's >10h entries under the new rule ─────────────────
-- A no-op touch makes compute re-derive second_meal_status (and flag). The
-- CURRENT unpaid week only: re-pricing paid history would silently change
-- what past weeks "should" have paid (that true-up is an owner/accountant
-- decision, same doctrine as the P0 backfill note) and would flood the
-- review queue + push with stale flags.
UPDATE public.time_entries te
SET updated_at = now()
WHERE te.voided_at IS NULL
  AND te.clock_out IS NOT NULL
  AND te.log_date >= ((now() AT TIME ZONE 'America/Los_Angeles')::date
        - (EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Los_Angeles')::date)::int - 1))
  AND EXTRACT(EPOCH FROM (te.clock_out - te.clock_in)) / 3600.0 > 10;
