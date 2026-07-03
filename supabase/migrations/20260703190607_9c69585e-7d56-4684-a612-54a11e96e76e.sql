
ALTER TYPE public.pin_type ADD VALUE IF NOT EXISTS 'knock';
ALTER TYPE public.pin_type ADD VALUE IF NOT EXISTS 'not_interested';

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

  INSERT INTO public.daily_logs (
    canvasser_id, team_id, log_date,
    doors_knocked, people_talked_to, not_interested, leads_called_in
  )
  VALUES (
    NEW.canvasser_id,
    _team,
    NEW.log_date,
    CASE WHEN NEW.pin_type IN ('knock','not_home') THEN 1 ELSE 0 END,
    CASE WHEN NEW.pin_type = 'talked_to' THEN 1 ELSE 0 END,
    CASE WHEN NEW.pin_type = 'not_interested' THEN 1 ELSE 0 END,
    CASE WHEN NEW.pin_type = 'lead' THEN 1 ELSE 0 END
  )
  ON CONFLICT (canvasser_id, log_date) DO UPDATE
    SET doors_knocked    = public.daily_logs.doors_knocked    + EXCLUDED.doors_knocked,
        people_talked_to = public.daily_logs.people_talked_to + EXCLUDED.people_talked_to,
        not_interested   = public.daily_logs.not_interested   + EXCLUDED.not_interested,
        leads_called_in  = public.daily_logs.leads_called_in  + EXCLUDED.leads_called_in,
        updated_at       = now();
  RETURN NEW;
END $function$;
