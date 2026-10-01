-- ═══════════════════════════════════════════════════════════════════════════
-- LUNCH WARNING ALERT (owner ask 2026-10-01: "nobody works through lunch").
--
-- Prevention, not paperwork: when someone passes 4¼ hours on the clock with
-- no real lunch punched, their van CAPTAIN gets a push — "get them to lunch
-- before hour 5" — while there is still time to start a compliant 30-minute
-- meal (CA: it must START before the end of the 5th hour). The existing
-- missed-meal flag + premium stays the after-the-fact backstop; this fires
-- BEFORE the violation exists.
--
--   · pg_cron every 10 minutes → warnings land between 4h15m and ~4h25m.
--   · Strictly preventive: nothing fires past the 5-hour mark (a stale
--     cron catch-up must not nag about a lunch that is already late).
--   · Once per shift: lunch_warning_sent marks entries already warned.
--   · "Handled" = an OPEN meal (they are at lunch right now) or a closed
--     meal of 30+ minutes on the shift.
--   · Push rides the house loop: vault 'notify_secret' → pg_net →
--     notify-lunch-warning edge fn (captains of the worker's van).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE TABLE public.lunch_warning_sent (
  time_entry_id uuid NOT NULL PRIMARY KEY
    REFERENCES public.time_entries(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now()
);
-- Service-only bookkeeping: no client reads or writes.
ALTER TABLE public.lunch_warning_sent ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.lunch_warning_sent TO service_role;

CREATE OR REPLACE FUNCTION public.send_lunch_warnings()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _rec RECORD;
  _secret text;
  _sent int := 0;
BEGIN
  -- Cron / service contexts only (no JWT) — a signed-in user must not be
  -- able to fire the alert sweep.
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'send_lunch_warnings runs from cron/service contexts only';
  END IF;

  SELECT decrypted_secret INTO _secret
  FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
  IF _secret IS NULL OR _secret = '' THEN RETURN 0; END IF;

  FOR _rec IN
    SELECT te.id, te.user_id, te.clock_in,
           FLOOR(EXTRACT(EPOCH FROM (now() - te.clock_in)) / 60)::int AS worked_minutes
    FROM public.time_entries te
    WHERE te.clock_out IS NULL
      AND te.voided_at IS NULL
      AND now() - te.clock_in >= interval '4 hours 15 minutes'
      AND now() - te.clock_in <  interval '5 hours'
      AND NOT EXISTS (
        SELECT 1 FROM public.meal_periods mp
        WHERE mp.time_entry_id = te.id
          AND (mp.meal_end IS NULL
               OR mp.meal_end - mp.meal_start >= interval '30 minutes'))
      AND NOT EXISTS (
        SELECT 1 FROM public.lunch_warning_sent s WHERE s.time_entry_id = te.id)
  LOOP
    BEGIN
      INSERT INTO public.lunch_warning_sent (time_entry_id) VALUES (_rec.id);
      PERFORM net.http_post(
        url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/notify-lunch-warning',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-notify-secret', _secret
        ),
        body := jsonb_build_object(
          'time_entry_id', _rec.id,
          'user_id', _rec.user_id,
          'worked_minutes', _rec.worked_minutes
        )
      );
      _sent := _sent + 1;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- one bad row must never kill the sweep or the cron
    END;
  END LOOP;
  RETURN _sent;
END $$;

REVOKE ALL ON FUNCTION public.send_lunch_warnings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_lunch_warnings() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'lunch-warning-alerts') THEN
    PERFORM cron.unschedule('lunch-warning-alerts');
  END IF;
  PERFORM cron.schedule(
    'lunch-warning-alerts',
    '*/10 * * * *',
    $CRON$ SELECT public.send_lunch_warnings(); $CRON$
  );
END $$;
