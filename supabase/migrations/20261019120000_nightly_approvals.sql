-- ═══════════════════════════════════════════════════════════════════════════
-- NIGHTLY APPROVALS (owner mandate 2026-10-08 night, rules H / I / J).
-- One row per PROPOSED CHANGE on the "Nightly Lineup – Approvals" Monday board
-- (18433860636): the snapshot of the block item at proposal time (people6 +
-- status labels) that the rule-H5 pre-write guard compares against, the
-- add-only reps to add (rules I6/I8), and the decision outcome (rule J10 —
-- the per-write audit itself stays in ooh_dispatch_writes).
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261019120000_nightly_approvals.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.nightly_approvals (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  approvals_item_id text NOT NULL UNIQUE,     -- the approvals-board row
  block_item_id text NOT NULL,                -- the block item it mirrors
  block_board_id text NOT NULL,
  office text,                                -- 'SD' | 'OC'
  lead_date date,                             -- the block day the row plans
  lead_name text,
  snapshot_rep_names text[] NOT NULL DEFAULT '{}',   -- people6 at proposal time
  snapshot_statuses jsonb,                    -- {iss,pm,rs,ol,bo,sale} at proposal time
  proposed_add_names text[] NOT NULL DEFAULT '{}',   -- ADD-ONLY (rule I8)
  reason text,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','applied','skipped','rejected')),
  decided_by text,                            -- the manager who pressed Approve/Reject
  decided_at timestamptz,
  applied_at timestamptz,
  result_note text                            -- e.g. 'Changed by office, skipped'
);
CREATE INDEX IF NOT EXISTS nightly_approvals_date_idx
  ON public.nightly_approvals (lead_date, office) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS nightly_approvals_block_idx
  ON public.nightly_approvals (block_item_id);

GRANT ALL ON public.nightly_approvals TO service_role;
GRANT SELECT ON public.nightly_approvals TO authenticated;
ALTER TABLE public.nightly_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "nightly approvals read admin" ON public.nightly_approvals;
CREATE POLICY "nightly approvals read admin" ON public.nightly_approvals
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));
