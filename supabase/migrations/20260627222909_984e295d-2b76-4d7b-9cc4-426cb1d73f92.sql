
-- 1. status column
DO $$ BEGIN
  CREATE TYPE public.canvasser_status AS ENUM ('active', 'suspended', 'inactive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS status public.canvasser_status NOT NULL DEFAULT 'active';

-- 2. Suspension evaluator: for a given canvasser, look at the two most recent
-- working days (Mon-Fri) on which they actually logged anything. If BOTH show
-- leads_called_in=0 AND confirmed_leads=0, mark as suspended. Otherwise, if
-- currently suspended due to the rule, leave the status alone (manual unsuspend).
CREATE OR REPLACE FUNCTION public.evaluate_canvasser_suspension(_canvasser_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _zero_count int;
BEGIN
  WITH recent AS (
    SELECT log_date, leads_called_in, confirmed_leads
    FROM public.daily_logs
    WHERE canvasser_id = _canvasser_id
      AND EXTRACT(ISODOW FROM log_date) BETWEEN 1 AND 5
    ORDER BY log_date DESC
    LIMIT 2
  )
  SELECT COUNT(*) INTO _zero_count
  FROM recent
  WHERE COALESCE(leads_called_in,0) = 0
    AND COALESCE(confirmed_leads,0) = 0;

  IF _zero_count >= 2 THEN
    UPDATE public.profiles
    SET status = 'suspended'
    WHERE id = _canvasser_id AND status <> 'suspended';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION public.evaluate_canvasser_suspension(uuid) FROM PUBLIC, anon, authenticated;

-- 3. Trigger on daily_logs
CREATE OR REPLACE FUNCTION public.trg_evaluate_suspension()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.evaluate_canvasser_suspension(NEW.canvasser_id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS daily_logs_evaluate_suspension ON public.daily_logs;
CREATE TRIGGER daily_logs_evaluate_suspension
AFTER INSERT OR UPDATE ON public.daily_logs
FOR EACH ROW EXECUTE FUNCTION public.trg_evaluate_suspension();
