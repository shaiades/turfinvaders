-- ═══════════════════════════════════════════════════════════════════════════
-- LIVE DISPATCH v2 (Step 7 follow-up, owner brief 2026-10-06).
--
-- Adds the three tables the updated dispatcher needs:
--   1. attendance_overrides — managers flip a rep On/Off for a day from Turf
--      Invaders; an override BEATS the Monday attendance board (which is
--      sometimes wrong). Read by the edge fn for issuing + the watchdog.
--   2. ooh_missing_report_alerts — one row per lead the missing-report
--      watchdog has alerted on (issued, 3+ hours past start, no report), so a
--      given lead is never alerted twice.
--   3. ooh_salesproc_followups — the Sold follow-up queue: after a Sold the
--      block automation moves the item to Sales Processing (4155553389) with
--      the same id; the watchdog fills Deposit/Finance/Advantage+/Reloads once
--      the move lands, from what the rep's report said.
--
-- No behavior flips here: everything still rides ooh_writeback_mode /
-- live_dispatch_mode (+ ooh_autocreate for the off-block add).
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261018120000_live_dispatch_v2.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Manager attendance overrides (beat the board) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.attendance_overrides (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  office text NOT NULL CHECK (office IN ('SD','OC')),
  rep_name text NOT NULL,
  for_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('on','off')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One override per rep (first name — the dispatch matching key) per office+day.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_overrides_key
  ON public.attendance_overrides (office, for_date, lower(split_part(rep_name, ' ', 1)));
CREATE INDEX IF NOT EXISTS attendance_overrides_date_idx
  ON public.attendance_overrides (for_date);

GRANT ALL ON public.attendance_overrides TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendance_overrides TO authenticated;
ALTER TABLE public.attendance_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "attendance overrides admin read" ON public.attendance_overrides;
CREATE POLICY "attendance overrides admin read" ON public.attendance_overrides
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));
DROP POLICY IF EXISTS "attendance overrides admin write" ON public.attendance_overrides;
CREATE POLICY "attendance overrides admin write" ON public.attendance_overrides
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));
DROP POLICY IF EXISTS "attendance overrides admin update" ON public.attendance_overrides;
CREATE POLICY "attendance overrides admin update" ON public.attendance_overrides
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'))
  WITH CHECK (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));
DROP POLICY IF EXISTS "attendance overrides admin delete" ON public.attendance_overrides;
CREATE POLICY "attendance overrides admin delete" ON public.attendance_overrides
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

-- ── 2. Missing-report alert ledger (never alert the same lead twice) ─────────
CREATE TABLE IF NOT EXISTS public.ooh_missing_report_alerts (
  lead_item_id text PRIMARY KEY,
  office text,
  board_id text,
  alerted_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.ooh_missing_report_alerts TO service_role;
GRANT SELECT ON public.ooh_missing_report_alerts TO authenticated;
ALTER TABLE public.ooh_missing_report_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ooh missing report read admin" ON public.ooh_missing_report_alerts;
CREATE POLICY "ooh missing report read admin" ON public.ooh_missing_report_alerts
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

-- ── 3. Sales Processing follow-up queue (Sold → fill once the move lands) ────
CREATE TABLE IF NOT EXISTS public.ooh_salesproc_followups (
  form_item_id text PRIMARY KEY,          -- the Dispo report that sold it
  lead_item_id text NOT NULL,             -- same id after the move to 4155553389
  customer text,
  deposit_amount numeric,                 -- parsed from the rep's words; never invented
  finance_labels jsonb,                   -- Finance dropdown labels (balance method)
  advantage text,                         -- 'Advantage+' | 'Non Member'
  reload_labels jsonb,                    -- Reloads dropdown labels
  attempts integer NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false,
  outcome text,                           -- filled | nothing_to_fill | gave_up | error: …
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ooh_salesproc_pending_idx
  ON public.ooh_salesproc_followups (done, created_at);
GRANT ALL ON public.ooh_salesproc_followups TO service_role;
GRANT SELECT ON public.ooh_salesproc_followups TO authenticated;
ALTER TABLE public.ooh_salesproc_followups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ooh salesproc read admin" ON public.ooh_salesproc_followups;
CREATE POLICY "ooh salesproc read admin" ON public.ooh_salesproc_followups
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));
