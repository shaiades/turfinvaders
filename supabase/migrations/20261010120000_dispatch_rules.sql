-- ═══════════════════════════════════════════════════════════════════════════
-- LIVE DISPATCH rules A–G (owner mandate 2026-10-08). Adds the storage the
-- dispatcher needs to:
--   · Rule 8  — read a tunable hot-reps / hot-pairs roster from settings so the
--               pairing analytics can be dropped in with no code change;
--   · Rule 13 — remember the Sales Processing columns to fill once a Sold routes
--               the card to board 4155553389 (filled by ?task=sales-processing);
--   · Rule 21 — a per-write audit (item, old value, new value, reason, time) of
--               every people6 / status write, for Shai's review page.
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261010120000_dispatch_rules.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Rule 16a: spot the second partner's copy of a same-day report ───────────
-- Stamp each processed report with its customer+day key so a partner's later
-- copy (same customer, same day) auto-marks Handled instead of piling up in
-- Needs Review.
ALTER TABLE public.ooh_processed_reports
  ADD COLUMN IF NOT EXISTS customer_key text;
CREATE INDEX IF NOT EXISTS ooh_processed_custkey_idx
  ON public.ooh_processed_reports (customer_key);

-- ── Rule 8: pairing roster (hot reps / never-solo / preferred partners) ──────
-- JSON shape: { "hotReps": ["Yakup", …], "neverSolo": ["Daniel"],
--               "preferredPartners": { "yakup": ["bergan"], … } }
-- NULL ⇒ the engine defaults (only Daniel force-paired) — dispatch unchanged
-- until the owner populates it from the Close Kombat / pairing analytics.
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS dispatch_pairing jsonb;

-- ── Rule 21: per-write audit of every people6 / status write ─────────────────
CREATE TABLE IF NOT EXISTS public.ooh_dispatch_writes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  mode text NOT NULL,                      -- 'dry_run' | 'live'
  trigger text,                            -- 'report' | 'watchdog' | 'late_cover'
  form_item_id text,                       -- the report that drove the write (if any)
  board_id text,
  item_id text NOT NULL,                   -- the block item written
  lead_name text,
  column_id text NOT NULL,                 -- 'people6' | 'status' | …
  column_label text,                       -- human label ('Reps' | 'Iss')
  old_value text,                          -- value before the write (as read)
  new_value text,                          -- value after the write
  reason text,
  actor text NOT NULL DEFAULT 'dispatch'   -- always the dispatcher
);
CREATE INDEX IF NOT EXISTS ooh_writes_created_idx ON public.ooh_dispatch_writes (created_at);
CREATE INDEX IF NOT EXISTS ooh_writes_item_idx ON public.ooh_dispatch_writes (item_id);

GRANT ALL ON public.ooh_dispatch_writes TO service_role;
GRANT SELECT ON public.ooh_dispatch_writes TO authenticated;
ALTER TABLE public.ooh_dispatch_writes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ooh writes read admin" ON public.ooh_dispatch_writes;
CREATE POLICY "ooh writes read admin" ON public.ooh_dispatch_writes
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.ooh_dispatch_writes;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

-- ── Rule 13: Sales Processing fields pending until the card is routed there ──
CREATE TABLE IF NOT EXISTS public.ooh_sales_processing_pending (
  form_item_id text PRIMARY KEY,
  customer_key text,                       -- customerLastName|YYYY-MM-DD (match key)
  customer_name text,
  board_id text,                           -- origin block board
  values jsonb NOT NULL,                   -- the SALES_PROCESSING_COL write
  created_at timestamptz NOT NULL DEFAULT now(),
  filled_at timestamptz,                   -- set once written to the SP card
  sp_item_id text                          -- the Sales Processing card id, once found
);
CREATE INDEX IF NOT EXISTS ooh_sp_pending_key_idx
  ON public.ooh_sales_processing_pending (customer_key) WHERE filled_at IS NULL;
GRANT ALL ON public.ooh_sales_processing_pending TO service_role;
GRANT SELECT ON public.ooh_sales_processing_pending TO authenticated;
ALTER TABLE public.ooh_sales_processing_pending ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ooh sp pending read admin" ON public.ooh_sales_processing_pending;
CREATE POLICY "ooh sp pending read admin" ON public.ooh_sales_processing_pending
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));
