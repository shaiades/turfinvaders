-- One-step reversible "Remove from roster" for the COMMAND dashboard.
-- Pairs with reactivate_agent (20260715042655): same caller tier, inverse
-- write. Write shape mirrors auto_archive_agents (is_active=false,
-- team_id=NULL); history rows (daily_logs, leads, daily_metrics, payroll)
-- are untouched. Runs AFTER 20260803010000_captain_global_canvassing_reads.sql
-- (needs is_privileged_account from it).
--
-- suspension_tracked is deliberately NOT touched (unlike deleteProfile's
-- archive branch in src/lib/fleet.functions.ts): every suspension surface
-- already excludes is_active=false rows, and reactivate_agent does not
-- restore the flag — clearing it here would make archive -> reactivate lossy
-- (a rehired agent would silently stay off the suspension donut).

CREATE OR REPLACE FUNCTION public.archive_agent(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller uuid := auth.uid();
  _caller_is_owner boolean;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  _caller_is_owner := public.has_role(_caller, 'owner'::app_role);
  IF NOT (
    _caller_is_owner
    OR public.has_role(_caller, 'captain'::app_role)
    OR public.has_role(_caller, 'office_staff'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only Owners, Captains, or Admins can remove agents';
  END IF;

  -- Nobody archives an account holding the owner role (mirrors
  -- auto_archive_agents' owner exclusion). Owner offboarding goes through
  -- role demotion (set_user_role, last-owner protected) or deleteProfile.
  IF public.has_role(_user_id, 'owner'::app_role) THEN
    RAISE EXCEPTION 'Owner accounts cannot be archived';
  END IF;

  -- Captains/Admins may not touch privileged accounts (owner/office_staff).
  IF NOT _caller_is_owner AND public.is_privileged_account(_user_id) THEN
    RAISE EXCEPTION 'Only Owners can archive Admin accounts';
  END IF;

  UPDATE public.profiles
  SET is_active = false,
      team_id = NULL,
      updated_at = now()
  WHERE id = _user_id;
END $$;

REVOKE ALL ON FUNCTION public.archive_agent(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_agent(uuid) TO authenticated, service_role;
