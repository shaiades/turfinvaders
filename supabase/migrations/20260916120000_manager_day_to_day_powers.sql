-- Manager (office_staff) day-to-day powers — owner ask 2026-09-16, with the
-- Manage Players consolidation: "Managers should be able to work everything;
-- managers can create captains as well."
--
-- Three changes, each widening an owner-only gate to the Admin tier
-- (owner + office_staff). Captains gain nothing here.
--
--   1) set_user_role: Managers may re-role NON-privileged accounts to
--      captain / sales_rep / confirmer / canvasser. Granting owner or
--      office_staff — and touching any account that holds either — stays
--      owner-only. Advisory lock + last-owner protection kept verbatim
--      from 20260812010000.
--   2) teams: van create/edit/delete for the Admin tier ("Admins manage
--      teams" replaces the owner-only "Owners manage teams" ALL policy).
--      Captains keep read-only ("Managers view all teams" is SELECT).
--   3) company_settings: the Global Visibility toggle has always rendered
--      for Managers but its UPDATE policy was owner-only, so their saves
--      died as a silent RLS no-op — widen to the Admin tier.
--
-- Client mirrors shipped in the same PR: assignableRolesFor /
-- creatableRolesFor (role-policy.ts), createCanvasser / addTeamMember
-- (users.functions.ts), deleteVan / deleteProfile (fleet.functions.ts).
-- Keep them in lockstep with this file.
--
-- Idempotent; applied via: supabase db query --linked --file <this file>

-- 1) set_user_role — owner arm unchanged; new office_staff arm.
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
    -- Field tiers only: minting Owners/Managers stays owner-only.
    IF _new_role NOT IN (
      'captain'::app_role, 'sales_rep'::app_role,
      'confirmer'::app_role, 'canvasser'::app_role
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

-- 2) teams: Admin-tier writes (was owner-only).
DROP POLICY IF EXISTS "Owners manage teams" ON public.teams;
DROP POLICY IF EXISTS "Admins manage teams" ON public.teams;
CREATE POLICY "Admins manage teams"
  ON public.teams FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
  );

-- 3) company_settings: Admin-tier updates (was owner-only + silently
--    failing for the Managers the panel already renders for).
DROP POLICY IF EXISTS "Owners update company settings" ON public.company_settings;
DROP POLICY IF EXISTS "Admins update company settings" ON public.company_settings;
CREATE POLICY "Admins update company settings"
  ON public.company_settings FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
  );
