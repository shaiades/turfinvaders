
-- Atomic role swap with tiered privilege checks. Runs AFTER
-- 20260803010000_captain_global_canvassing_reads.sql (needs
-- is_privileged_account from it).
--
-- Replaces the client-side delete-then-insert (which only worked for owners
-- under RLS and could strand a user role-less on partial failure). Captains
-- and office_staff get role assignment ONLY through this function — there are
-- deliberately no captain write policies on user_roles, so there is no
-- raw-table escalation path. "Owners manage roles" stays as the owner escape
-- hatch.

-- Login-capable Owners only: the join to auth.users excludes placeholder
-- profiles holding an 'owner' role row and role rows orphaned by past
-- deletions (the auth.users FKs were dropped in 20260702175542, so raw
-- user_roles counts overstate the real owner headcount).
CREATE OR REPLACE FUNCTION public.real_owner_count()
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT count(*)::int
  FROM public.user_roles ur
  JOIN auth.users u ON u.id = ur.user_id
  WHERE ur.role = 'owner'::app_role
$$;
REVOKE ALL ON FUNCTION public.real_owner_count() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.real_owner_count() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_user_role(_target_user uuid, _new_role app_role)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _caller uuid := auth.uid();
  _caller_is_owner boolean;
  _caller_is_manager boolean;
  _owner_count int;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  _caller_is_owner := public.has_role(_caller, 'owner'::app_role);
  _caller_is_manager := _caller_is_owner
    OR public.has_role(_caller, 'captain'::app_role)
    OR public.has_role(_caller, 'office_staff'::app_role);
  IF NOT _caller_is_manager THEN
    RAISE EXCEPTION 'Only Owners, Captains, or Admins can change roles';
  END IF;

  -- Serialize role swaps so the last-owner check can't be raced by a
  -- concurrent demotion.
  PERFORM pg_advisory_xact_lock(hashtext('user_roles_swap'));

  IF NOT _caller_is_owner THEN
    -- Captains/office_staff may only grant the non-privileged tier…
    IF _new_role NOT IN ('canvasser'::app_role, 'sales_rep'::app_role, 'captain'::app_role) THEN
      RAISE EXCEPTION 'Only Owners can grant Owner or Admin roles';
    END IF;
    -- …and may not touch accounts holding owner/office_staff.
    IF public.is_privileged_account(_target_user) THEN
      RAISE EXCEPTION 'Only Owners can change Owner or Admin accounts';
    END IF;
  END IF;

  -- Last-owner protection (was client-side only). Counts login-capable
  -- owners, not raw role rows.
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

-- Pre-deletion step for the deleteProfile server fn: under the SAME advisory
-- lock as set_user_role, enforce last-owner protection and remove the
-- target's role rows (the auth.users FKs were dropped in 20260702175542, so
-- auth.admin.deleteUser no longer cascades — without this, deleting an Owner
-- would orphan an 'owner' role row forever). Caller authorization (who may
-- delete whom) lives in the server fn; this function is service-role only.
CREATE OR REPLACE FUNCTION public.prepare_profile_deletion(_target uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _owner_count int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('user_roles_swap'));
  IF public.has_role(_target, 'owner'::app_role) THEN
    _owner_count := public.real_owner_count();
    IF _owner_count <= 1 THEN
      RAISE EXCEPTION 'Cannot delete the last Owner';
    END IF;
  END IF;
  DELETE FROM public.user_roles WHERE user_id = _target;
END $$;

REVOKE ALL ON FUNCTION public.prepare_profile_deletion(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_profile_deletion(uuid) TO service_role;
