-- ═══════════════════════════════════════════════════════════════════════════
-- PUSH NOTIFICATIONS FOR REP SALES (rep audit R-11, 2026-09-12).
-- When a Block card TRANSITIONS to a kept sale (the webhook mirrors the
-- office marking the Sale cell), a trigger POSTs (via pg_net, async, never
-- blocking the ingestion write) to the notify-rep-sale edge function, which
-- Web-Pushes ONLY the card's own reps' devices: "KA-CHING — sale confirmed".
--
-- SAFETY CONTRACT — block_cards is the PRODUCTION INGESTION table (the
-- Monday webhook writes it live): every branch of this trigger is wrapped
-- so a notification failure can never fail a card write.
--  · UPDATE transitions only — a Full History sync INSERTs thousands of
--    already-sold historical cards and must stay silent.
--  · card_date within the last day (LA) — stale-group daymoves stay silent.
--  · rep_sale_notifications dedupes: one push per card, ever (re-syncs and
--    webhook echo-upserts re-fire the trigger; ON CONFLICT swallows them).
-- Reuses the 'notify_secret' vault secret from 20260824120000.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE TABLE IF NOT EXISTS public.rep_sale_notifications (
  monday_item_id text PRIMARY KEY,
  notified_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.rep_sale_notifications ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: trigger (definer) and service role only.

CREATE OR REPLACE FUNCTION public.notify_rep_sale()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _secret text;
  _sold constant text[] := ARRAY['sold', 'reload', 'upsell', 'sale'];
BEGIN
  -- Transitions only: INSERTs are backfills/board pulls, not live closes.
  IF TG_OP <> 'UPDATE' THEN RETURN NEW; END IF;
  IF NOT (lower(trim(coalesce(NEW.sale, ''))) = ANY (_sold)) THEN RETURN NEW; END IF;
  IF lower(trim(coalesce(OLD.sale, ''))) = ANY (_sold) THEN RETURN NEW; END IF;
  -- A card arriving already-cancelled is not a celebration.
  IF coalesce(NEW.wcc, '') ~* 'cancel' OR coalesce(NEW.wcc, '') ~* '\mctc\M' THEN
    RETURN NEW;
  END IF;
  IF NEW.card_date IS NULL
     OR NEW.card_date < ((now() AT TIME ZONE 'America/Los_Angeles')::date - 1) THEN
    RETURN NEW;
  END IF;
  IF NEW.reps IS NULL OR array_length(NEW.reps, 1) IS NULL THEN RETURN NEW; END IF;

  BEGIN
    -- One push per card, ever.
    INSERT INTO public.rep_sale_notifications (monday_item_id)
    VALUES (NEW.monday_item_id)
    ON CONFLICT (monday_item_id) DO NOTHING;
    IF NOT FOUND THEN RETURN NEW; END IF;

    SELECT decrypted_secret INTO _secret
    FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
    IF _secret IS NULL OR _secret = '' THEN RETURN NEW; END IF;

    PERFORM net.http_post(
      url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/notify-rep-sale',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-notify-secret', _secret
      ),
      body := jsonb_build_object(
        'monday_item_id', NEW.monday_item_id,
        'lead_name', NEW.lead_name,
        'sale_price', NEW.sale_price,
        'reps', to_jsonb(NEW.reps),
        'office_location', NEW.office_location
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- a notification must NEVER break an ingestion write
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS block_cards_notify_rep_sale ON public.block_cards;
CREATE TRIGGER block_cards_notify_rep_sale
  AFTER UPDATE ON public.block_cards
  FOR EACH ROW EXECUTE FUNCTION public.notify_rep_sale();
