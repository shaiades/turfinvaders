-- Not on Sales Report flag (owner directive 2026-09-23): a sold Block card
-- proven ABSENT from the walked monthly Sales Report boards. Shark Tank —
-- and the Close Kombat Month/Year book money — doesn't count these sales
-- (September 2026's whole $43,953 Month-tab gap was five such cards).
-- Written ONLY by the sync's Sales-Report pass, same contract as
-- wcc/report_reps: the Block row builders exclude it so upserts never
-- clobber. NULL = never proven either way; the flag only changes when the
-- card's whole ±3-day match window is covered by successfully walked,
-- office-prefixed books — a quick sync (current + previous month) must
-- never wipe a Full-history flag.
-- Idempotent — safe to run more than once.

ALTER TABLE public.block_cards
  ADD COLUMN IF NOT EXISTS missing_from_report boolean;
