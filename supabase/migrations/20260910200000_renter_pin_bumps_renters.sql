-- Renter tally key (Active Run, 2026-09-10): renter pins now bump
-- daily_logs.renters. Until now `renters` was Log-form-only ("Rnt = log-only",
-- PR #159) because no pin path fed it — the new tally key IS that path, and
-- the map chip's renter pins join it for consistency (one pin type, one
-- contribution rule). A renter pin KEEPS bumping people_talked_to — a renter
-- is a conversation, and the dispatch Tlk column has always included them.
-- Everything else matches 20260824140000: corrections adjust by delta, remote
-- drops contribute zero on every op, decrements floor at 0 (GREATEST) and
-- never create a daily_logs row.
-- ROLL FORWARD ONLY — no backfill from pre-existing renter pins: reps logged
-- renters by hand in the Log form until today, so backfilling would
-- double-count those days.
-- Idempotent; apply by hand in the Supabase dashboard SQL editor.

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
  _old_doors int := 0; _old_talked int := 0; _old_ni int := 0; _old_leads int := 0; _old_rnt int := 0;
  _new_doors int := 0; _new_talked int := 0; _new_ni int := 0; _new_leads int := 0; _new_rnt int := 0;
  _d_doors int; _d_talked int; _d_ni int; _d_leads int; _d_rnt int;
BEGIN
  IF TG_OP <> 'INSERT' AND NOT OLD.is_remote_drop THEN
    _old_doors  := CASE WHEN OLD.pin_type IN ('knock','not_home') THEN 1 ELSE 0 END;
    _old_talked := CASE WHEN OLD.pin_type IN ('talked_to','renter','go_back') THEN 1 ELSE 0 END;
    _old_ni     := CASE WHEN OLD.pin_type = 'not_interested' THEN 1 ELSE 0 END;
    _old_leads  := CASE WHEN OLD.pin_type = 'lead' THEN 1 ELSE 0 END;
    _old_rnt    := CASE WHEN OLD.pin_type = 'renter' THEN 1 ELSE 0 END;
  END IF;
  IF TG_OP <> 'DELETE' AND NOT NEW.is_remote_drop THEN
    _new_doors  := CASE WHEN NEW.pin_type IN ('knock','not_home') THEN 1 ELSE 0 END;
    _new_talked := CASE WHEN NEW.pin_type IN ('talked_to','renter','go_back') THEN 1 ELSE 0 END;
    _new_ni     := CASE WHEN NEW.pin_type = 'not_interested' THEN 1 ELSE 0 END;
    _new_leads  := CASE WHEN NEW.pin_type = 'lead' THEN 1 ELSE 0 END;
    _new_rnt    := CASE WHEN NEW.pin_type = 'renter' THEN 1 ELSE 0 END;
  END IF;

  _d_doors  := _new_doors  - _old_doors;
  _d_talked := _new_talked - _old_talked;
  _d_ni     := _new_ni     - _old_ni;
  _d_leads  := _new_leads  - _old_leads;
  _d_rnt    := _new_rnt    - _old_rnt;

  -- UPDATE OF fires even when SET writes the same value — no-op deltas exit here.
  IF _d_doors = 0 AND _d_talked = 0 AND _d_ni = 0 AND _d_leads = 0 AND _d_rnt = 0 THEN
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

  IF _d_doors > 0 OR _d_talked > 0 OR _d_ni > 0 OR _d_leads > 0 OR _d_rnt > 0 THEN
    -- At least one bucket increments (insert, remote->valid, or a mixed-sign
    -- type switch): upsert — creates the day row when missing, exactly like
    -- the INSERT path always has. Negative components clamp via GREATEST.
    INSERT INTO public.daily_logs (
      canvasser_id, team_id, log_date, office_location,
      doors_knocked, people_talked_to, not_interested, leads_called_in, renters
    )
    VALUES (
      _canvasser, _team, _log_date, COALESCE(_office, 'San Diego'),
      GREATEST(_d_doors, 0), GREATEST(_d_talked, 0), GREATEST(_d_ni, 0), GREATEST(_d_leads, 0),
      GREATEST(_d_rnt, 0)
    )
    ON CONFLICT (canvasser_id, log_date, office_location) DO UPDATE
      SET doors_knocked    = GREATEST(0, public.daily_logs.doors_knocked    + _d_doors),
          people_talked_to = GREATEST(0, public.daily_logs.people_talked_to + _d_talked),
          not_interested   = GREATEST(0, public.daily_logs.not_interested   + _d_ni),
          leads_called_in  = GREATEST(0, public.daily_logs.leads_called_in  + _d_leads),
          renters          = GREATEST(0, public.daily_logs.renters          + _d_rnt),
          updated_at       = now();
  ELSE
    -- Pure decrement (delete / valid->remote): only touch an existing row —
    -- never conjure a zero row for a day that has no log. Missing row = no-op.
    UPDATE public.daily_logs
      SET doors_knocked    = GREATEST(0, doors_knocked    + _d_doors),
          people_talked_to = GREATEST(0, people_talked_to + _d_talked),
          not_interested   = GREATEST(0, not_interested   + _d_ni),
          leads_called_in  = GREATEST(0, leads_called_in  + _d_leads),
          renters          = GREATEST(0, renters          + _d_rnt),
          updated_at       = now()
    WHERE canvasser_id = _canvasser
      AND log_date = _log_date
      AND office_location = COALESCE(_office, 'San Diego');
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $function$;
