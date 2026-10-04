-- ═══════════════════════════════════════════════════════════════════════════
-- RESPAWN — sales-rep shift-off requests (Close Kombat, owner ask 2026-10-03).
--
-- A closer steps off the floor to recharge: reps request AM/PM shifts off,
-- weeks ahead; Tyler / Shai / Jorge (owner + office_staff) approve; approved
-- shifts flow to the Monday attendance boards. DISTINCT from the van-crew
-- day_off_requests table (per-day, captain-approved — migration
-- 20261002180000): different people, shape, and approvers.
--
-- One row per rep per week (unique user_id + week_start). Editing replaces
-- that week's request and — handled in the submit server fn — sends an
-- approved request back to Pending. Every write that must also touch Monday
-- goes through the respawn.server.ts fns using supabaseAdmin (service role);
-- the RLS write policies below are a self-serve backstop.
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261006120000_respawn_requests.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.respawn_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  rep_name text NOT NULL,                       -- profiles.display_name snapshot
  office text NOT NULL CHECK (office IN ('SD','OC')),
  week_start date NOT NULL,                      -- the Monday of the requested week
  shifts text[] NOT NULL DEFAULT '{}',           -- e.g. {mon_am,fri_pm}
  reason text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied')),
  late boolean NOT NULL DEFAULT false,           -- submitted past Sunday-noon PT deadline
  decided_by uuid REFERENCES auth.users(id),
  decided_at timestamptz,
  decision_note text,
  monday_item_id text,                           -- the Day-Off board item id
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start)
);

CREATE INDEX IF NOT EXISTS respawn_requests_week_idx ON public.respawn_requests (week_start);
CREATE INDEX IF NOT EXISTS respawn_requests_status_idx ON public.respawn_requests (status);
CREATE INDEX IF NOT EXISTS respawn_requests_user_idx ON public.respawn_requests (user_id, week_start);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.respawn_requests TO authenticated;
GRANT ALL ON public.respawn_requests TO service_role;
ALTER TABLE public.respawn_requests ENABLE ROW LEVEL SECURITY;

-- Read: a rep sees their own rows; owner + office_staff (the approvers) see all.
DROP POLICY IF EXISTS "respawn read own or admin" ON public.respawn_requests;
CREATE POLICY "respawn read own or admin" ON public.respawn_requests
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
  );

-- Insert: a rep may self-serve create their own PENDING row (the server fn is
-- the real path — it also stamps Monday — but this keeps the feature usable
-- if a direct write is ever needed).
DROP POLICY IF EXISTS "respawn insert own pending" ON public.respawn_requests;
CREATE POLICY "respawn insert own pending" ON public.respawn_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND status = 'pending'
    AND decided_by IS NULL
    AND decided_at IS NULL
  );

-- Update: a rep may edit their own row WHILE it is still pending; the approvers
-- may update anything (approve / deny). The approved→pending reset on an edit
-- runs in the server fn (service role), so a rep never needs to update a
-- non-pending row directly.
DROP POLICY IF EXISTS "respawn update own pending" ON public.respawn_requests;
CREATE POLICY "respawn update own pending" ON public.respawn_requests
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND status = 'pending')
  WITH CHECK (user_id = auth.uid() AND status = 'pending');

DROP POLICY IF EXISTS "respawn update admin" ON public.respawn_requests;
CREATE POLICY "respawn update admin" ON public.respawn_requests
  FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
  );

-- Delete: a rep may withdraw their own pending row; approvers may delete any.
-- (Withdrawing an approved row goes through the cancel server fn so Monday is
-- cleared too.)
DROP POLICY IF EXISTS "respawn delete own pending or admin" ON public.respawn_requests;
CREATE POLICY "respawn delete own pending or admin" ON public.respawn_requests
  FOR DELETE TO authenticated
  USING (
    (user_id = auth.uid() AND status = 'pending')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
  );

-- updated_at bump (shared trigger fn defined in 20260627214147_*).
DROP TRIGGER IF EXISTS respawn_requests_touch ON public.respawn_requests;
CREATE TRIGGER respawn_requests_touch
  BEFORE UPDATE ON public.respawn_requests
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Realtime: the rep's status and the approver's queue update live.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.respawn_requests;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
ALTER TABLE public.respawn_requests REPLICA IDENTITY FULL;
