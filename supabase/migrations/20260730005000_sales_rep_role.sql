-- Sales Rep role (owner directive 2026-07-29): Close Kombat — the sales-rep
-- stats section — is visible to owners, office staff, and the SALES REPS
-- themselves, so reps need their own app role. Captains are deliberately
-- excluded from rep stats.
--
-- This file holds ONLY the enum change: Postgres forbids using a new enum
-- value in the same transaction that added it, and the dashboard SQL editor
-- runs a script as one transaction. Run this file FIRST, as its own
-- execution, then run 20260730010000_close_kombat_block_cards.sql (whose
-- RLS policy references 'sales_rep'::app_role). Idempotent.

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'sales_rep';
