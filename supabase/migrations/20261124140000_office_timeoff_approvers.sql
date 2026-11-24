-- ═══════════════════════════════════════════════════════════════════════════
-- OFFICE TIME-OFF APPROVERS (owner ask 2026-11-23, Office Portal).
-- Requires 20261124120000_office_role_enum.sql applied FIRST (own execution).
--
-- Office workers request time off like everyone else (day_off_requests), but
-- ONLY the owners named in system_settings.office_timeoff_approver_ids may
-- approve or deny those requests (owner decision 2026-11-23: Tyler + Shai —
-- NOT every owner, and not Managers/HR/captains). Role checks cannot express
-- "these two owners", so the mechanism is an explicit uuid list:
--
--   1) system_settings.office_timeoff_approver_ids uuid[] — set by an owner
--      in the Timesheets → Office time-off approvers card. No uuids are
--      hardcoded here; an owner checks the names in the UI (or one-off:
--      UPDATE public.system_settings SET office_timeoff_approver_ids =
--        ARRAY['<tyler-uuid>'::uuid, '<shai-uuid>'::uuid];).
--   2) office_timeoff_approver_ids() — reads the list for any signed-in
--      user (settings SELECT is owner-only; the ids aren't secret, and
--      DayOffQueue needs them to hide office requests from non-approvers).
--   3) review_day_off v4: when the REQUESTER holds 'office' and the list is
--      non-empty, only a listed approver may review — admins and captains
--      raise. An EMPTY list falls back to the normal admin rule, so the
--      feature degrades safely until the owner picks the approvers.
--      Deny-note requirement and apply_sick_usage unchanged; crew flows
--      untouched. Re-emitted v3 body from 20261025130000.
--
-- The notify-day-off edge function gains the matching audience branch
-- (submission pushes go only to the listed approvers) — deploy it with this:
--   supabase functions deploy notify-day-off --no-verify-jwt
--
-- Idempotent; applied via: supabase db query --linked --file <this file>
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) The approver list ─────────────────────────────────────────────────────

ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS office_timeoff_approver_ids uuid[] NOT NULL DEFAULT '{}';

-- ── 2) Read helper for any signed-in user ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.office_timeoff_approver_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT s.office_timeoff_approver_ids FROM public.system_settings s LIMIT 1),
    '{}'::uuid[]
  )
$$;

REVOKE ALL ON FUNCTION public.office_timeoff_approver_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_timeoff_approver_ids() TO authenticated, service_role;

-- ── 3) review_day_off v4: office requests answer to the named owners ─────────
-- Identical to v3 (20261025130000) except the office-requester branch.

CREATE OR REPLACE FUNCTION public.review_day_off(
  _id uuid, _approve boolean, _deny_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row record;
  _is_admin boolean := public.is_time_admin(auth.uid());
  _approvers uuid[];
BEGIN
  SELECT user_id, status, kind INTO _row FROM public.day_off_requests WHERE id = _id;
  IF _row.user_id IS NULL THEN RAISE EXCEPTION 'request not found'; END IF;
  IF _row.status <> 'pending' THEN RAISE EXCEPTION 'only pending requests can be reviewed'; END IF;

  -- Office workers' requests are reviewed ONLY by the named owners (owner
  -- decision 2026-11-23). Empty list = not configured yet → admin rule.
  IF public.has_role(_row.user_id, 'office'::app_role) THEN
    _approvers := public.office_timeoff_approver_ids();
    IF array_length(_approvers, 1) IS NOT NULL THEN
      IF NOT (auth.uid() = ANY(_approvers)) THEN
        RAISE EXCEPTION 'office time-off is reviewed by the named owners only';
      END IF;
    ELSIF NOT _is_admin THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  ELSIF NOT _is_admin THEN
    IF NOT public.has_role(auth.uid(), 'captain') THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
    IF public.my_team_id(auth.uid()) IS NULL
       OR public.my_team_id(_row.user_id) IS DISTINCT FROM public.my_team_id(auth.uid()) THEN
      RAISE EXCEPTION 'captains review requests for their own team only';
    END IF;
    IF _row.user_id = auth.uid() THEN
      RAISE EXCEPTION 'you cannot review your own request — ask a manager';
    END IF;
  END IF;

  IF NOT _approve AND COALESCE(btrim(_deny_reason), '') = '' THEN
    RAISE EXCEPTION 'a note is required to deny — the worker reads it';
  END IF;

  UPDATE public.day_off_requests
  SET status = CASE WHEN _approve THEN 'approved' ELSE 'denied' END,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      deny_reason = CASE WHEN _approve THEN NULL ELSE btrim(_deny_reason) END
  WHERE id = _id;

  -- An approved sick request draws paid sick leave.
  IF _approve AND _row.kind = 'sick' THEN
    PERFORM public.apply_sick_usage(_id);
  END IF;
END $$;
