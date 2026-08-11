
-- Owner decision 2026-08-03: captains are canvassing managers and see ALL
-- teams' canvassing data — reads only. Payroll writes, pay-lock columns, and
-- Close Kombat block_cards are deliberately untouched (block_cards stays
-- owner/office_staff/sales_rep; captains remain excluded).
--
-- daily_metrics, turfs, and time_entries already grant any-captain reads and
-- are not touched here.

-- Helper shared by this and the following migrations: accounts that captains
-- and office_staff may NOT manage (role changes, van moves, deletion).
CREATE OR REPLACE FUNCTION public.is_privileged_account(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role IN ('owner'::app_role, 'office_staff'::app_role)
  )
$$;
REVOKE ALL ON FUNCTION public.is_privileged_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_privileged_account(uuid) TO authenticated, service_role;

-- 1) daily_logs: widen the captain arm from own-team to any captain.
DROP POLICY IF EXISTS "daily_logs read scoped" ON public.daily_logs;
CREATE POLICY "daily_logs read scoped"
  ON public.daily_logs FOR SELECT
  USING (
    canvasser_id = auth.uid()
    OR public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'captain'::app_role)
  );

-- 2) leads: same widening. "leads review update" is unchanged — lead review
--    stays owner/office_staff/self-pending.
DROP POLICY IF EXISTS "leads read scoped" ON public.leads;
CREATE POLICY "leads read scoped"
  ON public.leads FOR SELECT
  USING (
    canvasser_id = auth.uid()
    OR public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'captain'::app_role)
  );

-- 3) field_pins: replace the team-scoped captain read with read-all.
DROP POLICY IF EXISTS "Captains view their canvassers pins" ON public.field_pins;
DROP POLICY IF EXISTS "Captains view all pins" ON public.field_pins;
CREATE POLICY "Captains view all pins"
  ON public.field_pins FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'captain'::app_role));

-- 4) territories: keep the team-scoped MANAGE policy (writes stay own-van);
--    add a read-all arm so captains can see every van's territories.
DROP POLICY IF EXISTS "Captains view all territories" ON public.territories;
CREATE POLICY "Captains view all territories"
  ON public.territories FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'captain'::app_role));

-- 5) lead_events + hype_events: additive captain read — the global
--    visibility toggle is no longer the only cross-team path for captains.
DROP POLICY IF EXISTS "Captains read all lead_events" ON public.lead_events;
CREATE POLICY "Captains read all lead_events"
  ON public.lead_events FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'captain'::app_role));

DROP POLICY IF EXISTS "Captains read all hype_events" ON public.hype_events;
CREATE POLICY "Captains read all hype_events"
  ON public.hype_events FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'captain'::app_role));

-- 6) profiles + teams: captains AND office_staff see the whole roster and
--    fleet regardless of the global visibility toggle. (office_staff
--    previously depended on the toggle for cross-team reads — the Manage
--    Players and Permissions screens need the full roster either way.)
DROP POLICY IF EXISTS "Captains view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Managers view all profiles" ON public.profiles;
CREATE POLICY "Managers view all profiles"
  ON public.profiles FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'captain'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
  );

DROP POLICY IF EXISTS "Captains view all teams" ON public.teams;
DROP POLICY IF EXISTS "Managers view all teams" ON public.teams;
CREATE POLICY "Managers view all teams"
  ON public.teams FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'captain'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
  );

-- 7) user_roles: captains and office_staff can read every user's role — the
--    Manage Players table and the Permissions tab need true roles, not the
--    self-only view they get today. Writes stay owner-only ("Owners manage
--    roles") plus the set_user_role RPC added in the next migration.
DROP POLICY IF EXISTS "Managers read all roles" ON public.user_roles;
CREATE POLICY "Managers read all roles"
  ON public.user_roles FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'captain'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
  );
