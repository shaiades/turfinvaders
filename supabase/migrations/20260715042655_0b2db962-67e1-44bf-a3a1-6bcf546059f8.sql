
-- 1) is_active column
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS profiles_is_active_idx ON public.profiles (is_active);

-- 2) auto_archive_agents RPC
CREATE OR REPLACE FUNCTION public.auto_archive_agents()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _cutoff timestamptz := now() - interval '14 days';
  _archived integer := 0;
BEGIN
  WITH last_activity AS (
    SELECT canvasser_id, MAX(metric_date) AS last_date
    FROM public.daily_metrics
    GROUP BY canvasser_id
  ),
  targets AS (
    SELECT p.id
    FROM public.profiles p
    LEFT JOIN last_activity la ON la.canvasser_id = p.id
    WHERE p.is_active = true
      AND (
        (la.last_date IS NOT NULL AND la.last_date < (_cutoff)::date)
        OR (la.last_date IS NULL AND p.created_at < _cutoff)
      )
      -- Never archive owners.
      AND NOT public.has_role(p.id, 'owner'::app_role)
  )
  UPDATE public.profiles p
  SET is_active = false,
      team_id = NULL,
      updated_at = now()
  FROM targets t
  WHERE p.id = t.id;

  GET DIAGNOSTICS _archived = ROW_COUNT;
  RETURN _archived;
END;
$$;

REVOKE ALL ON FUNCTION public.auto_archive_agents() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auto_archive_agents() TO authenticated, service_role;

-- 3) Reactivate helper (owners/captains/office_staff only)
CREATE OR REPLACE FUNCTION public.reactivate_agent(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'captain'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  UPDATE public.profiles
  SET is_active = true, updated_at = now()
  WHERE id = _user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reactivate_agent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reactivate_agent(uuid) TO authenticated, service_role;

-- 4) Daily cron at 00:00 UTC (07:00 UTC ≈ midnight PT is also fine; using 08:00 UTC = midnight PT/PST)
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-archive-agents-daily') THEN
    PERFORM cron.unschedule('auto-archive-agents-daily');
  END IF;
  PERFORM cron.schedule(
    'auto-archive-agents-daily',
    '0 8 * * *',
    $CRON$ SELECT public.auto_archive_agents(); $CRON$
  );
END $$;
