-- ═══════════════════════════════════════════════════════════════════════════
-- PRODUCTION + RECEPTIONIST ROLES — ACCESS (owner ask 2026-11-24).
-- Requires 20261124180000_production_receptionist_enum.sql applied FIRST
-- (its own execution).
--
-- 'production' and 'receptionist' are TITLES in the office-worker tier:
-- identical behavior to 'office' everywhere. This file centralizes that in
-- public.is_office_worker() and re-emits the three functions that named
-- 'office' directly:
--
--   1) is_office_worker(uuid) — the one SQL definition of the tier. Mirrors
--      OFFICE_WORKER_ROLES in role-policy.ts and the notify-day-off
--      audience branch — change them together.
--   2) set_user_role v4 — Managers' grantable list gains the two titles.
--      Re-emitted v3 (20261124130000).
--   3) auto_clock_out_expired v5 — 20:00 LA auto-close covers the whole
--      tier. Re-emitted v4 (20261124130000).
--   4) review_day_off v5 — named-approvers rule covers the whole tier.
--      Re-emitted v4 (20261124140000).
--
-- The notify-day-off edge function gains the matching tier check — deploy it
-- with this file:  supabase functions deploy notify-day-off --no-verify-jwt
--
-- Idempotent; applied via: supabase db query --linked --file <this file>
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) The office-worker tier, defined once ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_office_worker(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND role IN ('office'::app_role, 'production'::app_role, 'receptionist'::app_role)
  )
$$;

REVOKE ALL ON FUNCTION public.is_office_worker(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_office_worker(uuid) TO authenticated, service_role;

-- ── 2) set_user_role v4: Managers may grant the two new titles ───────────────
-- Identical to v3 (20261124130000) except the office_staff arm's allowed list.

CREATE OR REPLACE FUNCTION public.set_user_role(_target_user uuid, _new_role app_role)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _caller uuid := auth.uid();
  _caller_is_owner boolean;
  _owner_count int;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  _caller_is_owner := public.has_role(_caller, 'owner'::app_role);

  IF NOT _caller_is_owner THEN
    -- Managers (office_staff) run day-to-day role changes (owner decision
    -- 2026-09-16, superseding the owner-only rule of 2026-08-12). Captains
    -- still create new Canvassers/Sales Reps via the server fns only.
    IF NOT public.has_role(_caller, 'office_staff'::app_role) THEN
      RAISE EXCEPTION 'Only Owners and Managers can change roles';
    END IF;
    -- Never on Owner/Manager accounts (mirrors canManageTarget + the
    -- archive/reactivate/rename/merge target rules).
    IF public.is_privileged_account(_target_user) THEN
      RAISE EXCEPTION 'Only Owners can change Owner or Manager accounts';
    END IF;
    -- Field + office tiers only: minting Owners/Managers (and the
    -- owner-granted HR/bookkeeper roles) stays owner-only.
    IF _new_role NOT IN (
      'captain'::app_role, 'sales_rep'::app_role,
      'confirmer'::app_role, 'canvasser'::app_role,
      'office'::app_role, 'production'::app_role, 'receptionist'::app_role
    ) THEN
      RAISE EXCEPTION 'Managers can grant up to Captain — Owner and Manager roles are Owner-only';
    END IF;
  END IF;

  -- Serialize role swaps so the last-owner check can't be raced by a
  -- concurrent demotion.
  PERFORM pg_advisory_xact_lock(hashtext('user_roles_swap'));

  -- Last-owner protection (owner arm only — Managers can't reach owner
  -- targets past the privileged check above). Counts login-capable owners.
  IF public.has_role(_target_user, 'owner'::app_role) AND _new_role <> 'owner'::app_role THEN
    _owner_count := public.real_owner_count();
    IF _owner_count <= 1 THEN
      RAISE EXCEPTION 'Cannot remove the last Owner';
    END IF;
  END IF;

  -- Atomic swap: the UI's one-role-per-user invariant is enforced here.
  DELETE FROM public.user_roles WHERE user_id = _target_user;
  INSERT INTO public.user_roles (user_id, role) VALUES (_target_user, _new_role);
END $$;

REVOKE ALL ON FUNCTION public.set_user_role(uuid, app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_user_role(uuid, app_role) TO authenticated, service_role;

-- ── 3) auto-close v5: the whole office tier runs until 20:00 LA ─────────────
-- Identical to v4 (20261124130000) except the tier check.

CREATE OR REPLACE FUNCTION public.auto_clock_out_expired()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _rec RECORD;
  _local_date date;
  _dow int;
  _cutoff_local timestamp;
  _late_until time;
  _close_at_utc timestamptz;
  _now_local timestamp := (now() AT TIME ZONE 'America/Los_Angeles');
  _affected int := 0;
BEGIN
  FOR _rec IN
    SELECT id, user_id, clock_in FROM public.time_entries
    WHERE clock_out IS NULL AND voided_at IS NULL
  LOOP
    _local_date := (_rec.clock_in AT TIME ZONE 'America/Los_Angeles')::date;
    _dow := EXTRACT(ISODOW FROM _local_date)::int;

    IF _dow BETWEEN 1 AND 5 THEN _cutoff_local := _local_date + time '18:00';
    ELSIF _dow = 6 THEN            _cutoff_local := _local_date + time '17:00';
    ELSE                           _cutoff_local := _local_date + time '18:00';
    END IF;

    -- Office tier (owner decisions 2026-11-23/24): the office day can run
    -- past the field cutoff — auto-close at 20:00 LA every day instead.
    IF public.is_office_worker(_rec.user_id) THEN
      _cutoff_local := _local_date + time '20:00';
    END IF;

    -- Late pass: extend (never shorten) this person's cutoff for the day.
    SELECT e.late_until INTO _late_until
    FROM public.time_clock_exceptions e
    WHERE e.user_id = _rec.user_id
      AND e.exception_date = _local_date
      AND e.revoked_at IS NULL
      AND e.late_until IS NOT NULL;
    IF _late_until IS NOT NULL THEN
      _cutoff_local := GREATEST(_cutoff_local, _local_date + _late_until);
    END IF;

    IF (_rec.clock_in AT TIME ZONE 'America/Los_Angeles') >= _cutoff_local THEN
      -- Evening shift: close at LA midnight of the clock-in day, never at
      -- its own start (the old zero-hour bug wiped evening work).
      _cutoff_local := _local_date + interval '1 day';
    END IF;

    IF _now_local >= _cutoff_local THEN
      _close_at_utc := _cutoff_local AT TIME ZONE 'America/Los_Angeles';
      UPDATE public.time_entries
      SET clock_out = GREATEST(_close_at_utc, clock_in),
          entry_source = 'auto_closed',
          needs_correction = true
      WHERE id = _rec.id;
      _affected := _affected + 1;
    END IF;
  END LOOP;
  RETURN _affected;
END $$;

-- ── 4) review_day_off v5: named approvers cover the whole office tier ───────
-- Identical to v4 (20261124140000) except the tier check.

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

  -- Office-tier requests are reviewed ONLY by the named approvers (owner
  -- decisions 2026-11-23/24). Empty list = not configured yet → admin rule.
  IF public.is_office_worker(_row.user_id) THEN
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
