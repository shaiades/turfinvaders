-- ═══════════════════════════════════════════════════════════════════════════
-- CANVASSER-SIDE SALE CANCELLATIONS (2026-09-13).
-- A canvasser's "My Recent Leads" showed sales as CONFIRMED forever — even
-- after the job cancelled on the Sales Report. Incident: a canvasser argued
-- with a rep that the sales stood because the app said so. The WCC column is
-- the ONLY cancel authority (Close Kombat doctrine), it lives on block_cards,
-- and canvassers can't read block_cards by RLS design — so this trigger
-- mirrors a WCC cancel onto the canvasser-readable leads row as a timestamp
-- stamp. leads.status stays untouched: the lead WAS confirmed (funnel truth);
-- the sale dying later is a separate fact.
--
-- SAFETY CONTRACT — block_cards is the PRODUCTION INGESTION table: the
-- stamping body is exception-wrapped so a leads write can never fail a
-- block_cards write. In practice wcc is written only by the admin Close
-- Kombat sync (the live webhook's row builder omits wcc on purpose), so this
-- trigger is silent on webhook traffic.
--  · Cancel test: keep in sync with isCancelLabel (src/lib/close-kombat.ts),
--    isDeadLabel's cancel arm (src/lib/block-cards.server.ts) and
--    notify_rep_sale (20260912230000). FTD is deliberately NOT a cancel —
--    Close Kombat renders FTD as a PM, not Cancelled.
--  · Heal branch mirrors chooseWcc healing: a cancel label replaced by a
--    non-cancel label (saved deal, label fix) clears the stamp.
--  · IS NULL / IS NOT NULL guards make monthly sync re-runs write-free
--    no-ops — no leads realtime churn when nothing changed.
--  · Known v1 gap: exact monday_item_id match only. A copy-family cancel
--    stamped on a surviving copy while the lead points at the deleted
--    original is missed (no persisted family key exists to join on).
--  · A cancel later revived by a Can/Save shows cancelled until the next
--    sync heals wcc itself (rescued deals' report text becomes LVM/etc).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS sale_cancelled_at timestamptz;

CREATE OR REPLACE FUNCTION public.mirror_wcc_cancel_to_leads()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    IF coalesce(NEW.wcc, '') ~* 'cancel' OR coalesce(NEW.wcc, '') ~* '\mctc\M' THEN
      UPDATE public.leads
        SET sale_cancelled_at = now()
        WHERE monday_item_id = NEW.monday_item_id
          AND sale_cancelled_at IS NULL;
    ELSIF TG_OP = 'UPDATE'
      AND (coalesce(OLD.wcc, '') ~* 'cancel' OR coalesce(OLD.wcc, '') ~* '\mctc\M') THEN
      UPDATE public.leads
        SET sale_cancelled_at = NULL
        WHERE monday_item_id = NEW.monday_item_id
          AND sale_cancelled_at IS NOT NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- a canvasser-side stamp must NEVER break an ingestion write
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS block_cards_mirror_wcc_cancel ON public.block_cards;
CREATE TRIGGER block_cards_mirror_wcc_cancel
  AFTER INSERT OR UPDATE OF wcc ON public.block_cards
  FOR EACH ROW EXECUTE FUNCTION public.mirror_wcc_cancel_to_leads();

-- Backfill today's stamps (idempotent — re-running changes nothing).
UPDATE public.leads l
SET sale_cancelled_at = now()
FROM public.block_cards bc
WHERE bc.monday_item_id = l.monday_item_id
  AND (coalesce(bc.wcc, '') ~* 'cancel' OR coalesce(bc.wcc, '') ~* '\mctc\M')
  AND l.sale_cancelled_at IS NULL;
