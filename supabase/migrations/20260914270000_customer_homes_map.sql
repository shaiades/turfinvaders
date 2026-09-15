-- ═══════════════════════════════════════════════════════════════════════════
-- CUSTOMER HOMES ON EVERY CANVASSING MAP (owner ask 2026-09-14).
-- Every Tidal Remodeling customer — a Block card whose Sale cell carries a
-- sold label and whose WCC never killed the job — shows on every map surface
-- as a company-logo badge; tapping it reveals the homeowner's LAST NAME and
-- the product(s) installed. Written to be idempotent and applied by hand in
-- the Supabase dashboard SQL editor (or supabase db query --linked).
--
-- Design:
--  · block_cards grows lat/lng/address, captured from the Monday Location
--    column by both row builders (edge webhook + Kombat sync — the two
--    ingestion twins). block_cards RLS stays owner/office_staff/sales_rep.
--  · customer_homes_legacy holds sold cards from the pre-May-2026 unified
--    "Block M/D/Y" boards. Those boards are OUTSIDE the Kombat sync's
--    /^(SD|OC) Block/ universe on purpose (reconciled months only) — widening
--    that regex would inject pre-reconciliation cards into Close Kombat, so
--    the map history lives in its own table instead. One-time import, no
--    ongoing sync (the boards are dead).
--  · public.customer_homes is a DEFINER view (deliberately NOT
--    security_invoker, unlike commission_clawback_outstanding): canvassers
--    cannot read block_cards by design, and must not — the view exposes the
--    safe subset only (last name, products, coords, sold date), never sale
--    price, phone, reps, or the full customer name.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1 ▸ Location capture on the live snapshot table.
ALTER TABLE public.block_cards ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE public.block_cards ADD COLUMN IF NOT EXISTS lng double precision;
ALTER TABLE public.block_cards ADD COLUMN IF NOT EXISTS address text;

-- 2 ▸ Pre-May-2026 customers (legacy unified Block boards, one-time import).
CREATE TABLE IF NOT EXISTS public.customer_homes_legacy (
  monday_item_id text PRIMARY KEY,
  board_name text,
  customer_name text,
  products text,
  sale text,
  address text,
  lat double precision,
  lng double precision,
  sold_on date,
  office_location text NOT NULL DEFAULT 'San Diego',
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_homes_legacy TO authenticated;
GRANT ALL ON public.customer_homes_legacy TO service_role;

ALTER TABLE public.customer_homes_legacy ENABLE ROW LEVEL SECURITY;

-- Admin-only either way: everyone else reads through the customer_homes view.
DROP POLICY IF EXISTS "Admins read legacy customer homes" ON public.customer_homes_legacy;
CREATE POLICY "Admins read legacy customer homes"
  ON public.customer_homes_legacy FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

DROP POLICY IF EXISTS "Admins manage legacy customer homes" ON public.customer_homes_legacy;
CREATE POLICY "Admins manage legacy customer homes"
  ON public.customer_homes_legacy FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'))
  WITH CHECK (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

-- 3 ▸ Display last name from a Block card's messy customer name.
-- "Marburger, Anne & Jorge (copy)" → Marburger · "Carl Hagmann sho" →
-- Hagmann · "Chris & Crystal Bocato" → Bocato. Comma form wins (the office
-- writes "Last, First"); otherwise the last non-noise word. Noise list keeps
-- parity with NOISE_TOKENS in src/lib/block-cards.server.ts plus generational
-- suffixes.
CREATE OR REPLACE FUNCTION public.customer_last_name(name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  WITH cleaned AS (
    SELECT trim(regexp_replace(regexp_replace(coalesce(name, ''), '\([^)]*\)', ' ', 'g'), '\s+', ' ', 'g')) AS n
  ),
  base AS (
    SELECT
      CASE WHEN position(',' in n) > 0 THEN trim(split_part(n, ',', 1)) ELSE n END AS n,
      position(',' in n) > 0 AS comma_form
    FROM cleaned
  )
  SELECT NULLIF(
    CASE
      WHEN comma_form THEN n
      ELSE coalesce((
        SELECT regexp_replace(tok, '[^[:alpha:]''-]', '', 'g')
        FROM unnest(string_to_array(n, ' ')) WITH ORDINALITY AS t(tok, ord)
        WHERE lower(regexp_replace(tok, '[^[:alpha:]''-]', '', 'g'))
                NOT IN ('', 'and', '&', 'sho', 'widow', 'widowed', 'widower', 'jr', 'sr', 'ii', 'iii')
        ORDER BY ord DESC
        LIMIT 1
      ), n)
    END, '')
  FROM base;
$$;

-- 4 ▸ The map's read model. Sold set keeps parity with SOLD_VALUES
-- (edge block-cards.ts / src/lib/close-kombat.ts) plus the retired combined
-- labels older boards used ("Reload/Upsell" through spring 2026,
-- "Office/Upsell" on the 2023-24 books — 446 real jobs); the dead-label test
-- keeps parity with isDeadLabel (block-cards.server.ts) — cancel/CTC/FTD all
-- mean the job never happened, so the home is not a customer badge. WCC is
-- the ONLY cancel authority (owner doctrine, 2026-09-02).
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
    'block'::text AS source
  FROM public.block_cards bc
  WHERE bc.lat IS NOT NULL AND bc.lng IS NOT NULL
    AND lower(trim(coalesce(bc.sale, ''))) IN ('sold', 'reload', 'upsell', 'sale', 'reload/upsell', 'office/upsell')
    AND NOT (
      coalesce(bc.wcc, '') ~* 'cancel' OR coalesce(bc.wcc, '') ~* '\mctc\M'
      OR coalesce(bc.wcc, '') ~* '\mftd\M' OR coalesce(bc.wcc, '') ~* 'financial\s*turn'
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
    'legacy'::text AS source
  FROM public.customer_homes_legacy l
  WHERE l.lat IS NOT NULL AND l.lng IS NOT NULL
    AND lower(trim(coalesce(l.sale, ''))) IN ('sold', 'reload', 'upsell', 'sale', 'reload/upsell', 'office/upsell');

REVOKE ALL ON public.customer_homes FROM anon, public;
GRANT SELECT ON public.customer_homes TO authenticated;
GRANT SELECT ON public.customer_homes TO service_role;
