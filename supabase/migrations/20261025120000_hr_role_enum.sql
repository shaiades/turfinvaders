-- ═══════════════════════════════════════════════════════════════════════════
-- HR ROLE — ENUM ONLY (owner ask 2026-10-15, for Zuleyma Hernandez).
--
-- Postgres cannot use a new enum value inside the transaction that added it,
-- and one hand-applied script = one transaction — so this file MUST be
-- applied as its OWN execution, before 20261025130000_hr_role_access.sql
-- references 'hr'. (Same doctrine as 20261002160000_bookkeeper_role_enum.)
--
-- The role itself: full TIME & ATTENDANCE administration — timesheets,
-- punches, meal/rest resolution, absences, passes — with NO payroll-dollar
-- access (runs, lines, paycheck engine stay Admin + bookkeeper). Grants are
-- owner-only (not in the Managers' grantable list), like bookkeeper.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'hr';
