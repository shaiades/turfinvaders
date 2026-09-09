-- ═══════════════════════════════════════════════════════════════════════════
-- PUSH NOTIFICATIONS FOR TURF ASSIGNMENT (2026-09-09).
-- When a turf gains an assignee (INSERT that arrives assigned, or an UPDATE
-- that hands the turf to someone new), a database trigger POSTs (via pg_net,
-- async, never blocking the turf write) to the notify-turf-assigned edge
-- function, which Web-Pushes ONLY the assigned user's own devices.
--
-- Reuses the 'notify_secret' vault secret created alongside 20260824120000
-- (flagged-punch pushes) — no new secret to provision. No secret stored =
-- the trigger no-ops (turf writes always succeed regardless).
-- Idempotent; apply by hand in the Supabase dashboard SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.notify_turf_assignment()
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
    _secret := NULL; -- vault unavailable → notifications off, turf writes fine
  END;
  IF _secret IS NULL OR _secret = '' THEN RETURN NEW; END IF;
  -- Only a fresh assignee notifies; unassignment and untouched-assignee
  -- updates stay quiet.
  IF NEW.assigned_user_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.assigned_user_id IS NOT DISTINCT FROM OLD.assigned_user_id) THEN
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/notify-turf-assigned',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-notify-secret', _secret
      ),
      body := jsonb_build_object(
        'turf_id', NEW.id,
        'turf_name', NEW.name,
        'assigned_user_id', NEW.assigned_user_id
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- a notification must never break a turf write
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS turfs_notify_assignment ON public.turfs;
CREATE TRIGGER turfs_notify_assignment
  AFTER INSERT OR UPDATE OF assigned_user_id ON public.turfs
  FOR EACH ROW EXECUTE FUNCTION public.notify_turf_assignment();
