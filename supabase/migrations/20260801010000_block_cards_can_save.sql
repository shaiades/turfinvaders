-- Can/Save support (owner directive 2026-08-01): when a sold job cancels,
-- the office sends a rep out on a "Can/Save". The office writes "Can/Save"
-- in the save card's Comments. A save that LANDS gets a Sale Price — the
-- renegotiated (lower) contract, which REPLACES the original sale's volume;
-- the saver then shares the split evenly with the original rep(s). A save
-- card with no price failed, and changes nothing.
--
-- The dashboard therefore needs two columns it never mirrored before:
--   comments — to recognize "Can/Save" cards
--   phone    — to link a save card to the original sale (same customer
--              phone; sturdier than name matching alone)
-- Idempotent — safe to run more than once.

ALTER TABLE public.block_cards
  ADD COLUMN IF NOT EXISTS comments text,
  ADD COLUMN IF NOT EXISTS phone text;
