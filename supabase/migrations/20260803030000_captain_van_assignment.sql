
-- Captains and Admins (office_staff) move/assign people to vans. Runs AFTER
-- 20260803010000_captain_global_canvassing_reads.sql (needs
-- is_privileged_account from it).
--
-- Write paths this admits: FleetDispatchManage.assignCanvasser and
-- users.tsx setTeam (profiles.team_id / office_location), plus the Fleet
-- Dispatch suspension toggle (profiles.suspension_tracked). Targets holding
-- owner/office_staff are excluded. office_staff is included because the UI
-- tier for these writes is the manager tier (canManageTarget) — without it
-- Admin van moves silently match 0 rows.
--
-- Pay columns (current_rank, pay_lock_*, rolling stats) stay safe ONLY
-- because the profiles_guard_pay_columns BEFORE UPDATE trigger
-- (20260718183328) silently reverts them for any writer that isn't
-- service-role/owner/pay-engine. If that trigger is ever removed, this
-- policy must gain explicit column protection.
--
-- Deliberately NOT granted: non-owner writes on teams — van
-- create/edit/delete stays owner-tier.

DROP POLICY IF EXISTS "Captains update non-privileged profiles" ON public.profiles;
DROP POLICY IF EXISTS "Managers update non-privileged profiles" ON public.profiles;
CREATE POLICY "Managers update non-privileged profiles"
  ON public.profiles FOR UPDATE TO authenticated
  USING (
    (
      public.has_role(auth.uid(), 'captain'::app_role)
      OR public.has_role(auth.uid(), 'office_staff'::app_role)
    )
    AND NOT public.is_privileged_account(profiles.id)
  )
  WITH CHECK (
    (
      public.has_role(auth.uid(), 'captain'::app_role)
      OR public.has_role(auth.uid(), 'office_staff'::app_role)
    )
    AND NOT public.is_privileged_account(profiles.id)
  );
