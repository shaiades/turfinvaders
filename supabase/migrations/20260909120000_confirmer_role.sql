-- Confirmer role (owner directive 2026-09-09): office confirmation staff —
-- Cynthia King — get their own roster title while holding EXACTLY canvasser
-- privileges. No policy references the value: canvasser-tier access is
-- self-row + authenticated everywhere, and the client collapses confirmer →
-- canvasser (privilegeRole in src/lib/role-policy.ts) for nav, guards, and
-- redirects. set_user_role (20260812010000) takes any app_role, so once this
-- value exists the owner assigns it from the Users page dropdown.
--
-- This file holds ONLY the enum change: Postgres forbids using a new enum
-- value in the same transaction that added it, and the dashboard SQL editor
-- runs a script as one transaction (same rule as 20260730005000_sales_rep_
-- role.sql). Run it as its own execution. Idempotent.

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'confirmer';
