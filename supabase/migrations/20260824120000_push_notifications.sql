-- ═══════════════════════════════════════════════════════════════════════════
-- PUSH NOTIFICATIONS FOR FLAGGED PUNCHES (owner directive 2026-08-24).
-- When an entry gains needs_correction, a database trigger POSTs (via
-- pg_net, async, never blocking the punch) to the notify-flagged-punch
-- edge function, which Web-Pushes the review-queue audience: owners,
-- Managers, and the worker's own captain — never the worker themselves.
--
-- APPLY NOTE (one-off, run alongside this file, NOT committed — the value
-- matches the edge function's NOTIFY_SECRET and never enters git):
--   SELECT vault.create_secret('<NOTIFY_SECRET>', 'notify_secret');
-- The trigger reads vault.decrypted_secrets and sends the value as
-- x-notify-secret; the edge function rejects calls that don't carry it.
-- No secret stored = the trigger no-ops (punches always succeed regardless).
-- (ALTER DATABASE ... SET app.* is not permitted on Supabase — 42501.)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── 1) Device subscriptions ─────────────────────────────────────────────────

CREATE TABLE public.push_subscriptions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX push_subscriptions_user_idx ON public.push_subscriptions(user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO authenticated;
GRANT ALL ON public.push_subscriptions TO service_role;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own push subscriptions" ON public.push_subscriptions
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE TRIGGER push_subscriptions_touch_updated_at
  BEFORE UPDATE ON public.push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 2) Fan out on flag transitions ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_flagged_entry()
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
    _secret := NULL; -- vault unavailable → notifications off, punches fine
  END;
  IF _secret IS NULL OR _secret = '' THEN RETURN NEW; END IF;
  IF NEW.voided_at IS NOT NULL OR NOT NEW.needs_correction THEN RETURN NEW; END IF;
  -- Only the false→true transition notifies; edits to an already-flagged
  -- entry stay quiet (the queue still shows it).
  IF TG_OP = 'UPDATE' AND OLD.needs_correction THEN RETURN NEW; END IF;

  BEGIN
    PERFORM net.http_post(
      url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/notify-flagged-punch',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-notify-secret', _secret
      ),
      body := jsonb_build_object(
        'entry_id', NEW.id,
        'user_id', NEW.user_id,
        'log_date', NEW.log_date,
        'flag_reasons', to_jsonb(NEW.flag_reasons),
        'entry_source', NEW.entry_source
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- a notification must never break a punch
  END;
  RETURN NEW;
END $$;

CREATE TRIGGER time_entries_zz_notify
  AFTER INSERT OR UPDATE ON public.time_entries
  FOR EACH ROW EXECUTE FUNCTION public.notify_flagged_entry();
