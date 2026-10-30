-- ═══════════════════════════════════════════════════════════════════════════
-- NIGHTLY MORNING ISSUE at 9 PM PT (owner mandate 2026-10-30 evening):
-- "the rep gets their morning lead every evening at 9 PM the night before."
--
-- Evening timeline this sets up (all PT, DST-correct):
--   8:00 PM  nightly-approvals-build  — builds tomorrow's full-block view on
--            the approvals board (moved from 9 PM so the manager has a real
--            window to decide).
--   8:45 PM  the MANAGER approves on the board (human step, no job).
--   9:00 PM  nightly-morning-issue    — applies the approved rows (people6
--            adds), then presses Iss on each rep's FIRST lead of tomorrow,
--            which fires Monday's "New Opportunity!" ping to the rep.
-- The 8:45 AM nightly-auto-issue job stays as a catch-up for rows approved
-- overnight; it is idempotent and applies only rows still 'approved'.
--
-- SUPERSEDES 20261102120000_nightly_approvals_build.sql (safe whether or not
-- that one was applied): both functions are (re)defined and (re)scheduled
-- here. Same pattern as run_nightly_auto_issue — ONE pg_cron entry per job,
-- TWO DST-straddling UTC slots, an in-function LA-hour guard letting exactly
-- one slot through; gated on system_settings.nightly_auto_issue_enabled;
-- reuses the 'notify_secret' vault secret.
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261103120000_nightly_morning_issue.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ── 8 PM PT: build tomorrow's approvals board ────────────────────────────────
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
  -- Exactly one of the two daily UTC slots is 8 PM in LA (DST-correct).
  IF extract(hour FROM _now_la) <> 20 THEN RETURN; END IF;

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

-- ── 9 PM PT: apply approved rows + issue each rep's first morning lead ──────
CREATE OR REPLACE FUNCTION public.run_nightly_morning_issue()
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

  SELECT nightly_auto_issue_enabled INTO _enabled FROM public.system_settings LIMIT 1;
  IF NOT COALESCE(_enabled, false) THEN RETURN; END IF;

  SELECT decrypted_secret INTO _secret
  FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
  IF _secret IS NULL OR _secret = '' THEN RETURN; END IF;

  PERFORM net.http_post(
    url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/monday-ooh-report?task=morning-issue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notify-secret', _secret
    ),
    body := jsonb_build_object('task', 'morning-issue')
  );
EXCEPTION WHEN OTHERS THEN
  NULL; -- a hiccup must never surface as a cron error storm
END $$;

REVOKE ALL ON FUNCTION public.run_nightly_morning_issue() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_nightly_morning_issue() TO service_role;

-- ── Schedules ────────────────────────────────────────────────────────────────
-- 8 PM PT: PDT = 03:00 UTC, PST = 04:00 UTC. 9 PM PT: PDT = 04:00, PST = 05:00.
-- (The 04:00 UTC slot runs both jobs; each one's hour guard lets only the
-- right season through.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'nightly-approvals-build') THEN
    PERFORM cron.unschedule('nightly-approvals-build');
  END IF;
  PERFORM cron.schedule(
    'nightly-approvals-build',
    '0 3,4 * * *',
    $CRON$ SELECT public.run_nightly_approvals_build(); $CRON$
  );
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'nightly-morning-issue') THEN
    PERFORM cron.unschedule('nightly-morning-issue');
  END IF;
  PERFORM cron.schedule(
    'nightly-morning-issue',
    '0 4,5 * * *',
    $CRON$ SELECT public.run_nightly_morning_issue(); $CRON$
  );
END $$;
