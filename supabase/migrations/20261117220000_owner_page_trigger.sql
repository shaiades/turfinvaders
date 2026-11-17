-- ═══════════════════════════════════════════════════════════════════════════
-- OWNER PAGING THROUGH THE DATABASE (2026-11-17).
--
-- Owner pages (rotation failures, token-blindness canary, the God Mode
-- morning digest) used to be direct HTTPS calls from Vercel to the
-- notify-owner-digest edge function, authenticated by string-comparing
-- Vercel's SUPABASE_SERVICE_ROLE_KEY against the edge runtime's copy. The
-- two copies drifted, and every call from 11/11/26 through 11/17/26 was a
-- silent 401 — including the failure pages for the 11/16 board-rotation
-- outage, which is why nobody was paged while a week of crew results went
-- nowhere.
--
-- Same cure as the webhook secret (20261116220000): one source of truth.
-- Callers insert a webhook_logs row with step 'Owner_Page' and
-- data {title, body, url}; this trigger delivers it via pg_net to
-- notify-owner-digest using the vault's notify_secret — the exact pattern
-- every other push trigger (flagged punch, turf assigned, ...) already uses,
-- and those pushes work. Vercel then needs no secret that must match
-- anything: its DB write path is exercised on every cron run.
--
-- The insert is the audit trail; pg_net's HTTP result lands in
-- net._http_response for debugging. No secret in vault → trigger no-ops and
-- the row still records that a page was attempted.
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261117220000_owner_page_trigger.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.notify_owner_page()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO _secret
    FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    _secret := NULL; -- vault unavailable → page stays logged, push is skipped
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
        'title', COALESCE(NEW.data->>'title', 'Turf Invaders alert'),
        'body',  COALESCE(NEW.data->>'body', ''),
        'url',   COALESCE(NEW.data->>'url', '/fleet-dispatch')
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- paging must never break the caller's insert
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_owner_page ON public.webhook_logs;
CREATE TRIGGER trg_owner_page
  AFTER INSERT ON public.webhook_logs
  FOR EACH ROW
  WHEN (NEW.step = 'Owner_Page')
  EXECUTE FUNCTION public.notify_owner_page();
