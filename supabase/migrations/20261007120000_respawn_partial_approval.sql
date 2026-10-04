-- ═══════════════════════════════════════════════════════════════════════════
-- RESPAWN partial approval (owner ask 2026-10-03). The approver can grant a
-- SUBSET of the requested shifts (e.g. requested Thu–Sat, grant Fri + Sat).
--
--   · approved_shifts = the shifts actually granted (NULL = not decided yet;
--     equals the full request on a plain approve).
--   · status gains 'partial' for "some but not all granted". Attendance is
--     written only for approved_shifts.
--
-- Idempotent. Apply via:
--   supabase db query --linked --file supabase/migrations/20261007120000_respawn_partial_approval.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.respawn_requests
  ADD COLUMN IF NOT EXISTS approved_shifts text[];

-- Extend the status CHECK to allow 'partial' (the inline constraint from
-- 20261006120000 is auto-named respawn_requests_status_check).
ALTER TABLE public.respawn_requests
  DROP CONSTRAINT IF EXISTS respawn_requests_status_check;
ALTER TABLE public.respawn_requests
  ADD CONSTRAINT respawn_requests_status_check
  CHECK (status IN ('pending', 'approved', 'denied', 'partial'));
