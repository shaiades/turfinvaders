-- ═══════════════════════════════════════════════════════════════════════════
-- OFFICE ROLE — ACCESS (owner ask 2026-11-23, Office Portal).
-- Requires 20261124120000_office_role_enum.sql applied FIRST (its own
-- execution).
--
-- The time-clock backend (guard triggers, compute, RLS self-read/self-punch,
-- sick accrual) is role-agnostic — office workers can already punch. Only
-- two things name roles and need widening:
--
--   1) set_user_role: the Managers' grantable list gains 'office' (Managers
--      run day-to-day onboarding; owner/Manager/HR/bookkeeper grants stay
--      owner-only). Re-emitted v2 → v3 from 20260916120000.
--   2) auto_clock_out_expired v3 → v4: office shifts left open auto-close at
--      20:00 LA (owner decision 2026-11-23: office days can run later than
--      the field's 18:00 weekday / 17:00 Saturday cutoff). Late passes still
--      extend; auto-closed entries still flag for correction.
--
-- Client mirrors in the same PR: role-policy.ts (APP_ROLES, labels,
-- VAN_EXEMPT_ROLES, MANAGER_GRANTABLE_ROLES), users.functions.ts,
-- redirect-by-role.ts, AppShell nav + guard, dashboard fan-out, /office
-- route. Keep them in lockstep with this file.
--
-- Idempotent; applied via: supabase db query --linked --file <this file>
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) set_user_role v3: Managers may also grant 'office' ────────────────────
-- Identical to v2 (20260916120000) except the office_staff arm's allowed list.

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
      'office'::app_role
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

-- ── 2) auto-close v4: office shifts run until 20:00 LA ───────────────────────
-- Identical to v3 (20260911120000 §5) except the office cutoff branch.

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

    -- Office workers (owner decision 2026-11-23): the office day can run
    -- past the field cutoff — auto-close at 20:00 LA every day instead.
    IF public.has_role(_rec.user_id, 'office'::app_role) THEN
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
