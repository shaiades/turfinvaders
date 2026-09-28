-- Captains join the area-assignment tier (owner decision 2026-09-28: "give
-- captains the tools they need" — a captain promoted to owner just to assign
-- areas lost door marking; captains must be able to assign from the map).
--
-- This SUPERSEDES the admin-only writes doctrine of 20260911100000
-- (zip_assignments) and widens the 20260922190000 repcard DELETE policy by
-- one role. Two changes:
--
--   1) zip_assignments writes: owner/office_staff/captain. Captains can now
--      take, hand off, and unassign ZIP zones. Provenance stays server-side
--      via stamp_zip_assignment (unchanged).
--   2) repcard_territory_history DELETE: + captain. Required by the promote
--      flow, not just the delete button — assigning a historical ring inserts
--      a live turfs row (captains already pass that policy) and then DELETEs
--      the dashed source ring (removePromotedHistoryRow, my-territory.tsx);
--      without this, every captain promotion strands a ghost ring no captain
--      can clear. The DIRECT "Delete history outline" popup action stays
--      admin-only in the UI; a deleted ring remains seed-recoverable
--      (scripts/repcard/repcard_2026_seed.sql, ON CONFLICT DO NOTHING).
--
-- INSERT/UPDATE on repcard_territory_history stay blocked for everyone — the
-- 20260914170000 read-only-history doctrine is otherwise intact.
--
-- Client mirrors ship in the same PR: the ManagerTerritoryView isAdmin gates
-- on ZIP tools + historical assign flip to the manager tier (canAssign).
-- Keep them in lockstep with this file.
--
-- Idempotent; applied via: supabase db query --linked --file <this file>

-- 1) ZIP command writes: manager tier -----------------------------------------
DROP POLICY IF EXISTS "Admins manage zip_assignments" ON public.zip_assignments;
DROP POLICY IF EXISTS "Managers manage zip_assignments" ON public.zip_assignments;
CREATE POLICY "Managers manage zip_assignments"
  ON public.zip_assignments FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
    OR public.has_role(auth.uid(), 'captain')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
    OR public.has_role(auth.uid(), 'captain')
  );

-- 2) Historical coverage DELETE: manager tier ----------------------------------
DROP POLICY IF EXISTS "repcard_territory_admin_delete" ON public.repcard_territory_history;
DROP POLICY IF EXISTS "repcard_territory_manager_delete" ON public.repcard_territory_history;
CREATE POLICY "repcard_territory_manager_delete"
  ON public.repcard_territory_history FOR DELETE TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
    OR public.has_role(auth.uid(), 'captain')
  );
