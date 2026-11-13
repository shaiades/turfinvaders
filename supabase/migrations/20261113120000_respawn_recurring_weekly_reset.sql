-- ═══════════════════════════════════════════════════════════════════════════
-- RESPAWN recurring day-offs + Sunday attendance reset (owner ask 2026-11-13):
-- "reset the SD/OC Rep Attendance boards every Sunday so Respawn requests fill
-- the coming week correctly — and let reps request a REPEATING day off every
-- week (e.g. every Monday). Only the one-time requests get reset."
--
-- Two pieces:
--   1. respawn_recurring — one standing request per rep (no week_start), same
--      pending/approved/partial/denied flow + approvers as respawn_requests.
--      Approved shifts stay Off on the attendance boards across resets.
--   2. run_respawn_weekly_reset — pg_cron job at SUNDAY 12 PM PT (the existing
--      request deadline + attendance-week rollover): posts to the
--      respawn-weekly-reset edge function, which sets every shift column back
--      to On on both attendance boards, then re-marks Off from approved
--      recurring rows and the coming week's approved one-time requests.
--      Gated on system_settings.respawn_weekly_reset_enabled (default ON).
--
-- Same cron pattern as run_nightly_morning_issue: one job, two DST-straddling
-- UTC slots, an in-function LA weekday+hour guard letting exactly one through;
-- reuses the 'notify_secret' vault secret.
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261113120000_respawn_recurring_weekly_reset.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Recurring requests ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.respawn_recurring (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  rep_name text NOT NULL,                       -- profiles.display_name snapshot
  office text NOT NULL CHECK (office IN ('SD','OC')),
  shifts text[] NOT NULL DEFAULT '{}',          -- requested, e.g. {mon_am,mon_pm}
  approved_shifts text[],                       -- granted subset (NULL = undecided)
  reason text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','partial')),
  decided_by uuid REFERENCES auth.users(id),
  decided_at timestamptz,
  decision_note text,
  monday_item_id text,                          -- the Day-Off board item id
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)                              -- one standing request per rep
);

CREATE INDEX IF NOT EXISTS respawn_recurring_status_idx ON public.respawn_recurring (status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.respawn_recurring TO authenticated;
GRANT ALL ON public.respawn_recurring TO service_role;
ALTER TABLE public.respawn_recurring ENABLE ROW LEVEL SECURITY;

-- Policies mirror respawn_requests: rep sees/edits own pending; approvers all.
DROP POLICY IF EXISTS "respawn_recurring read own or admin" ON public.respawn_recurring;
CREATE POLICY "respawn_recurring read own or admin" ON public.respawn_recurring
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
  );

DROP POLICY IF EXISTS "respawn_recurring insert own pending" ON public.respawn_recurring;
CREATE POLICY "respawn_recurring insert own pending" ON public.respawn_recurring
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND status = 'pending'
    AND decided_by IS NULL
    AND decided_at IS NULL
  );

DROP POLICY IF EXISTS "respawn_recurring update own pending" ON public.respawn_recurring;
CREATE POLICY "respawn_recurring update own pending" ON public.respawn_recurring
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND status = 'pending')
  WITH CHECK (user_id = auth.uid() AND status = 'pending');

DROP POLICY IF EXISTS "respawn_recurring update admin" ON public.respawn_recurring;
CREATE POLICY "respawn_recurring update admin" ON public.respawn_recurring
  FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
  );

DROP POLICY IF EXISTS "respawn_recurring delete own pending or admin" ON public.respawn_recurring;
CREATE POLICY "respawn_recurring delete own pending or admin" ON public.respawn_recurring
  FOR DELETE TO authenticated
  USING (
    (user_id = auth.uid() AND status = 'pending')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
  );

DROP TRIGGER IF EXISTS respawn_recurring_touch ON public.respawn_recurring;
CREATE TRIGGER respawn_recurring_touch
  BEFORE UPDATE ON public.respawn_recurring
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.respawn_recurring;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
ALTER TABLE public.respawn_recurring REPLICA IDENTITY FULL;

-- ── 2. Weekly reset flag + cron ──────────────────────────────────────────────

ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS respawn_weekly_reset_enabled boolean NOT NULL DEFAULT true;

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.run_respawn_weekly_reset()
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
  -- Exactly one of the two weekly UTC slots is Sunday 12 PM in LA (DST-correct).
  IF extract(dow FROM _now_la) <> 0 OR extract(hour FROM _now_la) <> 12 THEN RETURN; END IF;

  SELECT respawn_weekly_reset_enabled INTO _enabled FROM public.system_settings LIMIT 1;
  IF NOT COALESCE(_enabled, false) THEN RETURN; END IF;

  SELECT decrypted_secret INTO _secret
  FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
  IF _secret IS NULL OR _secret = '' THEN RETURN; END IF;

  PERFORM net.http_post(
    url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/respawn-weekly-reset',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notify-secret', _secret
    ),
    body := '{}'::jsonb
  );
EXCEPTION WHEN OTHERS THEN
  NULL; -- a hiccup must never surface as a cron error storm
END $$;

REVOKE ALL ON FUNCTION public.run_respawn_weekly_reset() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_respawn_weekly_reset() TO service_role;

-- Sunday 12 PM PT: PDT = Sun 19:00 UTC, PST = Sun 20:00 UTC. Run at :05 so the
-- hour guard (= 12) is safely inside the hour; the off-season slot no-ops.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'respawn-weekly-reset') THEN
    PERFORM cron.unschedule('respawn-weekly-reset');
  END IF;
  PERFORM cron.schedule(
    'respawn-weekly-reset',
    '5 19,20 * * 0',
    $CRON$ SELECT public.run_respawn_weekly_reset(); $CRON$
  );
END $$;
