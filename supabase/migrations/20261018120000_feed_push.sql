-- ═══════════════════════════════════════════════════════════════════════════
-- ARCADE §7 — field-wide push for Street Feed BIG moments (shoutout, crowning,
-- sale, van lead-change), capped at ≤5/day. A trigger on feed_events fires the
-- notify-feed edge function via pg_net.
--
-- SAFETY:
--   · DORMANT behind arcade_flags.feed_push (default FALSE) — the trigger is a
--     flag-read + return until the owner flips it on. Cap is feed_push_daily_cap
--     (default 5), tunable.
--   · AFTER INSERT + double EXCEPTION-safe — a push failure can never roll back
--     the feed_events insert (and so never the lead write that produced it).
--   · pg_net is fire-and-forget; the 'notify_secret' vault secret + NOTIFY_SECRET
--     gate the edge function (reused from the other notify-* functions).
--
-- Also deploy the function (owner): supabase functions deploy notify-feed --no-verify-jwt
-- Activate: UPDATE public.arcade_flags SET feed_push = true;
-- Idempotent. Apply via:
--   supabase db query --linked --file supabase/migrations/20261018120000_feed_push.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.arcade_flags
  ADD COLUMN IF NOT EXISTS feed_push boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS feed_push_daily_cap int NOT NULL DEFAULT 5;

CREATE TABLE IF NOT EXISTS public.feed_push_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  feed_event_id uuid,
  pushed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_push_log_pushed_idx ON public.feed_push_log (pushed_at DESC);
GRANT ALL ON public.feed_push_log TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.arcade_feed_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _on boolean;
  _cap int;
  _today date;
  _n int;
  _secret text;
  _title text;
BEGIN
  SELECT feed_push, feed_push_daily_cap INTO _on, _cap FROM public.arcade_flags WHERE id = 1;
  IF _on IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  -- Push only the big moments — sits stay in-feed only.
  IF NEW.kind NOT IN ('shoutout', 'crowning', 'sale', 'van_lead') THEN
    RETURN NULL;
  END IF;

  _today := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  SELECT count(*) INTO _n FROM public.feed_push_log
  WHERE (pushed_at AT TIME ZONE 'America/Los_Angeles')::date = _today;
  IF _n >= COALESCE(_cap, 5) THEN
    RETURN NULL; -- daily cap reached
  END IF;

  INSERT INTO public.feed_push_log (feed_event_id) VALUES (NEW.id);

  _title := CASE NEW.kind
    WHEN 'shoutout' THEN '📣 Shoutout'
    WHEN 'crowning' THEN '👑 Van Wars champion'
    WHEN 'sale' THEN '💰 New sale'
    WHEN 'van_lead' THEN '🏁 New leader'
    ELSE 'Street Feed'
  END;

  BEGIN
    SELECT decrypted_secret INTO _secret FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
    IF _secret IS NULL OR _secret = '' THEN
      RETURN NULL;
    END IF;
    PERFORM net.http_post(
      url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/notify-feed',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', _secret),
      body := jsonb_build_object(
        'title', _title,
        'body', NEW.body,
        'url', '/leaderboard',
        'tag', left(NEW.id::text, 8)
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- a push failure must never surface
  END;

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL; -- never break the feed_events insert
END;
$$;

REVOKE ALL ON FUNCTION public.arcade_feed_push() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS arcade_feed_push_trg ON public.feed_events;
CREATE TRIGGER arcade_feed_push_trg
  AFTER INSERT ON public.feed_events
  FOR EACH ROW EXECUTE FUNCTION public.arcade_feed_push();
