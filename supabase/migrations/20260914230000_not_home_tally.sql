-- Not Home tally (owner directive 2026-09-14: "Not home is missing" — the
-- Door Work group must expand so Doors Knocked reads as the total of the
-- outcomes under it).
--
-- Canvassers already tap "🔴 Not home" (pin_type not_home, one-tap rework
-- PRs #169/#175) and, since result-counts-as-knock (20260910230000), each
-- such pin bumps doors_knocked — but ONLY doors_knocked: the outcome itself
-- was invisible (no daily_logs column, no dispatch column), which is why
-- Drs never reconciled against Tlk on the board. This migration:
--
--   1. adds daily_logs.not_home;
--   2. re-creates bump_daily_log_from_pin with not_home in the matrix —
--      a not_home pin now bumps doors_knocked AND not_home (never talked);
--   3. backfills not_home from existing valid, non-remote not_home pins for
--      log_date >= 2026-09-11 (the day result-counts-as-knock went live, so
--      backfilled days keep the Drs ⊇ Tlk + NH identity; before that,
--      not_home pins never bumped doors, and those days stay as they were).
--      The backfill SETs the absolute pin count (nothing else has ever
--      written the column), so re-running it is safe.
--
-- Contribution matrix after this migration (valid, non-remote pins):
--   doors_knocked    ALL pin types
--   people_talked_to talked_to, renter, go_back, lead, not_interested, appt
--   not_home         not_home                                        (NEW)
--   not_interested   not_interested
--   leads_called_in  lead
--   renters          renter

ALTER TABLE public.daily_logs
  ADD COLUMN IF NOT EXISTS not_home integer NOT NULL DEFAULT 0;

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
  _old_doors int := 0; _old_talked int := 0; _old_ni int := 0; _old_leads int := 0; _old_rnt int := 0; _old_nh int := 0;
  _new_doors int := 0; _new_talked int := 0; _new_ni int := 0; _new_leads int := 0; _new_rnt int := 0; _new_nh int := 0;
  _d_doors int; _d_talked int; _d_ni int; _d_leads int; _d_rnt int; _d_nh int;
BEGIN
  IF TG_OP <> 'INSERT' AND NOT OLD.is_remote_drop THEN
    _old_doors  := 1; -- every result IS a knock
    _old_talked := CASE WHEN OLD.pin_type IN ('talked_to','renter','go_back','lead','not_interested','appt') THEN 1 ELSE 0 END;
    _old_ni     := CASE WHEN OLD.pin_type = 'not_interested' THEN 1 ELSE 0 END;
    _old_leads  := CASE WHEN OLD.pin_type = 'lead' THEN 1 ELSE 0 END;
    _old_rnt    := CASE WHEN OLD.pin_type = 'renter' THEN 1 ELSE 0 END;
    _old_nh     := CASE WHEN OLD.pin_type = 'not_home' THEN 1 ELSE 0 END;
  END IF;
  IF TG_OP <> 'DELETE' AND NOT NEW.is_remote_drop THEN
    _new_doors  := 1; -- every result IS a knock
    _new_talked := CASE WHEN NEW.pin_type IN ('talked_to','renter','go_back','lead','not_interested','appt') THEN 1 ELSE 0 END;
    _new_ni     := CASE WHEN NEW.pin_type = 'not_interested' THEN 1 ELSE 0 END;
    _new_leads  := CASE WHEN NEW.pin_type = 'lead' THEN 1 ELSE 0 END;
    _new_rnt    := CASE WHEN NEW.pin_type = 'renter' THEN 1 ELSE 0 END;
    _new_nh     := CASE WHEN NEW.pin_type = 'not_home' THEN 1 ELSE 0 END;
  END IF;

  _d_doors  := _new_doors  - _old_doors;
  _d_talked := _new_talked - _old_talked;
  _d_ni     := _new_ni     - _old_ni;
  _d_leads  := _new_leads  - _old_leads;
  _d_rnt    := _new_rnt    - _old_rnt;
  _d_nh     := _new_nh     - _old_nh;

  -- UPDATE OF fires even when SET writes the same value — no-op deltas exit here.
  IF _d_doors = 0 AND _d_talked = 0 AND _d_ni = 0 AND _d_leads = 0 AND _d_rnt = 0 AND _d_nh = 0 THEN
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

  IF _d_doors > 0 OR _d_talked > 0 OR _d_ni > 0 OR _d_leads > 0 OR _d_rnt > 0 OR _d_nh > 0 THEN
    -- At least one bucket increments (insert, remote->valid, or a mixed-sign
    -- type switch): upsert — creates the day row when missing, exactly like
    -- the INSERT path always has. Negative components clamp via GREATEST.
    INSERT INTO public.daily_logs (
      canvasser_id, team_id, log_date, office_location,
      doors_knocked, people_talked_to, not_interested, leads_called_in, renters, not_home
    )
    VALUES (
      _canvasser, _team, _log_date, COALESCE(_office, 'San Diego'),
      GREATEST(_d_doors, 0), GREATEST(_d_talked, 0), GREATEST(_d_ni, 0), GREATEST(_d_leads, 0),
      GREATEST(_d_rnt, 0), GREATEST(_d_nh, 0)
    )
    ON CONFLICT (canvasser_id, log_date, office_location) DO UPDATE
      SET doors_knocked    = GREATEST(0, public.daily_logs.doors_knocked    + _d_doors),
          people_talked_to = GREATEST(0, public.daily_logs.people_talked_to + _d_talked),
          not_interested   = GREATEST(0, public.daily_logs.not_interested   + _d_ni),
          leads_called_in  = GREATEST(0, public.daily_logs.leads_called_in  + _d_leads),
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
          leads_called_in  = GREATEST(0, leads_called_in  + _d_leads),
          renters          = GREATEST(0, renters          + _d_rnt),
          not_home         = GREATEST(0, not_home         + _d_nh),
          updated_at       = now()
    WHERE canvasser_id = _canvasser
      AND log_date = _log_date
      AND office_location = COALESCE(_office, 'San Diego');
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $function$;

-- Backfill: absolute counts from the pins that already exist. Only days
-- since result-counts-as-knock (2026-09-11) — see header. Office derivation
-- matches the trigger (the canvasser's CURRENT office).
WITH agg AS (
  SELECT canvasser_id, log_date, count(*)::int AS nh
  FROM public.field_pins
  WHERE pin_type = 'not_home'
    AND NOT is_remote_drop
    AND log_date >= DATE '2026-09-11'
  GROUP BY canvasser_id, log_date
)
INSERT INTO public.daily_logs (canvasser_id, team_id, log_date, office_location, not_home)
SELECT a.canvasser_id, p.team_id, a.log_date, COALESCE(p.office_location, 'San Diego'), a.nh
FROM agg a
JOIN public.profiles p ON p.id = a.canvasser_id
ON CONFLICT (canvasser_id, log_date, office_location) DO UPDATE
  SET not_home = EXCLUDED.not_home,
      updated_at = now();
