-- ═══════════════════════════════════════════════════════════════════════════
-- ATTENDANCE OVERRIDES — the one unshipped piece of the 10/6 playbook (PR #363).
-- A manager flips a rep On/Off for TODAY from Close Kombat → Dispo; the
-- monday-ooh-report edge fn lays these rows over the Monday attendance-board
-- read (applyAttendanceOverrides in dispatch.ts), so the app BEATS the board in
-- both the live issuer and the watchdog — including turning ON a rep the
-- attendance board doesn't list at all.
--
-- One row per (day, office, rep): flipping again replaces the row; deleting it
-- restores the board's own word. Reads are owner/office_staff (the Dispo panel
-- + the service-role edge fn); writes go through the admin server fns
-- (service role), same doctrine as ooh_report_queue.
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261019120000_attendance_overrides.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- PR #363's branch SQL was run against prod before that PR was closed, leaving
-- an attendance_overrides table in the OLD shape (for_date, no rep_key /
-- updated_at) that no shipped code ever read or wrote. Replace it — but only
-- while it's empty; rows would mean something started using it after all, and
-- that calls for a human, not a silent drop.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'attendance_overrides'
      AND column_name = 'for_date'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.attendance_overrides) THEN
      RAISE EXCEPTION 'attendance_overrides has the legacy PR #363 shape AND rows — migrate it by hand';
    END IF;
    DROP TABLE public.attendance_overrides;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.attendance_overrides (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  override_date date NOT NULL,             -- the LA calendar day it applies to
  office text NOT NULL CHECK (office IN ('SD','OC')),
  rep_name text NOT NULL,                  -- display name as the manager typed it
  rep_key text NOT NULL,                   -- lowercased FIRST name — the dispatcher's attendance key
  status text NOT NULL CHECK (status IN ('on','off')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_overrides_day_office_rep_idx
  ON public.attendance_overrides (override_date, office, rep_key);
CREATE INDEX IF NOT EXISTS attendance_overrides_date_idx
  ON public.attendance_overrides (override_date);

GRANT ALL ON public.attendance_overrides TO service_role;
GRANT SELECT ON public.attendance_overrides TO authenticated;
ALTER TABLE public.attendance_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "attendance overrides read admin" ON public.attendance_overrides;
CREATE POLICY "attendance overrides read admin" ON public.attendance_overrides
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

-- Realtime so the Dispo panel reflects another manager's flip live.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_overrides;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
