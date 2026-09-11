-- Fernandez, George & Christy — one $12,583 office upsell counted TWICE
-- under the Job Walk channel on 2026-09-11 (Fleet Dispatch showed $25,166).
-- Authored 2026-09-11 from the SD Block 9/7/26-9/13/26 activity log.
--
-- What happened (all ~9:38–9:40 AM PT, Friday group):
--   1. The office priced the ORIGINAL card #13019707187 ($12,583) and set
--      Sale = "Upsell" (Iss = "Office Appt", Source = "Job Walk") → the
--      webhook minted confirmed lead #1 on the Job Walk channel profile.
--   2. Seconds later the card was DUPLICATED → #13027796653 "… (copy)",
--      born already-sold at the same price → confirmed lead #2. Office
--      cards write no Card_Outcome_Recorded markers (the credit gate zeroes
--      bucket), so the copy gate's marker-based family sync never fired and
--      the sale sync's per-pulseId lookup couldn't see the twin. Root cause
--      fixed forward in the same PR (family-wide lead lookup in
--      monday-live-dispatch); this file repairs the data.
--   3. The ORIGINAL was then moved to the Sales Processing board — the
--      Block board holds ONE card (the copy), the leads table held TWO rows.
--
-- Keep / void — REVERSED from the week0824 file's convention, on purpose:
--   keep #13027796653 (the "(copy)" — the card that SURVIVES on the Block
--        board; board = ground truth, and every future price edit webhooks
--        from this pulse)
--   void #13019707187 (the original — moved off to Sales Processing; its
--        block_cards row will purge on a future full sync, after which
--        nothing on the Block board can reach its lead)
--
-- No outcome counters to revert: office-appt cards never tick canvasser
-- counters or write outcome markers — the damage is the one duplicate lead
-- (volume only; channel leads carry no canvasser and pay no commission).
--
-- Safety: voided (UPDATE, never DELETE), and only while the keeper twin is
-- still confirmed at the same amount, so a half-applied state can never
-- leave the customer with no lead at all. deny_reason is a custom tag (not
-- the webhook's revert marker), so no sync will ever resurrect the void.
-- Idempotent via the Manual_Correction tag.
-- Run in the xogit (xogitpqeuwalerxygvjw) SQL editor.
--
-- Pre-flight (read-only, expect two confirmed rows at 12583):
--   SELECT id, monday_item_id, canvasser_id, sale_amount, status,
--          created_at, reviewed_at
--     FROM public.leads
--    WHERE monday_item_id IN ('13019707187', '13027796653');

BEGIN;

DO $$
DECLARE
  v_leads int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.webhook_logs
             WHERE step = 'Manual_Correction'
               AND data->>'tag' = 'fernandez-copy-double-20260911') THEN
    RAISE NOTICE 'fernandez-copy-double-20260911 already applied';
    RETURN;
  END IF;

  UPDATE public.leads v
     SET status = 'denied',
         deny_reason = 'Duplicate copy-family lead — fernandez-copy-double-20260911 (kept 13027796653)'
    FROM public.leads k
   WHERE v.monday_item_id = '13019707187' AND v.status = 'confirmed'
     AND k.monday_item_id = '13027796653' AND k.status = 'confirmed'
     AND k.sale_amount = v.sale_amount;
  IF FOUND THEN v_leads := 1; END IF;

  INSERT INTO public.webhook_logs (step, data) VALUES ('Manual_Correction',
    jsonb_build_object('tag', 'fernandez-copy-double-20260911',
      'customer', 'Fernandez, George & Christy',
      'kept', '13027796653', 'voided', '13019707187',
      'sale_amount', 12583, 'leads_voided', v_leads));
END $$;

COMMIT;

-- The dashboard editor swallows RAISE NOTICE — read the outcome here
-- (leads_voided = 1 on the first run, 0 means the guard found no twin pair):
SELECT data->>'leads_voided' AS leads_voided, created_at
  FROM public.webhook_logs
 WHERE step = 'Manual_Correction'
   AND data->>'tag' = 'fernandez-copy-double-20260911';
