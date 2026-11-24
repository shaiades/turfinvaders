-- ═══════════════════════════════════════════════════════════════════════════
-- PRODUCTION + RECEPTIONIST ROLES — ENUM ONLY (owner ask 2026-11-24).
--
-- Two more titles in the office-worker tier (same behavior as 'office':
-- Office Portal, 20:00 auto-close, named time-off approvers). Postgres
-- forbids USING a new enum value in the same execution that ADDs it, so this
-- file is enum-only and MUST be applied as its OWN execution before
-- 20261124190000_production_receptionist_access.sql (same doctrine as
-- 20261124120000_office_role_enum.sql).
--
-- Idempotent; applied via: supabase db query --linked --file <this file>
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'production';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'receptionist';
