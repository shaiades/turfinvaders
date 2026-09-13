-- ═══════════════════════════════════════════════════════════════════════════
-- COPY-FAMILY WIDENING FOR CANVASSER-SIDE SALE CANCELLATIONS (2026-09-13).
-- Closes the v1 gap documented in 20260913010000: the office's copy-then-
-- move/DELETE workflow leaves the lead pointing at a purged original card
-- while the WCC cancel lands on the surviving "(copy)" card — an exact
-- monday_item_id miss. Prod audit (2026-09-13, read-only probes): 30
-- WCC-cancelled cards, 6 stamped exact-id, and 16 confirmed leads still
-- showing a live sale whose family card says Cancelled — every one of the 16
-- reachable ONLY by name (the original ids are gone from block_cards; the
-- sibling-card route matched zero). 73% of lead-backed cancels were missed.
--
-- DESIGN — name+date family clause, stamp-only:
--  · copy_base_name() is the SQL mirror of copyBaseName in
--    supabase/functions/monday-live-dispatch/block-cards.ts (strip stacked
--    trailing "(copy)"/"(copy N)", lowercase, collapse whitespace). KEEP IN
--    SYNC — verify:blockday pins the TS side's literals.
--  · A cancelled card additionally stamps leads whose customer_name shares
--    its copy-base and whose created_at is within ±45 days of the card's
--    block day (families span boards, so no board filter; all 16 audited
--    cases are same-day — 45d covers re-run copies weeks later, sized like
--    Close Kombat's ±42d cross-month save pad).
--  · ORPHAN GUARD: the family clause touches ONLY leads whose own
--    monday_item_id no longer exists in block_cards (the copy-then-delete
--    signature). A lead whose card still lives is exact-id territory — the
--    name route never competes with a live card's own WCC. This is also what
--    keeps same-name-different-family leads safe: dupes within the window
--    exist in prod (Vestal, Fernandez), but their cards are on boards.
--  · SOLD-SIBLING GUARD: no stamp while any non-cancelled family card in the
--    window carries a sold-value Sale label ('sold','reload','upsell','sale'
--    — SOLD_VALUES in block-cards.ts). A cancel→rehash→re-sold family keeps
--    showing the live sale. Audit: 0 such families today.
--  · HEALING STAYS EXACT-ID (unchanged from v1): a non-cancelled sibling
--    must never wipe a real stamp. Known asymmetry: a family-stamped orphan
--    lead has no auto-heal path if the copy's cancel is later rescued
--    (Can/Save) — the copy's wcc heals, the orphan lead's stamp needs a
--    manual UPDATE. Accepted: rescues are rare, false "CANCELLED" on a
--    rescued sale is the same v1 failure mode already documented.
--  · Cancel regex is BYTE-IDENTICAL to v1 / notify_rep_sale (20260912230000)
--    / isCancelLabel (src/lib/close-kombat.ts) / isDeadLabel
--    (src/lib/block-cards.server.ts) — verify:kombat pins the literals.
--  · Body stays exception-wrapped: block_cards is production ingestion, a
--    stamp failure must never fail a card write. Scale check: 3,258 cards /
--    215 leads and only cancelled writes (~30/sync) enter the family branch.
-- ═══════════════════════════════════════════════════════════════════════════

-- SQL mirror of copyBaseName (block-cards.ts) — IMMUTABLE so it could back
-- an expression index if block_cards ever outgrows seq scans.
CREATE OR REPLACE FUNCTION public.copy_base_name(name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT lower(regexp_replace(
           trim(regexp_replace(coalesce(name, ''),
                               '(\s*\(copy(\s+\d+)?\))+\s*$', '', 'i')),
           '\s+', ' ', 'g'))
$$;

CREATE OR REPLACE FUNCTION public.mirror_wcc_cancel_to_leads()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  fam_base text;
BEGIN
  BEGIN
    IF coalesce(NEW.wcc, '') ~* 'cancel' OR coalesce(NEW.wcc, '') ~* '\mctc\M' THEN
      -- Exact-id stamp (v1).
      UPDATE public.leads
        SET sale_cancelled_at = now()
        WHERE monday_item_id = NEW.monday_item_id
          AND sale_cancelled_at IS NULL;

      -- Copy-family stamp (v2): orphaned leads of the same customer family.
      fam_base := public.copy_base_name(NEW.lead_name);
      IF fam_base <> '' AND NEW.card_date IS NOT NULL THEN
        UPDATE public.leads l
          SET sale_cancelled_at = now()
          WHERE l.sale_cancelled_at IS NULL
            AND public.copy_base_name(l.customer_name) = fam_base
            AND l.created_at::date BETWEEN NEW.card_date - 45 AND NEW.card_date + 45
            AND NOT EXISTS (SELECT 1 FROM public.block_cards own
                             WHERE own.monday_item_id = l.monday_item_id)
            AND NOT EXISTS (SELECT 1 FROM public.block_cards sib
                             WHERE sib.monday_item_id <> NEW.monday_item_id
                               AND sib.card_date IS NOT NULL
                               AND sib.card_date BETWEEN NEW.card_date - 45 AND NEW.card_date + 45
                               AND public.copy_base_name(sib.lead_name) = fam_base
                               AND NOT (coalesce(sib.wcc, '') ~* 'cancel'
                                        OR coalesce(sib.wcc, '') ~* '\mctc\M')
                               AND lower(trim(coalesce(sib.sale, ''))) IN
                                     ('sold', 'reload', 'upsell', 'sale'));
      END IF;
    ELSIF TG_OP = 'UPDATE'
      AND (coalesce(OLD.wcc, '') ~* 'cancel' OR coalesce(OLD.wcc, '') ~* '\mctc\M') THEN
      -- Heal stays EXACT-ID on purpose — see header.
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

-- Trigger block_cards_mirror_wcc_cancel (20260913010000) keeps pointing at
-- the replaced function — no re-create needed.

-- Backfill: the identical family clause over every cancelled card, stamping
-- the 16 audited orphan leads (idempotent — re-running changes nothing).
UPDATE public.leads l
SET sale_cancelled_at = now()
FROM public.block_cards bc
WHERE (coalesce(bc.wcc, '') ~* 'cancel' OR coalesce(bc.wcc, '') ~* '\mctc\M')
  AND l.sale_cancelled_at IS NULL
  AND public.copy_base_name(bc.lead_name) <> ''
  AND public.copy_base_name(l.customer_name) = public.copy_base_name(bc.lead_name)
  AND bc.card_date IS NOT NULL
  AND l.created_at::date BETWEEN bc.card_date - 45 AND bc.card_date + 45
  AND NOT EXISTS (SELECT 1 FROM public.block_cards own
                   WHERE own.monday_item_id = l.monday_item_id)
  AND NOT EXISTS (SELECT 1 FROM public.block_cards sib
                   WHERE sib.monday_item_id <> bc.monday_item_id
                     AND sib.card_date IS NOT NULL
                     AND sib.card_date BETWEEN bc.card_date - 45 AND bc.card_date + 45
                     AND public.copy_base_name(sib.lead_name) = public.copy_base_name(bc.lead_name)
                     AND NOT (coalesce(sib.wcc, '') ~* 'cancel'
                              OR coalesce(sib.wcc, '') ~* '\mctc\M')
                     AND lower(trim(coalesce(sib.sale, ''))) IN
                           ('sold', 'reload', 'upsell', 'sale'));
