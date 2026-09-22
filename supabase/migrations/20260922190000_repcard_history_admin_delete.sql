-- Historical coverage: owners + Managers can delete RepCard 2026 areas
-- (owner ask 2026-09-22: "give owners and managers the ability to delete
-- pre-made areas and territories — Historical coverage is what it's called —
-- and the option to reassign those areas").
--
-- This narrows the 20260914170000 "READ-ONLY history / no app code writes"
-- doctrine for repcard_territory_history by exactly one verb: DELETE, for the
-- admin tier (owner + office_staff — captains are canvassing managers, not
-- admins; same doctrine as zip_assignments, 20260911100000). INSERT and
-- UPDATE stay blocked: "reassign" is not an edit of a history row — the app
-- promotes the polygon into a live public.turfs row through the existing
-- assignment flow, then deletes the history row here.
--
-- Recovery / caveat: rows come from scripts/repcard/repcard_2026_seed.sql,
-- whose territory INSERTs are ON CONFLICT (repcard_area_id) DO NOTHING — so a
-- deleted ring is recoverable by re-running the seed, and equally a seed
-- re-run RESURRECTS every ring managers deleted on purpose. Don't re-seed
-- casually once cleanup has started.
--
-- Realtime: the table joins supabase_realtime with REPLICA IDENTITY FULL so a
-- delete disappears from other leadership devices in ~1s instead of hiding
-- behind the client's 1h staleTime. House rule (20260915170000): RLS-scoped
-- UPDATE/DELETE events are delivered only when the OLD row is fully in WAL.
--
-- Client mirrors shipped in the same PR: popup Assign/Delete actions on the
-- dashed rings (NeonMap.tsx), promote + delete wiring and the
-- repcard_territory_history realtime subscription (my-territory.tsx).
-- Keep them in lockstep with this file.
--
-- Idempotent; applied via: supabase db query --linked --file <this file>

-- 1) Admin-tier DELETE ---------------------------------------------------------
DROP POLICY IF EXISTS "repcard_territory_admin_delete" ON public.repcard_territory_history;
CREATE POLICY "repcard_territory_admin_delete"
  ON public.repcard_territory_history FOR DELETE TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
  );

-- Belt and braces: Supabase default privileges almost certainly grant this
-- already, but the table's policy surface should read complete on its own.
GRANT SELECT, DELETE ON public.repcard_territory_history TO authenticated;

-- 2) Realtime ------------------------------------------------------------------
ALTER TABLE public.repcard_territory_history REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'repcard_territory_history'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.repcard_territory_history';
  END IF;
END $$;
