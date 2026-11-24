-- ═══════════════════════════════════════════════════════════════════════════
-- OFFICE ROLE — ENUM ONLY (owner ask 2026-11-23, Office Portal).
--
-- Postgres cannot use a new enum value inside the transaction that added it,
-- and one hand-applied script = one transaction — so this file MUST be
-- applied as its OWN execution, before 20261124130000_office_role_access.sql
-- (and 20261124140000_office_timeoff_approvers.sql) reference 'office'.
-- (Same doctrine as 20261025120000_hr_role_enum.sql.)
--
-- The role itself: office workers — receptionist, production staff, anyone
-- who is NOT a canvasser or sales rep and NOT a Manager. They get the clean
-- /office portal (clock in/out, lunch, time off) and nothing else: no fleet,
-- no arcade, no admin surfaces. NOTE: office_staff is NOT this — that enum
-- value means "Manager" (label changed 2026-08-14) and sits in the Admin
-- tier. Office time-off approval is restricted to the owners named in
-- system_settings.office_timeoff_approver_ids (Tyler + Shai).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'office';
