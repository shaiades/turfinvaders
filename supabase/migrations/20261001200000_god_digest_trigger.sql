-- ═══════════════════════════════════════════════════════════════════════════
-- GOD MODE DIGEST DELIVERY VIA DATABASE TRIGGER (owner directive 2026-10-01).
-- The Vercel cron route composes the morning brief and claims the LA date by
-- inserting a webhook_logs row (step God_Digest_Sent). THIS trigger is the
-- delivery leg: it POSTs the brief (via pg_net, async, never blocking the
-- insert) to the notify-owner-digest edge function with the shared
-- notify_secret from the vault — the exact doctrine of the flagged-punch,
-- daily-wrap and dojo pushes (20260824120000). Direct Vercel→edge delivery
-- was abandoned: the two sides' service-key copies do not match on this
-- project, so that path 401s structurally.
-- Idempotent: re-running replaces the function and trigger in place.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.notify_god_digest()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _secret text;
BEGIN
  IF NEW.step IS DISTINCT FROM 'God_Digest_Sent' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.data->>'body', '') = '' THEN RETURN NEW; END IF;
  BEGIN
    SELECT decrypted_secret INTO _secret
    FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    _secret := NULL; -- vault unavailable → no push, the claim row still lands
  END;
  IF _secret IS NULL OR _secret = '' THEN RETURN NEW; END IF;

  BEGIN
    PERFORM net.http_post(
      url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/notify-owner-digest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-notify-secret', _secret
      ),
      body := jsonb_build_object(
        'title', COALESCE(NEW.data->>'title', 'God Mode · morning brief'),
        'body', NEW.data->>'body',
        'url', '/god-mode'
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- delivery must never break the dedupe claim
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS webhook_logs_zz_god_digest ON public.webhook_logs;
CREATE TRIGGER webhook_logs_zz_god_digest
  AFTER INSERT ON public.webhook_logs
  FOR EACH ROW EXECUTE FUNCTION public.notify_god_digest();
