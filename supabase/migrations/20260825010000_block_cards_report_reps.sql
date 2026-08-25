-- Report reps (owner, 2026-08-25): the office sometimes records the second
-- closer ONLY on the monthly "... Sales Report" board's Sales Rep column,
-- never on the Block card (verified live, SD Aug '26: "Hagmann, Carl" —
-- report shows Daniel Figueiredo + Jonathan Paz, Block card shows Daniel
-- only; same for "Pinel, George"). The Shark Tank dashboard splits volume
-- by that column ({Sale Amt}/{Sales Rep count}), so the app's VOLUME split
-- follows report_reps when it is set; result counts stay with the Block
-- card's own reps.
--
-- Stamped ONLY by the Sales-Report pass in src/lib/block-cards.server.ts
-- (same contract as wcc): the webhook/sync row builders deliberately
-- exclude this column, so their full-row upserts can never clobber the
-- stamp. NULL = no report stamp. Volume itself is still ONLY the Block
-- board's Sale Price — the report's Sale Amt never flows into sale_price.
--
-- Idempotent — safe to run more than once.

ALTER TABLE public.block_cards
  ADD COLUMN IF NOT EXISTS report_reps text[];
