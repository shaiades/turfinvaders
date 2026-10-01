-- ═══════════════════════════════════════════════════════════════════════════
-- BOOKKEEPER ROLE — ENUM ONLY (owner-approved 2026-10-01, for Mary).
--
-- Postgres cannot use a new enum value inside the transaction that added it,
-- and one hand-applied script = one transaction — so this file MUST be
-- applied as its OWN execution, before 20261002170000_bookkeeper_access.sql
-- references 'bookkeeper'. (Same doctrine as 20260909120000_confirmer_role.)
--
-- The role itself: read-everything, write-NOTHING on time + payroll records.
-- Grants are owner-only (not in the Managers' grantable list).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'bookkeeper';
