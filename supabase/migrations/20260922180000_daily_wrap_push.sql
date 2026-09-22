-- ═══════════════════════════════════════════════════════════════════════════
-- END-OF-DAY RESULTS PUSH (owner ask 2026-09-22).
-- At the 6 PM PT report lock, every worked day (Mon–Sat), push "Day results
-- are in" to the field tier's subscribed devices via the notify-daily-wrap
-- edge function. The in-app EodRecapFx cutscene is the guaranteed channel
-- (auto-plays on next app open); this is the same-evening nudge.
--
-- Design (models: 20260912230000_rep_sale_push, the auto-clock-out cron):
--  · ONE pg_cron job, TWO DST-straddling UTC slots — '5 1,2 * * *' covers
--    18:05 PDT (01:05 UTC) and 18:05 PST (02:05 UTC); the in-function
--    LA-hour guard lets exactly one slot through, DST-correct forever.
--  · Guards live HERE, not in the edge function, so wrong-slot runs never
--    make an HTTP call and the daily dedupe claim is atomic:
--      LA hour == 18 → not Sunday → somebody clocked in today (zero-config
--      holiday skip, checked BEFORE the dedupe so a skipped day doesn't
--      burn its row) → INSERT-claim eod_push_log.
--  · pg_net is fire-and-forget: if the edge function fails after the claim,
--    the day is burned — the manual resend is a curl to notify-daily-wrap
--    (idempotent on-device via its eod-<day> tag).
-- Reuses the 'notify_secret' vault secret from 20260824120000.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- One row per LA day a push went out.
CREATE TABLE IF NOT EXISTS public.eod_push_log (
  day_iso date PRIMARY KEY,
  sent_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.eod_push_log ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: cron (definer) and service role only.

CREATE OR REPLACE FUNCTION public.send_daily_wrap_push()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _now_la timestamp;
  _today date;
  _secret text;
BEGIN
  _now_la := now() AT TIME ZONE 'America/Los_Angeles';
  _today  := _now_la::date;

  -- Exactly one of the two daily UTC slots is 6 PM in LA.
  IF extract(hour FROM _now_la) <> 18 THEN RETURN; END IF;
  -- Sundays are never worked days.
  IF extract(isodow FROM _today) = 7 THEN RETURN; END IF;
  -- Holiday/day-off skip: no non-voided punches today = nothing to announce.
  -- Checked BEFORE the dedupe claim so a skipped day doesn't burn its row.
  IF NOT EXISTS (
    SELECT 1 FROM public.time_entries
    WHERE log_date = _today AND voided_at IS NULL
  ) THEN RETURN; END IF;

  -- One push per day, ever (both UTC slots can't be 18:00 LA, but a manual
  -- SELECT of this function must stay idempotent too).
  INSERT INTO public.eod_push_log (day_iso) VALUES (_today)
  ON CONFLICT (day_iso) DO NOTHING;
  IF NOT FOUND THEN RETURN; END IF;

  BEGIN
    SELECT decrypted_secret INTO _secret
    FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
    IF _secret IS NULL OR _secret = '' THEN RETURN; END IF;

    PERFORM net.http_post(
      url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/notify-daily-wrap',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-notify-secret', _secret
      ),
      body := jsonb_build_object('day_iso', _today)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- a notification failure must never surface as a cron error storm
  END;
END $$;

REVOKE ALL ON FUNCTION public.send_daily_wrap_push() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_daily_wrap_push() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-wrap-push') THEN
    PERFORM cron.unschedule('daily-wrap-push');
  END IF;
  PERFORM cron.schedule(
    'daily-wrap-push',
    '5 1,2 * * *',
    $CRON$ SELECT public.send_daily_wrap_push(); $CRON$
  );
END $$;
