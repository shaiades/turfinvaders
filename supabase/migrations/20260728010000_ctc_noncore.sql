-- Setter Report parity: canvasser results come from the Block boards'
-- Canvass Stats column (Sit / Sale / Reset / Blowout / CTC), with a
-- non-core-product tally. CTC results and non-core cards need their own
-- daily_logs counters. Idempotent — safe to run more than once.
ALTER TABLE public.daily_logs
  ADD COLUMN IF NOT EXISTS ctc integer NOT NULL DEFAULT 0;
ALTER TABLE public.daily_logs
  ADD COLUMN IF NOT EXISTS non_core integer NOT NULL DEFAULT 0;
