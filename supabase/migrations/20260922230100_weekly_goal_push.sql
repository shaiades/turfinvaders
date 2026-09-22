-- ═══════════════════════════════════════════════════════════════════════════
-- MONDAY-MORNING GOAL PUSH (owner ask 2026-09-22).
-- Every Monday at 7 AM PT, push "New week — set your goal" to every
-- sales_rep's subscribed devices via the notify-weekly-goal edge function,
-- deep-linking to /close-kombat?tab=goals. The in-app once-per-week
-- auto-open of the Goals tab is the guaranteed channel; this is the
-- morning nudge that starts the ritual.
--
-- Design is a clone of 20260922180000_daily_wrap_push:
--  · ONE pg_cron job, TWO DST-straddling UTC slots — '0 14,15 * * 1' covers
--    7:00 PDT (14:00 UTC) and 7:00 PST (15:00 UTC); the in-function LA-hour
--    guard lets exactly one slot through, DST-correct forever. Both UTC
--    Monday slots are still Monday morning in LA, so _today IS the week
--    start — no cross-midnight offset math.
--  · Guards live HERE, not in the edge function, so wrong-slot runs never
--    make an HTTP call and the weekly dedupe claim is atomic:
--      LA hour == 7 → LA isodow == 1 → INSERT-claim weekly_goal_push_log.
--    No activity skip-check on purpose: the nudge is wanted even on a slow
--    Monday — setting the goal is the day's first act, not a reaction.
--  · pg_net is fire-and-forget: if the edge function fails after the claim,
--    the week is burned — the manual resend is a curl to notify-weekly-goal
--    (idempotent on-device via its goal-week-<monday> tag).
-- Reuses the 'notify_secret' vault secret from 20260824120000.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- One row per LA week (its Monday) a push went out.
CREATE TABLE IF NOT EXISTS public.weekly_goal_push_log (
  week_start_iso date PRIMARY KEY,
  sent_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.weekly_goal_push_log ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: cron (definer) and service role only.

CREATE OR REPLACE FUNCTION public.send_weekly_goal_push()
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

  -- Exactly one of the two Monday UTC slots is 7 AM in LA.
  IF extract(hour FROM _now_la) <> 7 THEN RETURN; END IF;
  -- Monday only — with the 14:00/15:00 UTC slots this always holds, but a
  -- manual SELECT of this function must stay honest on other days too.
  IF extract(isodow FROM _today) <> 1 THEN RETURN; END IF;

  -- One push per week, ever (idempotent under manual SELECTs too).
  INSERT INTO public.weekly_goal_push_log (week_start_iso) VALUES (_today)
  ON CONFLICT (week_start_iso) DO NOTHING;
  IF NOT FOUND THEN RETURN; END IF;

  BEGIN
    SELECT decrypted_secret INTO _secret
    FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
    IF _secret IS NULL OR _secret = '' THEN RETURN; END IF;

    PERFORM net.http_post(
      url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/notify-weekly-goal',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-notify-secret', _secret
      ),
      body := jsonb_build_object('week_start', _today)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- a notification failure must never surface as a cron error storm
  END;
END $$;

REVOKE ALL ON FUNCTION public.send_weekly_goal_push() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_weekly_goal_push() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weekly-goal-push') THEN
    PERFORM cron.unschedule('weekly-goal-push');
  END IF;
  PERFORM cron.schedule(
    'weekly-goal-push',
    '0 14,15 * * 1',
    $CRON$ SELECT public.send_weekly_goal_push(); $CRON$
  );
END $$;
