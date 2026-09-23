-- Shark Tank parity (owner directive 2026-09-23): mirror every row of every
-- monthly "... Sales Report" board (2026 onward, un-prefixed Jan–Apr books
-- included) verbatim. The Close Kombat YEAR tab computes standings from
-- THESE rows with the dashboard's own math — sale_amt / rep count, no
-- cancel filter (the office zeroes Sale Amt and moves the money to Cancel
-- Amt when a sale cancels, so a plain sum is already net; Reload and Upsell
-- rows COUNT) — so the Year tab matches the office's Monday "Shark Tank"
-- YTD Leaderboard exactly. Day/Week/Month stay on block_cards.
-- Idempotent — safe to run more than once.

-- 1) Mirror table — one row per Monday Sales-Report item.
CREATE TABLE IF NOT EXISTS public.report_sales (
  monday_item_id  text PRIMARY KEY,
  board_id        text NOT NULL,
  board_name      text NOT NULL,
  -- 'San Diego' / 'Orange County' from the board-name prefix; NULL for the
  -- Jan–Apr 2026 un-prefixed books that cover both offices.
  office          text,
  -- First day of the month the BOARD covers (parsed from its name). Year
  -- membership is by board, never date_sold — the Shark Tank widgets sum
  -- the year's boards, so a row dated Dec 30 on the January book is January.
  report_month    date NOT NULL,
  customer_name   text,
  date_sold       date,
  sale_amt        numeric(12,2) NOT NULL DEFAULT 0, -- blank cell = $0, never guessed
  cancel_amt      numeric(12,2) NOT NULL DEFAULT 0, -- Monday column id "sale_amt" (!)
  wcc             text,
  sales_count     text,  -- raw label: Sale / Reload / Cancelled / Upsell
  phone           text,
  -- Display names from the "Sales Rep" people column, in board order.
  reps            text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_sales_month_idx ON public.report_sales (report_month);
CREATE INDEX IF NOT EXISTS report_sales_board_idx ON public.report_sales (board_id);

-- 2) RLS — rows carry customer names (same sensitivity as block_cards).
--    Read: owner, office_staff, and sales_rep ONLY. No write policies:
--    writes come only from the service-role sync, which bypasses RLS.
ALTER TABLE public.report_sales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "report_sales rep stats read" ON public.report_sales;
CREATE POLICY "report_sales rep stats read"
  ON public.report_sales FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'sales_rep'::app_role)
  );

GRANT SELECT ON public.report_sales TO authenticated;
GRANT ALL ON public.report_sales TO service_role;

-- 3) updated_at maintenance (same trigger fn as the other tables; the
--    per-board delete-reconcile keys off updated_at < walk start).
DROP TRIGGER IF EXISTS report_sales_touch_updated_at ON public.report_sales;
CREATE TRIGGER report_sales_touch_updated_at
  BEFORE UPDATE ON public.report_sales
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 4) Realtime — the Year tab live-invalidates on any row change.
ALTER TABLE public.report_sales REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'report_sales'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.report_sales';
  END IF;
END $$;
