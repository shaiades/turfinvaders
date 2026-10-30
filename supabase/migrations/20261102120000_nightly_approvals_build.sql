-- ═══════════════════════════════════════════════════════════════════════════
-- NIGHTLY APPROVALS AUTO-BUILD at 9 PM PT (owner mandate 2026-10-30).
--
-- The approvals chain (build rows → manager approves → 8:45 AM auto-issue)
-- only ever ran once, because step 1 was a manual adminAction nobody called:
-- on 10/30 the 8:45 job fired and found zero rows, so no morning leads were
-- issued. This job makes step 1 automatic: every night at 9 PM PT it posts
-- ?task=build-approvals, which builds TOMORROW's full-block view on the
-- "Nightly Lineup – Approvals" board (writing ONLY that board, rule H5) with
-- the engine's one self-generated proposal kind — rule I7 reset-owner adds.
-- The manager then just presses Approve (or ⚡ Approve all), and the existing
-- 8:45 AM job applies the approved rows to the live block.
--
-- Same shape as run_nightly_auto_issue: ONE pg_cron entry, TWO DST-straddling
-- UTC slots ('0 4,5 * * *' = 04:00 + 05:00 UTC); the in-function LA-hour
-- guard lets exactly one slot through at 9 PM LA, DST-correct forever. Gated
-- on the SAME system_settings.nightly_auto_issue_enabled switch — the build
-- and the apply are one chain. Reuses the 'notify_secret' vault secret.
--
-- Idempotent — safe to run more than once. Re-running the build itself is
-- also safe: rows upsert by block item id and a manager's Decision is never
-- reset on refresh.
-- Apply via: supabase db query --linked --file supabase/migrations/20261102120000_nightly_approvals_build.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.run_nightly_approvals_build()
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
  -- Exactly one of the two daily UTC slots is 9 PM in LA (DST-correct).
  IF extract(hour FROM _now_la) <> 21 THEN RETURN; END IF;

  -- One switch for the whole chain: no build while auto-issue is off (the
  -- edge fn re-checks this too, so a direct call without force still
  -- respects the flag).
  SELECT nightly_auto_issue_enabled INTO _enabled FROM public.system_settings LIMIT 1;
  IF NOT COALESCE(_enabled, false) THEN RETURN; END IF;

  SELECT decrypted_secret INTO _secret
  FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
  IF _secret IS NULL OR _secret = '' THEN RETURN; END IF;

  PERFORM net.http_post(
    url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/monday-ooh-report?task=build-approvals',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notify-secret', _secret
    ),
    body := jsonb_build_object('task', 'build-approvals')
  );
EXCEPTION WHEN OTHERS THEN
  NULL; -- a hiccup must never surface as a cron error storm
END $$;

REVOKE ALL ON FUNCTION public.run_nightly_approvals_build() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_nightly_approvals_build() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'nightly-approvals-build') THEN
    PERFORM cron.unschedule('nightly-approvals-build');
  END IF;
  PERFORM cron.schedule(
    'nightly-approvals-build',
    '0 4,5 * * *',
    $CRON$ SELECT public.run_nightly_approvals_build(); $CRON$
  );
END $$;
