
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.auto_clock_out_expired()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _rec RECORD;
  _local_date date;
  _dow int;
  _cutoff_local timestamp;
  _cutoff_utc timestamptz;
  _now_local timestamp := (now() AT TIME ZONE 'America/Los_Angeles');
  _affected int := 0;
BEGIN
  FOR _rec IN
    SELECT id, clock_in
    FROM public.time_entries
    WHERE clock_out IS NULL
  LOOP
    -- Anchor the shift end to the LA-local date of the clock-in.
    _local_date := (_rec.clock_in AT TIME ZONE 'America/Los_Angeles')::date;
    _dow := EXTRACT(ISODOW FROM _local_date)::int; -- 1=Mon..7=Sun

    IF _dow BETWEEN 1 AND 5 THEN
      _cutoff_local := _local_date + time '18:00';   -- 6 PM weekdays
    ELSIF _dow = 6 THEN
      _cutoff_local := _local_date + time '17:00';   -- 5 PM Saturday
    ELSE
      _cutoff_local := _local_date + time '18:00';   -- Sunday fallback
    END IF;

    _cutoff_utc := _cutoff_local AT TIME ZONE 'America/Los_Angeles';

    -- Only auto-close once we are PAST the shift end in LA time.
    IF _now_local >= _cutoff_local THEN
      UPDATE public.time_entries
      SET clock_out = GREATEST(_cutoff_utc, clock_in)
      WHERE id = _rec.id;
      _affected := _affected + 1;
    END IF;
  END LOOP;
  RETURN _affected;
END $$;

REVOKE ALL ON FUNCTION public.auto_clock_out_expired() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_clock_out_expired() TO service_role;

-- Replace any prior schedule, then register a fresh 15-minute job.
DO $$
DECLARE _jid int;
BEGIN
  SELECT jobid INTO _jid FROM cron.job WHERE jobname = 'time-entries-auto-clock-out';
  IF _jid IS NOT NULL THEN PERFORM cron.unschedule(_jid); END IF;
END $$;

SELECT cron.schedule(
  'time-entries-auto-clock-out',
  '*/15 * * * *',
  $$ SELECT public.auto_clock_out_expired(); $$
);
