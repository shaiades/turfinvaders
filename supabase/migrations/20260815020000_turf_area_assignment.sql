-- Turf area assignment upgrade (SalesRabbit-style flow):
--   1) Provenance on turfs (who assigned it to whom, and when)
--   2) RLS fix: office_staff ("Manager" in the UI) could SELECT turfs but every
--      write silently failed — align write policies with the SELECT policy
--   3) turfs joins the realtime publication (reassignments propagate live)
--   4) Assignment history — "who worked this area last" so managers avoid
--      putting the same person in an area twice in a row
--   5) Knock results: renter / appt / go_back join the pin vocabulary
--   6) Tally mapping (pay/rank/bonus SUM over daily_logs — one bucket per pin):
--        doors_knocked:    knock, not_home
--        people_talked_to: talked_to, renter, go_back
--        not_interested:   not_interested
--        leads_called_in:  lead
--        appt:             bumps NOTHING — appointments/sales are counted from
--                          Monday.com boards (owner directive 2026-08-15); the
--                          pin only marks the house on the map.
-- Idempotent; apply by hand in the Supabase dashboard SQL editor.

-- 1) Provenance columns (assigned_user_id is already nullable)
ALTER TABLE public.turfs
  ADD COLUMN IF NOT EXISTS assigned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

-- Legacy rows assigned before this migration: date them from the row's own
-- timestamps so the edit sheet doesn't call them "unassigned" (assigner stays
-- NULL — displayed as "A manager").
UPDATE public.turfs
SET assigned_at = COALESCE(assigned_at, updated_at, created_at)
WHERE assigned_user_id IS NOT NULL AND assigned_at IS NULL;

-- The server owns provenance: clients never dictate assigned_by/assigned_at.
-- Stamps on insert-with-assignee and on any assignee change (including
-- unassign); preserves the old values on every other update (rename, recolor).
CREATE OR REPLACE FUNCTION public.stamp_turf_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_user_id IS NOT NULL THEN
      NEW.assigned_by := COALESCE(auth.uid(), NEW.assigned_by);
      NEW.assigned_at := now();
    END IF;
  ELSIF NEW.assigned_user_id IS DISTINCT FROM OLD.assigned_user_id THEN
    NEW.assigned_by := COALESCE(auth.uid(), NEW.assigned_by);
    NEW.assigned_at := now();
  ELSE
    NEW.assigned_by := OLD.assigned_by;
    NEW.assigned_at := OLD.assigned_at;
  END IF;
  RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION public.stamp_turf_assignment() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS turfs_stamp_assignment ON public.turfs;
CREATE TRIGGER turfs_stamp_assignment
  BEFORE INSERT OR UPDATE ON public.turfs
  FOR EACH ROW EXECUTE FUNCTION public.stamp_turf_assignment();

-- 2) Write policies now match the SELECT policy (owner/captain/office_staff)
DROP POLICY IF EXISTS "Owners and Captains can insert turfs" ON public.turfs;
DROP POLICY IF EXISTS "Owners and Captains can update turfs" ON public.turfs;
DROP POLICY IF EXISTS "Owners and Captains can delete turfs" ON public.turfs;
DROP POLICY IF EXISTS "Managers can insert turfs" ON public.turfs;
DROP POLICY IF EXISTS "Managers can update turfs" ON public.turfs;
DROP POLICY IF EXISTS "Managers can delete turfs" ON public.turfs;

CREATE POLICY "Managers can insert turfs"
  ON public.turfs FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'captain')
    OR public.has_role(auth.uid(), 'office_staff')
  );

CREATE POLICY "Managers can update turfs"
  ON public.turfs FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'captain')
    OR public.has_role(auth.uid(), 'office_staff')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'captain')
    OR public.has_role(auth.uid(), 'office_staff')
  );

CREATE POLICY "Managers can delete turfs"
  ON public.turfs FOR DELETE TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'captain')
    OR public.has_role(auth.uid(), 'office_staff')
  );

-- 3) Realtime (guarded — same pattern as close_kombat_block_cards)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'turfs'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.turfs';
  END IF;
END $$;

