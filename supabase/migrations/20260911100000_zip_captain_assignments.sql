-- ZIP command assignments (owner ask 2026-09-11): admins assign ZIP codes to
-- captains, then captains chunk their ZIPs into canvasser turfs with the
-- existing Turf Tools drawing flow. One captain per ZIP (the ZIP is the PK);
-- reassigning overwrites, unassigning deletes the row. Boundaries are NEVER
-- stored — the app renders live Census ZCTA polygons and tints the assigned
-- ones, so this table is just zip → captain.
--
-- Reads: every authenticated user (assignment colors show on manager and
-- captain maps; same transparency posture as turfs). Writes: ADMIN tier only
-- (owner/office_staff) — captains never self-assign ZIPs, matching the role
-- tiers decision (captains are canvassing managers, not admins).
--
-- Provenance is server-stamped, mirroring stamp_turf_assignment: clients
-- never dictate assigned_by/assigned_at.
-- Idempotent; apply by hand in the Supabase dashboard SQL editor.

CREATE TABLE IF NOT EXISTS public.zip_assignments (
  zip text PRIMARY KEY CHECK (zip ~ '^\d{5}$'),
  captain_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_zip_assignments_captain ON public.zip_assignments (captain_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.zip_assignments TO authenticated;
GRANT ALL ON public.zip_assignments TO service_role;

ALTER TABLE public.zip_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "zip_assignments read" ON public.zip_assignments;
CREATE POLICY "zip_assignments read"
  ON public.zip_assignments FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Admins manage zip_assignments" ON public.zip_assignments;
CREATE POLICY "Admins manage zip_assignments"
  ON public.zip_assignments FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
  );

-- Server-side provenance stamp (stamp_turf_assignment pattern).
CREATE OR REPLACE FUNCTION public.stamp_zip_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.captain_id IS DISTINCT FROM OLD.captain_id THEN
    NEW.assigned_by := COALESCE(auth.uid(), NEW.assigned_by);
    NEW.assigned_at := now();
  ELSE
    NEW.assigned_by := OLD.assigned_by;
    NEW.assigned_at := OLD.assigned_at;
  END IF;
  RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION public.stamp_zip_assignment() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zip_assignments_stamp ON public.zip_assignments;
CREATE TRIGGER zip_assignments_stamp
  BEFORE INSERT OR UPDATE ON public.zip_assignments
  FOR EACH ROW EXECUTE FUNCTION public.stamp_zip_assignment();

-- Realtime (guarded — same pattern as profiles_realtime_publication).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'zip_assignments'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.zip_assignments';
  END IF;
END $$;
ALTER TABLE public.zip_assignments REPLICA IDENTITY FULL;
