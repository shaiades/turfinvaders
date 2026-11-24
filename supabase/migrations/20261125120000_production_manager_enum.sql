-- ═══════════════════════════════════════════════════════════════════════════
-- PRODUCTION MANAGER ROLE — ENUM VALUE (owner ask 2026-11-24: Austin Mills).
--
-- ALTER TYPE ... ADD VALUE cannot run in the same transaction as statements
-- that USE the new value, so this file is applied ALONE, before
-- 20261125130000_production_manager_access.sql.
--
-- Idempotent; applied via: supabase db query --linked --file <this file>
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'production_manager';
