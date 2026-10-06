-- ═══════════════════════════════════════════════════════════════════════════
-- PUSH NOTIFICATIONS FOR LEADS ISSUED TO A REP (owner, 2026-10-06).
-- The symmetric twin of the rep-sale KA-CHING (20260912230000): when a Block
-- card gains a NEW rep on the "Reps" people column (people6) — the office or
-- live dispatch (Step 7) handing a lead over — a trigger POSTs (via pg_net,
-- async, never blocking the ingestion write) to the notify-lead-issued edge
-- function, which Web-Pushes ONLY the freshly-issued reps' own devices:
-- "KA-CHING — new lead!". Monday fires its own "New Opportunity!" text in
-- parallel; this is the celebratory cash-register ping on the rep's phone.
--
-- SAFETY CONTRACT — block_cards is the PRODUCTION INGESTION table (the Monday
-- webhook rebuilds and upserts a card on EVERY column change): every branch is
-- wrapped so a notification failure can never fail a card write.
--  · UPDATE transitions only — a Full History sync INSERTs thousands of
--    already-staffed historical cards and must stay silent.
--  · Only reps NEWLY present (NEW.reps minus OLD.reps) are notified — a
--    re-upsert that leaves reps unchanged, or re-marks an unrelated column,
--    pushes nobody.
--  · A card that is already a kept sale is skipped — a rep added to a closed
--    deal is a commission split, not a fresh lead (that's the sale KA-CHING's
--    job). A cancelled card is skipped too.
--  · card_date within the last day (LA) — stale-group daymoves / history stay
--    silent.
--  · lead_issued_notifications dedupes per (card, rep): a rep is pinged once
--    per lead, ever (webhook redeliveries and echo-upserts re-fire the
--    trigger; ON CONFLICT swallows them). A genuinely different rep on the
--    same card still gets their own ping.
-- Reuses the 'notify_secret' vault secret from 20260824120000.
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261015120000_lead_issued_push.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE TABLE IF NOT EXISTS public.lead_issued_notifications (
  monday_item_id text NOT NULL,
  rep_name       text NOT NULL,
  notified_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (monday_item_id, rep_name)
);
ALTER TABLE public.lead_issued_notifications ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: trigger (definer) and service role only.

-- Sale-column values that mean the card is already a kept sale — mirrors
-- SOLD_VALUES in block-cards.ts / notify_rep_sale.
CREATE OR REPLACE FUNCTION public.notify_lead_issued()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _secret     text;
  _sold       constant text[] := ARRAY['sold', 'reload', 'upsell', 'sale'];
  _new_reps   text[];
  _to_notify  text[];
BEGIN
  -- Transitions only: INSERTs are backfills / board pulls, not live hand-offs.
  IF TG_OP <> 'UPDATE' THEN RETURN NEW; END IF;

  -- Reps NEWLY on the card (present in NEW, absent in OLD). Trimmed + non-empty.
  SELECT array_agg(r) INTO _new_reps
  FROM (
    SELECT DISTINCT trim(r) AS r
    FROM unnest(coalesce(NEW.reps, '{}'::text[])) AS r
    WHERE trim(r) <> ''
      AND trim(r) <> ALL (
        SELECT coalesce(trim(o), '') FROM unnest(coalesce(OLD.reps, '{}'::text[])) AS o
      )
  ) s;
  IF _new_reps IS NULL OR array_length(_new_reps, 1) IS NULL THEN RETURN NEW; END IF;

  -- A card already closed is a commission split, not a fresh lead.
  IF lower(trim(coalesce(NEW.sale, ''))) = ANY (_sold) THEN RETURN NEW; END IF;
  -- A card arriving cancelled is not a hand-off worth celebrating.
  IF coalesce(NEW.wcc, '') ~* 'cancel' OR coalesce(NEW.wcc, '') ~* '\mctc\M' THEN
    RETURN NEW;
  END IF;
  -- Today's leads only (last-day LA window); never ping on historical staffing.
  IF NEW.card_date IS NULL
     OR NEW.card_date < ((now() AT TIME ZONE 'America/Los_Angeles')::date - 1) THEN
    RETURN NEW;
  END IF;

  BEGIN
    -- One push per (card, rep), ever. Keep only the reps we actually claimed.
    WITH ins AS (
      INSERT INTO public.lead_issued_notifications (monday_item_id, rep_name)
      SELECT NEW.monday_item_id, r FROM unnest(_new_reps) AS r
      ON CONFLICT (monday_item_id, rep_name) DO NOTHING
      RETURNING rep_name
    )
    SELECT array_agg(rep_name) INTO _to_notify FROM ins;
    IF _to_notify IS NULL OR array_length(_to_notify, 1) IS NULL THEN RETURN NEW; END IF;

    SELECT decrypted_secret INTO _secret
    FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
    IF _secret IS NULL OR _secret = '' THEN RETURN NEW; END IF;

    PERFORM net.http_post(
      url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/notify-lead-issued',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-notify-secret', _secret
      ),
      body := jsonb_build_object(
        'monday_item_id', NEW.monday_item_id,
        'lead_name', NEW.lead_name,
        'reps', to_jsonb(_to_notify),
        'office_location', NEW.office_location
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- a notification must NEVER break an ingestion write
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS block_cards_notify_lead_issued ON public.block_cards;
CREATE TRIGGER block_cards_notify_lead_issued
  AFTER UPDATE ON public.block_cards
  FOR EACH ROW EXECUTE FUNCTION public.notify_lead_issued();
