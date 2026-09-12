-- Fernandez, George & Christy — one $12,583 office upsell counted THREE
-- times under the Job Walk channel on 2026-09-11 (Fleet Dispatch showed
-- $25,166 when reported, $37,749 by late morning). Authored 2026-09-11 from
-- the SD Block 9/7/26-9/13/26 activity log + webhook_logs (verified in the
-- dashboard: three confirmed leads, one per pulseId, all $12,583).
--
-- What happened (Friday group; times UTC from webhook_logs):
--   1. 16:39:22 — the office priced the ORIGINAL card #13019707187
--      ($12,583) and set Sale = "Upsell" (Iss = "Office Appt", Source =
--      "Job Walk") → the webhook minted confirmed lead #1 on the Job Walk
--      channel profile (lead b563b429…).
--   2. 16:39:29 — the card was DUPLICATED → #13027796653 "… (copy)", born
--      already-sold → confirmed lead #2 (f74fea20…). Office cards write no
--      Card_Outcome_Recorded markers (the credit gate zeroes bucket), so
--      the copy gate's marker-based family sync never fired
--      (Copy_Item_Credited: "Sibling cards exist but none recorded an
--      outcome") and the sale sync's per-pulseId lookup couldn't see the
--      twin. The ORIGINAL was then moved to the Sales Processing board.
--   3. 17:15:52 — the office repeated the step: #13028167116
--      "… (copy) (copy)" appeared briefly (also sold, also routed to Job
--      Walk) → confirmed lead #3 (03b58572…), then left the board too.
--   All three Sale_Lead_Created events predate the family-dedupe deploy
--   (PR #172, deployed ~17:50 UTC) — pre-fix damage, no post-fix mints.
--
-- Keep / void — REVERSED from the week0824 file's convention, on purpose:
--   keep #13027796653 (the "(copy)" — the ONLY card that survives on the
--        Block board; board = ground truth, and every future price edit
--        webhooks from this pulse)
--   void #13019707187 (the original — moved off to Sales Processing) and
--        #13028167116 (the "(copy) (copy)" — created 17:15Z, off-board;
--        both rows' block_cards entries will purge on a future full sync,
--        after which nothing on the Block board can reach their leads)
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
-- Pre-flight (read-only, expect three confirmed rows at 12583 — verified
-- 2026-09-11 in the dashboard):
--   SELECT id, monday_item_id, canvasser_id, sale_amount, status,
--          created_at, reviewed_at
--     FROM public.leads
--    WHERE monday_item_id IN ('13019707187', '13027796653', '13028167116');

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
   WHERE v.monday_item_id IN ('13019707187', '13028167116')
     AND v.status = 'confirmed'
     AND k.monday_item_id = '13027796653' AND k.status = 'confirmed'
     AND k.sale_amount = v.sale_amount;
  GET DIAGNOSTICS v_leads = ROW_COUNT;

  INSERT INTO public.webhook_logs (step, data) VALUES ('Manual_Correction',
    jsonb_build_object('tag', 'fernandez-copy-double-20260911',
      'customer', 'Fernandez, George & Christy',
      'kept', '13027796653',
      'voided', jsonb_build_array('13019707187', '13028167116'),
      'sale_amount', 12583, 'leads_voided', v_leads));
END $$;

COMMIT;

-- The dashboard editor swallows RAISE NOTICE — read the outcome here
-- (leads_voided = 2 on the first run, 0 means the guard found no twin pair):
SELECT data->>'leads_voided' AS leads_voided, created_at
  FROM public.webhook_logs
 WHERE step = 'Manual_Correction'
   AND data->>'tag' = 'fernandez-copy-double-20260911';
