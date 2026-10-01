-- God Mode collections mirror (owner directive 2026-09-30): mirror every row
-- of every monthly "<Month> Collections <YYYY>" Monday board verbatim so the
-- owner page can show anticipated vs collected money. Month membership is by
-- BOARD, never by any date column — matching the report_sales convention (a
-- payment anticipated Aug 31 sitting on the September book is September).
-- The boards' mirror column "Total Amount" (mirror4) is deliberately NOT
-- stored: mirror columns are unreliable via the items API; Planned/Actual are
-- native number columns and are the figures the office actually maintains.
-- Idempotent — safe to run more than once.

-- 1) Mirror table — one row per Monday Collections item ("Payment").
CREATE TABLE IF NOT EXISTS public.report_collections (
  monday_item_id   text PRIMARY KEY,
  board_id         text NOT NULL,
  board_name       text NOT NULL,
  -- First day of the month the BOARD covers (parsed from its name).
  collection_month date NOT NULL,
  -- Weekly bucket ("09/01 - 09/06") or "Needs Assignment" — kept verbatim so
  -- unassigned payments stay visible as their own bucket.
  group_title      text,
  -- 'San Diego' / 'Orange County' from the board's Office status column;
  -- NULL on older boards that predate the column. Stored verbatim, never
  -- defaulted — a null office is a fact about the board, not a gap to fill.
  office           text,
  customer_name    text,            -- item name, "Last, First"
  planned_amount   numeric(12,2) NOT NULL DEFAULT 0, -- blank cell = $0, never guessed
  actual_amount    numeric(12,2) NOT NULL DEFAULT 0, -- blank cell = $0, never guessed
  anticipated_date date,            -- column "Anticipated" (id date_1)
  collected_date   date,            -- column "Collected"   (id date)
  status           text,            -- Run Card / Collected / Processed / Funded / Late / Urgent / Partial Collected / On Time
  milestone        text,            -- Deposit / Progress / Completion / Advantage+
  payment_type     text,            -- dropdown text verbatim (may be comma-joined)
  in_bank          text,            -- status label verbatim (bank account)
  date_deposited   date,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_collections_month_idx
  ON public.report_collections (collection_month);
CREATE INDEX IF NOT EXISTS report_collections_board_idx
  ON public.report_collections (board_id);
-- Overdue scan: anticipated_date < today AND not settled.
CREATE INDEX IF NOT EXISTS report_collections_anticipated_idx
  ON public.report_collections (anticipated_date);

-- 2) RLS — customer payment records (amounts owed, payment methods, bank
--    deposit state, free-text notes): OWNER + OFFICE_STAFF ONLY, deliberately
--    tighter than report_sales (no sales_rep — no rep surface reads these).
--    No write policies: writes come only from the service-role sync.
ALTER TABLE public.report_collections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "report_collections admin read" ON public.report_collections;
CREATE POLICY "report_collections admin read"
  ON public.report_collections FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
  );

GRANT SELECT ON public.report_collections TO authenticated;
GRANT ALL ON public.report_collections TO service_role;

-- 3) updated_at maintenance (same trigger fn as the other mirrors; the
--    per-board delete-reconcile keys off updated_at < walk start).
DROP TRIGGER IF EXISTS report_collections_touch_updated_at ON public.report_collections;
CREATE TRIGGER report_collections_touch_updated_at
  BEFORE UPDATE ON public.report_collections
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 4) Realtime — God Mode live-invalidates on any row change.
ALTER TABLE public.report_collections REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'report_collections'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.report_collections';
  END IF;
END $$;
