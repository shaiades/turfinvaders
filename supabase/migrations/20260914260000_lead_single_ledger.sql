-- One ledger for leads_called_in (owner: "make it the easiest", 2026-09-14).
--
-- Since the one-tap rework, every field lead counted leads_called_in TWICE:
-- Submit New Lead auto-drops a lead pin (bump_daily_log_from_pin: +1) and
-- the lead's Monday card credits it again (webhook applyLeadCredit, once
-- per item: +1). 2026-09-14 snapshot: 12 lead pins, 24 leads_called_in.
--
-- The Monday card credit is the original, board-is-ground-truth ledger and
-- the only one the office can see and audit — it stays. The pin's
-- leads_called_in bump is removed (lead pins keep counting the door and
-- the talk, which is their job). Nothing in pay reads leads_called_in
-- (checked: pay.ts, paychecks.ts, calc_weekly_paycheck through v7).
--
--   1. One-shot repair, guarded by a webhook_logs marker so a re-run can
--      never double-subtract: for the one-tap era (log_date >= 2026-09-11,
--      when auto-pin-on-submit began), subtract each (canvasser, day)'s
--      valid non-remote lead-pin count from leads_called_in, floored at 0.
--      Days before 9/11 are left alone — back then lead pins were a
--      deliberate separate act and may be the only record of a lead
--      (same roll-forward reasoning as 20260910230000).
--   2. bump_daily_log_from_pin without the leads component.

DO $$
DECLARE
  _rows int;
BEGIN
  IF EXISTS (SELECT 1 FROM public.webhook_logs WHERE step = 'Lead_Pin_Log_Repair_Applied') THEN
    RAISE NOTICE 'lead-pin log repair already applied, skipping';
  ELSE
    UPDATE public.daily_logs dl
    SET leads_called_in = GREATEST(0, dl.leads_called_in - sub.pin_ct),
        updated_at = now()
    FROM (
      SELECT fp.canvasser_id, fp.log_date, count(*)::int AS pin_ct
      FROM public.field_pins fp
      WHERE fp.pin_type = 'lead'
        AND NOT fp.is_remote_drop
        AND fp.log_date >= DATE '2026-09-11'
      GROUP BY fp.canvasser_id, fp.log_date
    ) sub
    JOIN public.profiles p ON p.id = sub.canvasser_id
    WHERE dl.canvasser_id = sub.canvasser_id
      AND dl.log_date = sub.log_date
      AND dl.office_location = COALESCE(p.office_location, 'San Diego');
    GET DIAGNOSTICS _rows = ROW_COUNT;
    INSERT INTO public.webhook_logs (step, data)
    VALUES ('Lead_Pin_Log_Repair_Applied', jsonb_build_object(
      'window_start', '2026-09-11',
      'rows_updated', _rows,
      'applied_at', now()::text));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.bump_daily_log_from_pin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _team uuid;
  _office text;
  _canvasser uuid;
  _log_date date;
  _old_doors int := 0; _old_talked int := 0; _old_ni int := 0; _old_rnt int := 0; _old_nh int := 0;
  _new_doors int := 0; _new_talked int := 0; _new_ni int := 0; _new_rnt int := 0; _new_nh int := 0;
  _d_doors int; _d_talked int; _d_ni int; _d_rnt int; _d_nh int;