-- 4) Assignment history — append-only log written by trigger, read by managers
CREATE TABLE IF NOT EXISTS public.turf_assignment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turf_id uuid NOT NULL REFERENCES public.turfs(id) ON DELETE CASCADE,
  assigned_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_turf_history_turf
  ON public.turf_assignment_history (turf_id, assigned_at DESC);

GRANT SELECT ON public.turf_assignment_history TO authenticated;
GRANT ALL ON public.turf_assignment_history TO service_role;

ALTER TABLE public.turf_assignment_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Managers can view turf history" ON public.turf_assignment_history;
CREATE POLICY "Managers can view turf history"
  ON public.turf_assignment_history FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'captain')
    OR public.has_role(auth.uid(), 'office_staff')
  );
-- No INSERT/UPDATE/DELETE policies: rows are written only by the
-- SECURITY DEFINER trigger below.

CREATE OR REPLACE FUNCTION public.log_turf_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.assigned_user_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.assigned_user_id IS DISTINCT FROM OLD.assigned_user_id) THEN
    INSERT INTO public.turf_assignment_history (turf_id, assigned_user_id, assigned_by, assigned_at)
    VALUES (
      NEW.id,
      NEW.assigned_user_id,
      COALESCE(NEW.assigned_by, auth.uid()),
      COALESCE(NEW.assigned_at, now())
    );
  END IF;
  RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION public.log_turf_assignment() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS turfs_log_assignment ON public.turfs;
CREATE TRIGGER turfs_log_assignment
  AFTER INSERT OR UPDATE ON public.turfs
  FOR EACH ROW EXECUTE FUNCTION public.log_turf_assignment();

-- Seed history from currently assigned turfs so "last worked by" knows about
-- assignments made before this migration (idempotent: skips turfs that
-- already have any history).
INSERT INTO public.turf_assignment_history (turf_id, assigned_user_id, assigned_by, assigned_at)
SELECT t.id, t.assigned_user_id, t.assigned_by, COALESCE(t.assigned_at, t.updated_at, t.created_at)
FROM public.turfs t
WHERE t.assigned_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.turf_assignment_history h WHERE h.turf_id = t.id
  );

-- 5) Knock results (existing values reused: not_home = "NH", not_interested = "NI",
--    lead = "Lead"; talked_to/knock stay for legacy pins)
ALTER TYPE public.pin_type ADD VALUE IF NOT EXISTS 'renter';
ALTER TYPE public.pin_type ADD VALUE IF NOT EXISTS 'appt';
ALTER TYPE public.pin_type ADD VALUE IF NOT EXISTS 'go_back';

-- 6) Tally mapping (see header). Function body is parsed at call time, so the
--    new enum literals are safe to reference in the same migration.
CREATE OR REPLACE FUNCTION public.bump_daily_log_from_pin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _team uuid;
  _office text;
BEGIN
  IF NEW.is_remote_drop THEN
    RETURN NEW;
  END IF;

  SELECT team_id, COALESCE(office_location, 'San Diego')
    INTO _team, _office
  FROM public.profiles WHERE id = NEW.canvasser_id;

  INSERT INTO public.daily_logs (
    canvasser_id, team_id, log_date, office_location,
    doors_knocked, people_talked_to, not_interested, leads_called_in
  )
  VALUES (
    NEW.canvasser_id,
    _team,
    NEW.log_date,
    COALESCE(_office, 'San Diego'),
    CASE WHEN NEW.pin_type IN ('knock','not_home') THEN 1 ELSE 0 END,
    CASE WHEN NEW.pin_type IN ('talked_to','renter','go_back') THEN 1 ELSE 0 END,
    CASE WHEN NEW.pin_type = 'not_interested' THEN 1 ELSE 0 END,
    CASE WHEN NEW.pin_type = 'lead' THEN 1 ELSE 0 END
  )
  ON CONFLICT (canvasser_id, log_date, office_location) DO UPDATE
    SET doors_knocked    = public.daily_logs.doors_knocked    + EXCLUDED.doors_knocked,
        people_talked_to = public.daily_logs.people_talked_to + EXCLUDED.people_talked_to,
        not_interested   = public.daily_logs.not_interested   + EXCLUDED.not_interested,
        leads_called_in  = public.daily_logs.leads_called_in  + EXCLUDED.leads_called_in,
        updated_at       = now();
  RETURN NEW;
END $function$;
