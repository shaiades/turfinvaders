-- Office follows the work: daily_logs rows carry the office where the work
-- happened (the Block board that produced it), so one rep can have an SD row
-- and an OC row for the same day and the Executive Dashboard's office filter
-- attributes work — not people. Key becomes (canvasser_id, log_date,
-- office_location). All pay/rank/bonus functions SUM over daily_logs, so
-- multi-row days are payroll-safe. Idempotent.

ALTER TABLE public.daily_logs
  ADD COLUMN IF NOT EXISTS office_location text NOT NULL DEFAULT 'San Diego';

-- Backfill pre-existing rows from the rep's home office (rows written before
-- this migration were single-per-day under the profile office model).
UPDATE public.daily_logs dl
SET office_location = COALESCE(p.office_location, 'San Diego')
FROM public.profiles p
WHERE p.id = dl.canvasser_id
  AND dl.office_location = 'San Diego'
  AND COALESCE(p.office_location, 'San Diego') <> 'San Diego';

-- Swap the unique key: drop any 2-column unique on (canvasser_id, log_date),
-- then add the office-aware key. Same transaction as the trigger replacement
-- below so no window exists where the trigger's ON CONFLICT has no arbiter.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'public.daily_logs'::regclass
      AND con.contype = 'u'
      AND array_length(con.conkey, 1) = 2
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attname = 'canvasser_id' AND a.attnum = ANY (con.conkey))
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attname = 'log_date' AND a.attnum = ANY (con.conkey))
  LOOP
    EXECUTE format('ALTER TABLE public.daily_logs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS daily_logs_canvasser_date_office_key
  ON public.daily_logs (canvasser_id, log_date, office_location);

-- Field pins bump the canvasser's HOME-office row (door knocking happens in
-- their own office's turf).
CREATE OR REPLACE FUNCTION public.bump_daily_log_from_pin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _team uuid;
  _office text;
BEGIN
  IF NEW.is_remote_drop THEN
    RETURN NEW;
  END IF;

  SELECT team_id, COALESCE(office_location, 'San Diego')
    INTO _team, _office
  FROM public.profiles WHERE id = NEW.canvasser_id;

  INSERT INTO public.daily_logs (
    canvasser_id, team_id, log_date, office_location,
    doors_knocked, people_talked_to, not_interested, leads_called_in
  )
  VALUES (
    NEW.canvasser_id,
    _team,
    NEW.log_date,
    COALESCE(_office, 'San Diego'),
    CASE WHEN NEW.pin_type IN ('knock','not_home') THEN 1 ELSE 0 END,
    CASE WHEN NEW.pin_type = 'talked_to' THEN 1 ELSE 0 END,
    CASE WHEN NEW.pin_type = 'not_interested' THEN 1 ELSE 0 END,
    CASE WHEN NEW.pin_type = 'lead' THEN 1 ELSE 0 END
  )
  ON CONFLICT (canvasser_id, log_date, office_location) DO UPDATE
    SET doors_knocked    = public.daily_logs.doors_knocked    + EXCLUDED.doors_knocked,
        people_talked_to = public.daily_logs.people_talked_to + EXCLUDED.people_talked_to,
        not_interested   = public.daily_logs.not_interested   + EXCLUDED.not_interested,
        leads_called_in  = public.daily_logs.leads_called_in  + EXCLUDED.leads_called_in,
        updated_at       = now();
  RETURN NEW;
END $function$;

-- Logan van has never had a captain assigned in the app.
UPDATE public.teams SET captain_id = p.id
FROM public.profiles p
WHERE teams.name = 'Logan'
  AND p.display_name = 'Logan temple'
  AND teams.captain_id IS NULL;