BEGIN
  IF TG_OP <> 'INSERT' AND NOT OLD.is_remote_drop THEN
    _old_doors  := 1; -- every result IS a knock
    _old_talked := CASE WHEN OLD.pin_type IN ('talked_to','renter','go_back','lead','not_interested','appt') THEN 1 ELSE 0 END;
    _old_ni     := CASE WHEN OLD.pin_type = 'not_interested' THEN 1 ELSE 0 END;
    _old_rnt    := CASE WHEN OLD.pin_type = 'renter' THEN 1 ELSE 0 END;
    _old_nh     := CASE WHEN OLD.pin_type = 'not_home' THEN 1 ELSE 0 END;
  END IF;
  IF TG_OP <> 'DELETE' AND NOT NEW.is_remote_drop THEN
    _new_doors  := 1; -- every result IS a knock
    _new_talked := CASE WHEN NEW.pin_type IN ('talked_to','renter','go_back','lead','not_interested','appt') THEN 1 ELSE 0 END;
    _new_ni     := CASE WHEN NEW.pin_type = 'not_interested' THEN 1 ELSE 0 END;
    _new_rnt    := CASE WHEN NEW.pin_type = 'renter' THEN 1 ELSE 0 END;
    _new_nh     := CASE WHEN NEW.pin_type = 'not_home' THEN 1 ELSE 0 END;
  END IF;

  _d_doors  := _new_doors  - _old_doors;
  _d_talked := _new_talked - _old_talked;
  _d_ni     := _new_ni     - _old_ni;
  _d_rnt    := _new_rnt    - _old_rnt;
  _d_nh     := _new_nh     - _old_nh;

  -- UPDATE OF fires even when SET writes the same value — no-op deltas exit here.
  IF _d_doors = 0 AND _d_talked = 0 AND _d_ni = 0 AND _d_rnt = 0 AND _d_nh = 0 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    _canvasser := OLD.canvasser_id; _log_date := OLD.log_date;
  ELSE
    _canvasser := NEW.canvasser_id; _log_date := NEW.log_date;
  END IF;

  -- Same office derivation as every prior version of this function: the
  -- canvasser's CURRENT home office. Corrections are same-day (the map only
  -- surfaces today's pins), so office churn between bump and correction is
  -- negligible — accepted asymmetry.
  SELECT team_id, COALESCE(office_location, 'San Diego')
    INTO _team, _office
  FROM public.profiles WHERE id = _canvasser;

  IF _d_doors > 0 OR _d_talked > 0 OR _d_ni > 0 OR _d_rnt > 0 OR _d_nh > 0 THEN
    -- At least one bucket increments (insert, remote->valid, or a mixed-sign
    -- type switch): upsert — creates the day row when missing, exactly like
    -- the INSERT path always has. Negative components clamp via GREATEST.
    INSERT INTO public.daily_logs (
      canvasser_id, team_id, log_date, office_location,
      doors_knocked, people_talked_to, not_interested, renters, not_home
    )
    VALUES (
      _canvasser, _team, _log_date, COALESCE(_office, 'San Diego'),
      GREATEST(_d_doors, 0), GREATEST(_d_talked, 0), GREATEST(_d_ni, 0),
      GREATEST(_d_rnt, 0), GREATEST(_d_nh, 0)
    )
    ON CONFLICT (canvasser_id, log_date, office_location) DO UPDATE
      SET doors_knocked    = GREATEST(0, public.daily_logs.doors_knocked    + _d_doors),
          people_talked_to = GREATEST(0, public.daily_logs.people_talked_to + _d_talked),
          not_interested   = GREATEST(0, public.daily_logs.not_interested   + _d_ni),
          renters          = GREATEST(0, public.daily_logs.renters          + _d_rnt),
          not_home         = GREATEST(0, public.daily_logs.not_home         + _d_nh),
          updated_at       = now();
  ELSE
    -- Pure decrement (delete / valid->remote): only touch an existing row —
    -- never conjure a zero row for a day that has no log. Missing row = no-op.
    UPDATE public.daily_logs
      SET doors_knocked    = GREATEST(0, doors_knocked    + _d_doors),
          people_talked_to = GREATEST(0, people_talked_to + _d_talked),
          not_interested   = GREATEST(0, not_interested   + _d_ni),
          renters          = GREATEST(0, renters          + _d_rnt),
          not_home         = GREATEST(0, not_home         + _d_nh),
          updated_at       = now()
    WHERE canvasser_id = _canvasser
      AND log_date = _log_date
      AND office_location = COALESCE(_office, 'San Diego');
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $function$;
