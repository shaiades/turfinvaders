-- Pin corrections (the undo story): a canvasser can switch a same-day pin's
-- knock result or delete it, and daily_logs counters must follow.
--   INSERT:                            +contribution(NEW)   (unchanged behavior)
--   UPDATE of pin_type/is_remote_drop: contribution(NEW) - contribution(OLD)
--   DELETE:                            -contribution(OLD)
-- Contribution per pin (same buckets as 20260815020000; appt bumps NOTHING —
-- owner directive 2026-08-15, appointments/sales come from Monday.com):
--   doors_knocked:    knock, not_home
--   people_talked_to: talked_to, renter, go_back
--   not_interested:   not_interested
--   leads_called_in:  lead
-- Remote-drop pins contribute zero on EVERY op (flipping remote->valid bumps,
-- valid->remote decrements). Decrements floor at 0 (GREATEST) and never create
-- a daily_logs row; a missing row is a silent no-op. UPDATE OF deliberately
-- excludes log_date/note/coords — none of them move counters (nothing in the
-- app rewrites log_date; SQL that did would bypass adjustment).
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
  _old_doors int := 0; _old_talked int := 0; _old_ni int := 0; _old_leads int := 0;
  _new_doors int := 0; _new_talked int := 0; _new_ni int := 0; _new_leads int := 0;
  _d_doors int; _d_talked int; _d_ni int; _d_leads int;
BEGIN
  IF TG_OP <> 'INSERT' AND NOT OLD.is_remote_drop THEN
    _old_doors  := CASE WHEN OLD.pin_type IN ('knock','not_home') THEN 1 ELSE 0 END;
    _old_talked := CASE WHEN OLD.pin_type IN ('talked_to','renter','go_back') THEN 1 ELSE 0 END;
    _old_ni     := CASE WHEN OLD.pin_type = 'not_interested' THEN 1 ELSE 0 END;
    _old_leads  := CASE WHEN OLD.pin_type = 'lead' THEN 1 ELSE 0 END;
  END IF;
  IF TG_OP <> 'DELETE' AND NOT NEW.is_remote_drop THEN
    _new_doors  := CASE WHEN NEW.pin_type IN ('knock','not_home') THEN 1 ELSE 0 END;
    _new_talked := CASE WHEN NEW.pin_type IN ('talked_to','renter','go_back') THEN 1 ELSE 0 END;
    _new_ni     := CASE WHEN NEW.pin_type = 'not_interested' THEN 1 ELSE 0 END;
    _new_leads  := CASE WHEN NEW.pin_type = 'lead' THEN 1 ELSE 0 END;
  END IF;

  _d_doors  := _new_doors  - _old_doors;
  _d_talked := _new_talked - _old_talked;
  _d_ni     := _new_ni     - _old_ni;
  _d_leads  := _new_leads  - _old_leads;

  -- UPDATE OF fires even when SET writes the same value — no-op deltas exit here.
  IF _d_doors = 0 AND _d_talked = 0 AND _d_ni = 0 AND _d_leads = 0 THEN
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

  IF _d_doors > 0 OR _d_talked > 0 OR _d_ni > 0 OR _d_leads > 0 THEN
    -- At least one bucket increments (insert, remote->valid, or a mixed-sign
    -- type switch): upsert — creates the day row when missing, exactly like
    -- the INSERT path always has. Negative components clamp via GREATEST.
    INSERT INTO public.daily_logs (
      canvasser_id, team_id, log_date, office_location,
      doors_knocked, people_talked_to, not_interested, leads_called_in
    )
    VALUES (
      _canvasser, _team, _log_date, COALESCE(_office, 'San Diego'),
      GREATEST(_d_doors, 0), GREATEST(_d_talked, 0), GREATEST(_d_ni, 0), GREATEST(_d_leads, 0)
    )
    ON CONFLICT (canvasser_id, log_date, office_location) DO UPDATE
      SET doors_knocked    = GREATEST(0, public.daily_logs.doors_knocked    + _d_doors),
          people_talked_to = GREATEST(0, public.daily_logs.people_talked_to + _d_talked),
          not_interested   = GREATEST(0, public.daily_logs.not_interested   + _d_ni),
          leads_called_in  = GREATEST(0, public.daily_logs.leads_called_in  + _d_leads),
          updated_at       = now();
  ELSE
    -- Pure decrement (delete / valid->remote): only touch an existing row —
    -- never conjure a zero row for a day that has no log. Missing row = no-op.
    UPDATE public.daily_logs
      SET doors_knocked    = GREATEST(0, doors_knocked    + _d_doors),
          people_talked_to = GREATEST(0, people_talked_to + _d_talked),
          not_interested   = GREATEST(0, not_interested   + _d_ni),
          leads_called_in  = GREATEST(0, leads_called_in  + _d_leads),
          updated_at       = now()
    WHERE canvasser_id = _canvasser
      AND log_date = _log_date
      AND office_location = COALESCE(_office, 'San Diego');
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $function$;

-- Recreate the trigger to also fire on the two correction ops.
DROP TRIGGER IF EXISTS field_pins_bump_log ON public.field_pins;
CREATE TRIGGER field_pins_bump_log
  AFTER INSERT OR DELETE OR UPDATE OF pin_type, is_remote_drop
  ON public.field_pins
  FOR EACH ROW EXECUTE FUNCTION public.bump_daily_log_from_pin();
