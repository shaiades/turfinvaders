-- WCC — cancelled sales (owner directive 2026-07-29): a sale can cancel
-- after the fact, and the only record is the monthly "... Sales Report"
-- board's WCC status column ("Cancelled"). The Close Kombat sync matches
-- those report rows back to the sold Block cards by customer name and
-- stamps the raw WCC label here. A cancelled sale leaves Sold and Revenue
-- and shows in its own WCC column; the demo still counts (Sit % keeps it,
-- Close % drops). NULL = no report row matched / not cancelled.
-- Idempotent — safe to run more than once.

ALTER TABLE public.block_cards
  ADD COLUMN IF NOT EXISTS wcc text;
