-- ═══════════════════════════════════════════════════════════════════════════
-- CANCELLED CUSTOMERS JOIN THE MAP AS RED BADGES (owner ask 2026-10-01).
-- customer_homes previously hid every card whose WCC carried a dead label;
-- now cancel/CTC cards flow through with cancelled=true so the map can tint
-- the logo badge red — "they cancelled on us" at the door. Applied by hand
-- via supabase db query --linked --file BEFORE merging, like the original
-- (20260914270000_customer_homes_map.sql, which this replaces wholesale).
--
--  · "Cancelled" = WCC cancel/CTC ONLY — parity with isCancelLabel
--    (src/lib/close-kombat.ts) and mirror_wcc_cancel_to_leads
--    (20260913010000). FTD/financial-turn stays hidden: an FTD is a PM,
--    not a cancel (Close Kombat doctrine), so the home is simply not a
--    customer — never a red badge.
--  · A cancel-label card shows even when its Sale cell is empty: the office
--    reverts Sale on cancel (Sale_Lead_Voided), and the WCC pass stamps
--    cancel rows onto non-sold cards for exactly that reason
--    (block-cards.server.ts soldThenAll). wcc is written ONLY from Sales
--    Report rows — i.e. only onto cards that WERE sales — so the OR arm
--    cannot admit a never-sold card.
--  · Legacy (pre-May-2026) rows carry no wcc → cancelled is always false.
--  · Still a DEFINER view (deliberately NOT security_invoker): canvassers
--    cannot read block_cards; DROP+CREATE discards grants, re-applied below.
--    No explicit BEGIN/COMMIT — db query --file already runs the whole file
--    in one implicit transaction (repo migration convention).
-- ═══════════════════════════════════════════════════════════════════════════
DROP VIEW IF EXISTS public.customer_homes;
CREATE VIEW public.customer_homes AS
  SELECT
    bc.monday_item_id,
    public.customer_last_name(bc.lead_name) AS last_name,
    bc.products,
    bc.lat,
    bc.lng,
    bc.address,
    bc.card_date AS sold_on,
    bc.office_location,
    'block'::text AS source,
    w.cancelled
  FROM public.block_cards bc
  CROSS JOIN LATERAL (
    SELECT (coalesce(bc.wcc, '') ~* 'cancel' OR coalesce(bc.wcc, '') ~* '\mctc\M') AS cancelled
  ) w
  WHERE bc.lat IS NOT NULL AND bc.lng IS NOT NULL
    AND (
      w.cancelled -- cancel/CTC wins even over a cleared Sale cell
      OR (
        lower(trim(coalesce(bc.sale, ''))) IN ('sold', 'reload', 'upsell', 'sale', 'reload/upsell', 'office/upsell')
        AND NOT (coalesce(bc.wcc, '') ~* '\mftd\M' OR coalesce(bc.wcc, '') ~* 'financial\s*turn')
      )
    )
  UNION ALL
  SELECT
    l.monday_item_id,
    public.customer_last_name(l.customer_name) AS last_name,
    l.products,
    l.lat,
    l.lng,
    l.address,
    l.sold_on,
    l.office_location,
    'legacy'::text AS source,
    false AS cancelled
  FROM public.customer_homes_legacy l
  WHERE l.lat IS NOT NULL AND l.lng IS NOT NULL
    AND lower(trim(coalesce(l.sale, ''))) IN ('sold', 'reload', 'upsell', 'sale', 'reload/upsell', 'office/upsell');

REVOKE ALL ON public.customer_homes FROM anon, public;
GRANT SELECT ON public.customer_homes TO authenticated;
GRANT SELECT ON public.customer_homes TO service_role;
