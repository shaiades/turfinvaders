-- ═══════════════════════════════════════════════════════════════════════════
-- NIGHTLY AUTO-ISSUE at 8:45 AM PT (owner mandate 2026-10-10, rule M).
--
-- Until now, pressing Approve on the Nightly Lineup board wrote people6 to the
-- live block IMMEDIATELY. The owner wants the two phases split: a manager
-- APPROVES the night before, and a scheduled job ISSUES the approved rows to the
-- live block at 8:45 AM PT — no human (or AI chat session) has to trigger it.
--
-- This migration:
--   1. adds an 'approved' state to nightly_approvals — the gap between a
--      manager's Approve (night) and the block write (8:45). The Decision
--      webhook now marks 'approved' instead of applying; the 8:45 job applies.
--   2. adds system_settings.nightly_auto_issue_enabled (default OFF — the job
--      is dormant until an owner flips it, independent of live_dispatch_mode;
--      the actual block write is STILL gated on live_dispatch_mode='live').
--   3. schedules the job: ONE pg_cron entry, TWO DST-straddling UTC slots
--      ('45 15,16 * * *' = 15:45 + 16:45 UTC); the in-function LA-hour guard
--      lets exactly one slot through at 08:45 LA, DST-correct forever (the
--      send_daily_wrap_push model). Reuses the 'notify_secret' vault secret.
--
-- Idempotency (rule M10) is per ROW, not per run: a row goes approved→applied
-- only after its block write lands, so a job that dies partway leaves the rest
-- 'approved' for the next run (or a manual ?task=auto-issue&force=true), and
-- already-applied rows are never re-issued.
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261021120000_nightly_auto_issue.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. 'approved' state ──────────────────────────────────────────────────────
ALTER TABLE public.nightly_approvals DROP CONSTRAINT IF EXISTS nightly_approvals_state_check;
ALTER TABLE public.nightly_approvals
  ADD CONSTRAINT nightly_approvals_state_check
  CHECK (state IN ('pending', 'approved', 'applied', 'skipped', 'rejected'));

-- Fast lookup of the rows the 8:45 job issues (approved, not yet applied).
CREATE INDEX IF NOT EXISTS nightly_approvals_approved_idx
  ON public.nightly_approvals (created_at) WHERE state = 'approved';

-- ── 2. The enable switch ─────────────────────────────────────────────────────
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS nightly_auto_issue_enabled boolean NOT NULL DEFAULT false;

-- ── 3. The 8:45 AM PT cron ───────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.run_nightly_auto_issue()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _now_la timestamp;
  _enabled boolean;
  _secret text;
BEGIN
  _now_la := now() AT TIME ZONE 'America/Los_Angeles';
  -- Exactly one of the two daily UTC slots is 8 AM in LA (DST-correct).
  IF extract(hour FROM _now_la) <> 8 THEN RETURN; END IF;

  -- Dormant until an owner enables it (the edge fn re-checks this too, so a
  -- direct call without force still respects the flag).
  SELECT nightly_auto_issue_enabled INTO _enabled FROM public.system_settings LIMIT 1;
  IF NOT COALESCE(_enabled, false) THEN RETURN; END IF;

  SELECT decrypted_secret INTO _secret
  FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
  IF _secret IS NULL OR _secret = '' THEN RETURN; END IF;

  PERFORM net.http_post(
    url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/monday-ooh-report?task=auto-issue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notify-secret', _secret
    ),
    body := jsonb_build_object('task', 'auto-issue')
  );
EXCEPTION WHEN OTHERS THEN
  NULL; -- a hiccup must never surface as a cron error storm
END $$;

REVOKE ALL ON FUNCTION public.run_nightly_auto_issue() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_nightly_auto_issue() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'nightly-auto-issue') THEN
    PERFORM cron.unschedule('nightly-auto-issue');
  END IF;
  PERFORM cron.schedule(
    'nightly-auto-issue',
    '45 15,16 * * *',
    $CRON$ SELECT public.run_nightly_auto_issue(); $CRON$
  );
END $$;
