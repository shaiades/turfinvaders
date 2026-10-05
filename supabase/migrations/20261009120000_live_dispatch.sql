-- ═══════════════════════════════════════════════════════════════════════════
-- LIVE DISPATCH (Step 7 — "make Turf Invaders the instant live dispatcher").
--
-- The OOH write-back (20261008120000) already lands a rep's report on the block
-- the moment it arrives. This adds the second half: when a report frees a rep,
-- the monday-ooh-report edge function picks their next lead and hands it over
-- live (people6 ← rep, then Iss → 103, which fires Monday's own "New
-- Opportunity!" text). A scheduled sweep (?task=watchdog) alerts the managers
-- about uncovered leads nobody is free to take.
--
-- This migration adds:
--   1. system_settings.live_dispatch_mode — off | dry_run | live (default OFF,
--      so nothing auto-issues until an owner flips it; independent of
--      ooh_writeback_mode);
--   2. ooh_dispatch_decisions — every issue decision (rep, lead, score, reason,
--      mode, issued) so Shai can review and the logic can be tuned;
--   3. ooh_uncovered_alerts — one row per lead the watchdog has alerted on, so a
--      given uncovered lead is never alerted twice;
--   4. a pg_cron job that pokes the watchdog every 5 minutes (the edge function
--      self-gates the 7 AM–9 PM PT window and the off switch), reusing the
--      existing notify_secret vault secret — no new secret for the cron.
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261009120000_live_dispatch.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The live-dispatch switch ──────────────────────────────────────────────
-- off      → compute nothing, issue nothing (default; merging changes nothing);
-- dry_run  → compute the decision, log it, text "[DRY RUN] would issue …", but
--            write NOTHING to the block boards;
-- live     → write people6 + Iss on Monday (fires the rep's "New Opportunity!").
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS live_dispatch_mode text NOT NULL DEFAULT 'off';

-- ── 2. Decision audit (rep, lead, score, reason) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.ooh_dispatch_decisions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  mode text NOT NULL,                      -- 'dry_run' | 'live'
  trigger text NOT NULL,                   -- 'report' | 'watchdog'
  form_item_id text,                       -- the report that freed the rep (if any)
  rep_name text,
  office text,                             -- 'SD' | 'OC'
  board_id text,
  lead_item_id text,                       -- the lead we issued / would issue
  lead_name text,
  action text NOT NULL,                    -- 'issue' | 'manager' | 'none' | 'alert'
  score numeric,
  drive_minutes numeric,
  strength numeric,
  reason text,
  issued boolean NOT NULL DEFAULT false,   -- true only when written to Monday (live)
  candidates jsonb                         -- optional pool snapshot (for learning)
);
CREATE INDEX IF NOT EXISTS ooh_dispatch_created_idx ON public.ooh_dispatch_decisions (created_at);
CREATE INDEX IF NOT EXISTS ooh_dispatch_rep_idx ON public.ooh_dispatch_decisions (rep_name);
CREATE INDEX IF NOT EXISTS ooh_dispatch_lead_idx ON public.ooh_dispatch_decisions (lead_item_id);

GRANT ALL ON public.ooh_dispatch_decisions TO service_role;
GRANT SELECT ON public.ooh_dispatch_decisions TO authenticated;
ALTER TABLE public.ooh_dispatch_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ooh dispatch read admin" ON public.ooh_dispatch_decisions;
CREATE POLICY "ooh dispatch read admin" ON public.ooh_dispatch_decisions
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

-- Realtime so the admin review panel updates live.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.ooh_dispatch_decisions;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

-- ── 3. Watchdog alert ledger (never alert the same lead twice) ───────────────
CREATE TABLE IF NOT EXISTS public.ooh_uncovered_alerts (
  lead_item_id text PRIMARY KEY,
  office text,
  board_id text,
  alerted_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.ooh_uncovered_alerts TO service_role;
GRANT SELECT ON public.ooh_uncovered_alerts TO authenticated;
ALTER TABLE public.ooh_uncovered_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ooh uncovered read admin" ON public.ooh_uncovered_alerts;
CREATE POLICY "ooh uncovered read admin" ON public.ooh_uncovered_alerts
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

-- ── 4. The watchdog cron (every 5 min; the edge fn self-gates hours + mode) ───
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.run_ooh_watchdog()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _secret text;
BEGIN
  SELECT decrypted_secret INTO _secret
  FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
  IF _secret IS NULL OR _secret = '' THEN RETURN; END IF;

  PERFORM net.http_post(
    url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/monday-ooh-report?task=watchdog',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notify-secret', _secret
    ),
    body := jsonb_build_object('task', 'watchdog')
  );
EXCEPTION WHEN OTHERS THEN
  NULL; -- a watchdog hiccup must never surface as a cron error storm
END $$;

REVOKE ALL ON FUNCTION public.run_ooh_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_ooh_watchdog() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ooh-watchdog') THEN
    PERFORM cron.unschedule('ooh-watchdog');
  END IF;
  PERFORM cron.schedule(
    'ooh-watchdog',
    '*/5 * * * *',
    $CRON$ SELECT public.run_ooh_watchdog(); $CRON$
  );
END $$;
