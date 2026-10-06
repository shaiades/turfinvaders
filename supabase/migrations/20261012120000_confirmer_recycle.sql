-- ═══════════════════════════════════════════════════════════════════════════
-- VAN WARS §4 — confirmer recycle-credit switch (owner, 2026-10-05).
--
-- When ON, the monday-live-dispatch webhook credits the confirmer named in the
-- Monday Agent column for a card whose Source = Rehash OR whose Lead Status =
-- "room lead", even when it's born outside the Inbound group. Blank-Agent
-- Rehash still routes to the Rehash / Cynthia King channel; every other
-- recycled group stays ignored.
--
-- Ships OFF. This change can reach the pay engine (the webhook writes to
-- leads / daily_logs, which calc_*_paycheck reads), so the owner verifies ONE
-- confirmer's paycheck is unchanged before flipping it on:
--   UPDATE public.system_settings SET confirmer_recycle_credit = true;
--
-- Idempotent. Apply via:
--   supabase db query --linked --file supabase/migrations/20261012120000_confirmer_recycle.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS confirmer_recycle_credit boolean NOT NULL DEFAULT false;
