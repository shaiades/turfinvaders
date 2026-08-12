
-- Owner decision 2026-08-12: changing an EXISTING person's role is
-- owner-only. The captain arm of set_user_role let a captain re-role any
-- non-privileged account — including granting captain, and including
-- themself (there was no self-change guard). Captains/Admins keep roster
-- work: van moves ("Managers update non-privileged profiles",
-- 20260803030000), archive_agent (20260811010000), reactivate_agent, and
-- creating brand-new Canvassers/Sales Reps via the server fns. Runs AFTER
-- 20260803010000_captain_global_canvassing_reads.sql (needs
-- is_privileged_account from it) and 20260803020000_set_user_role.sql
-- (replaces set_user_role in place; needs real_owner_count from it).
--
-- Also closed here, found in the same review:
--   * reactivate_agent (20260715042655) checked the caller tier but not the
--     target — a captain could reactivate an archived Owner/Admin account.
--     It now carries the same privileged-target check archive_agent has.
--   * auto_archive_agents (20260715042655) had NO caller check and EXECUTE
--     granted to authenticated — any signed-in canvasser could fire the
--     bulk 14-day sweep. Its only real caller is the pg_cron job
--     'auto-archive-agents-daily' (runs as the job owner, no JWT), which is
--     unaffected. EXECUTE is revoked from authenticated, and a guard inside
--     the function now rejects any end-user JWT context so the hole stays
--     shut even if the 20260715042655 grant is ever re-applied by hand.
--
-- If either 20260803020000 or 20260715042655 is ever re-pasted into the
-- dashboard after this file, re-run this file immediately after — they
-- would resurrect the captain arm / the authenticated grant.
--
-- NO policies change in this migration. "Owners manage roles" and
-- "Managers read all roles" (user_roles), and "Managers update
-- non-privileged profiles" (profiles, van moves) all stay exactly as-is.
-- All three functions keep their exact signatures, parameter names, and
-- return types (PostgREST callers pass named args).

-- 1) set_user_role: owner-only caller. Keeps the advisory lock, the
--    last-owner protection (an Owner demoting themself while last is still
--    blocked), and the DELETE+INSERT one-role-per-user swap. Owners may
--    still grant any role, including a second owner. The useSetUserRole
--    hook keeps calling it unchanged; non-owners now get the exception
--    below as a toast.
CREATE OR REPLACE FUNCTION public.set_user_role(_target_user uuid, _new_role app_role)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _caller uuid := auth.uid();
  _owner_count int;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Owner decision 2026-08-12: role changes are owner-only. Captains and
  -- Admins create new Canvassers/Sales Reps through the server functions,
  -- but never re-role an existing account.
  IF NOT public.has_role(_caller, 'owner'::app_role) THEN
    RAISE EXCEPTION 'Only Owners can change roles';
  END IF;

  -- Serialize role swaps so the last-owner check can't be raced by a
  -- concurrent demotion.
  PERFORM pg_advisory_xact_lock(hashtext('user_roles_swap'));

  -- Last-owner protection. Counts login-capable owners, not raw role rows.
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

-- 2) reactivate_agent: same manager-tier caller as before, now with the
--    privileged-target check its inverse (archive_agent, 20260811010000)
--    already enforces. Owners may reactivate anyone. Write shape unchanged
--    (is_active = true only; team_id stays NULL until a manager re-assigns).
CREATE OR REPLACE FUNCTION public.reactivate_agent(_user_id uuid)
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
    RAISE EXCEPTION 'Only Owners, Captains, or Admins can reactivate agents';
  END IF;

  -- Captains/Admins may not touch privileged accounts (owner/office_staff)
  -- — mirrors archive_agent.
  IF NOT _caller_is_owner AND public.is_privileged_account(_user_id) THEN
    RAISE EXCEPTION 'Only Owners can reactivate Admin accounts';
  END IF;

  UPDATE public.profiles
  SET is_active = true, updated_at = now()
  WHERE id = _user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reactivate_agent(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reactivate_agent(uuid) TO authenticated, service_role;

-- 3) auto_archive_agents: cron/service only. Sweep logic and RETURNS
--    integer are exactly as in 20260715042655; only the guard is new. The
--    pg_cron job 'auto-archive-agents-daily' runs with no JWT
--    (auth.uid() IS NULL) and keeps working, as do the dashboard SQL
--    editor and service_role. Any end-user JWT is rejected.
CREATE OR REPLACE FUNCTION public.auto_archive_agents()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _cutoff timestamptz := now() - interval '14 days';
  _archived integer := 0;
BEGIN
  -- Cron / service contexts carry no JWT. A signed-in user (any role) must
  -- not be able to fire a bulk archive sweep.
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'auto_archive_agents runs from cron/service contexts only';
  END IF;

  WITH last_activity AS (
    SELECT canvasser_id, MAX(metric_date) AS last_date
    FROM public.daily_metrics
    GROUP BY canvasser_id
  ),
  targets AS (
    SELECT p.id
    FROM public.profiles p
    LEFT JOIN last_activity la ON la.canvasser_id = p.id
    WHERE p.is_active = true
      AND (
        (la.last_date IS NOT NULL AND la.last_date < (_cutoff)::date)
        OR (la.last_date IS NULL AND p.created_at < _cutoff)
      )
      -- Never archive owners.
      AND NOT public.has_role(p.id, 'owner'::app_role)
  )
  UPDATE public.profiles p
  SET is_active = false,
      team_id = NULL,
      updated_at = now()
  FROM targets t
  WHERE p.id = t.id;

  GET DIAGNOSTICS _archived = ROW_COUNT;
  RETURN _archived;
END;
$$;

REVOKE ALL ON FUNCTION public.auto_archive_agents() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_archive_agents() TO service_role;
