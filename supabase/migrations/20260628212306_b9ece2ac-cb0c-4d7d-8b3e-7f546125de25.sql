
ALTER TABLE public.field_pins
  ADD COLUMN IF NOT EXISTS device_lat double precision,
  ADD COLUMN IF NOT EXISTS device_lng double precision,
  ADD COLUMN IF NOT EXISTS distance_m double precision,
  ADD COLUMN IF NOT EXISTS is_remote_drop boolean NOT NULL DEFAULT false;

-- Update bump trigger: only count valid (non-remote) pins toward daily counters
CREATE OR REPLACE FUNCTION public.bump_daily_log_from_pin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _team uuid;
BEGIN
  IF NEW.is_remote_drop THEN
    RETURN NEW;
  END IF;

  SELECT team_id INTO _team FROM public.profiles WHERE id = NEW.canvasser_id;

  INSERT INTO public.daily_logs (canvasser_id, team_id, log_date, people_talked_to, leads_called_in)
  VALUES (
    NEW.canvasser_id,
    _team,
    NEW.log_date,
    CASE WHEN NEW.pin_type = 'talked_to' THEN 1 ELSE 0 END,
    CASE WHEN NEW.pin_type = 'lead' THEN 1 ELSE 0 END
  )
  ON CONFLICT (canvasser_id, log_date) DO UPDATE
    SET people_talked_to = public.daily_logs.people_talked_to + EXCLUDED.people_talked_to,
        leads_called_in = public.daily_logs.leads_called_in + EXCLUDED.leads_called_in,
        updated_at = now();
  RETURN NEW;
END $function$;
