-- ═══════════════════════════════════════════════════════════════════════════
-- OUT OF HOUSE (OOH) write-back (owner brief 2026-10-03).
--
-- When a rep submits the Monday form "Out of House Reports" (board 18433859050)
-- an edge function (supabase/functions/monday-ooh-report) writes the disposition
-- onto the lead's BLOCK item and lets the block's own automations route it.
--
-- This migration adds:
--   1. system_settings kill switch + roll-out controls (default OFF — nothing
--      is written to live Monday until an owner flips it);
--   2. ooh_processed_reports — idempotency: a retried webhook never presses a
--      button twice;
--   3. ooh_report_queue — the Close Kombat admin queue for dry-run previews,
--      unmatched submissions, and errors (RLS: owner + office_staff only).
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261008120000_ooh_writeback.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Roll-out controls on the single-row system_settings table ─────────────
-- mode: 'off'      → acknowledge the webhook, write nothing (default, safest);
--       'dry_run'  → compute the full plan and store it in ooh_report_queue,
--                    still write nothing to Monday (ZZ TEST / preview);
--       'live'     → execute (press buttons), gated by the board allowlist.
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS ooh_writeback_mode text NOT NULL DEFAULT 'off';
-- Comma-separated BLOCK board ids allowed to receive LIVE button presses. Empty
-- in 'live' mode = all current block boards. Set it to the ZZ TEST board id to
-- rehearse live on one board before going fully live.
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS ooh_writeback_board_allowlist text;
-- Auto-create new block items for self-gen / upsell / reload submissions that
-- carry no Lead ID. OFF by default — these route to the admin queue until the
-- rep→Monday-user and office mapping is confirmed (see PR "Decisions for Shai").
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS ooh_autocreate boolean NOT NULL DEFAULT false;
-- Go-live instant: the missing-reports list only counts leads issued at/after
-- this time, so historic leads are never back-filled. NULL = feature not live.
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS ooh_go_live_at timestamptz;
-- Public share URL of the "Out of House Reports" Monday form. Powers the rep's
-- "Report" deep-link (prefilled). NULL hides the button. Non-sensitive — exposed
-- to the app via the getOohConfig server fn (which never returns the API token).
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS ooh_form_url text;

-- ── 2. Idempotency ledger ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ooh_processed_reports (
  form_item_id text PRIMARY KEY,              -- the Monday form item id (one per submission)
  trigger_uuid text,                           -- Monday webhook delivery id (dedupe retries)
  outcome text,                                -- 'written' | 'created' | 'queued' | 'dry_run' | 'error'
  target_item_id text,                         -- the block item we wrote to (if any)
  board_id text,                               -- the block board id
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ooh_processed_target_idx ON public.ooh_processed_reports (target_item_id);
CREATE INDEX IF NOT EXISTS ooh_processed_trigger_idx ON public.ooh_processed_reports (trigger_uuid);
GRANT ALL ON public.ooh_processed_reports TO service_role;
GRANT SELECT ON public.ooh_processed_reports TO authenticated;
ALTER TABLE public.ooh_processed_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ooh processed read admin" ON public.ooh_processed_reports;
CREATE POLICY "ooh processed read admin" ON public.ooh_processed_reports
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

-- ── 3. Admin queue (dry-run previews, unmatched submissions, errors) ─────────
CREATE TABLE IF NOT EXISTS public.ooh_report_queue (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  form_item_id text NOT NULL,
  rep_name text,
  partner text,
  office text,                                 -- 'SD' | 'OC' | null (unknown)
  result int,                                  -- 0..7 form Result index
  on_block int,                                -- 0..3 form "On today's block?" index
  lead_id text,                                -- block item id from the form (if any)
  target_item_id text,                         -- resolved block item (if any)
  board_id text,                               -- resolved block board (if any)
  status text NOT NULL DEFAULT 'needs_review'
    CHECK (status IN ('dry_run','needs_review','error','processed','dismissed','disabled')),
  reason text,                                 -- why it's here
  details_line text,                           -- the Details line we would append
  plan jsonb,                                  -- the computed write plan (audit)
  raw jsonb,                                   -- the parsed form (audit)
  error text,
  decided_by uuid REFERENCES auth.users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (form_item_id)
);
CREATE INDEX IF NOT EXISTS ooh_queue_status_idx ON public.ooh_report_queue (status);
CREATE INDEX IF NOT EXISTS ooh_queue_created_idx ON public.ooh_report_queue (created_at);

GRANT ALL ON public.ooh_report_queue TO service_role;
GRANT SELECT, UPDATE ON public.ooh_report_queue TO authenticated;
ALTER TABLE public.ooh_report_queue ENABLE ROW LEVEL SECURITY;

-- Read + resolve: owner + office_staff only (the office).
DROP POLICY IF EXISTS "ooh queue read admin" ON public.ooh_report_queue;
CREATE POLICY "ooh queue read admin" ON public.ooh_report_queue
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));
DROP POLICY IF EXISTS "ooh queue update admin" ON public.ooh_report_queue;
CREATE POLICY "ooh queue update admin" ON public.ooh_report_queue
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'))
  WITH CHECK (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

DROP TRIGGER IF EXISTS ooh_report_queue_touch ON public.ooh_report_queue;
CREATE TRIGGER ooh_report_queue_touch
  BEFORE UPDATE ON public.ooh_report_queue
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Realtime: the admin queue updates live.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.ooh_report_queue;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
ALTER TABLE public.ooh_report_queue REPLICA IDENTITY FULL;
