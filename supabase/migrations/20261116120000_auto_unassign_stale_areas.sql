-- ═══════════════════════════════════════════════════════════════════════════
-- AUTO-UNASSIGN STALE AREAS (owner ask 2026-11-16): "automatically remove
-- areas that haven't been hit in over 3 weeks, so I know we can visit them
-- again. What I mean by remove, you just unassign the area."
--
-- Daily sweep: any turf still assigned whose current assignment started more
-- than 21 days ago is set back to Unassigned. The area itself is never
-- deleted, and turf_assignment_history is untouched (the log_turf_assignment
-- trigger only writes rows when an assignee is SET, not cleared), so
-- "Assignment history" still shows everyone who ever worked the ground.
--
-- "Hasn't been hit" = the assignment's age (same staleness clock as the
-- map's old-area toggle, src/lib/turf-age.ts): assigned_at is stamped by
-- turfs_stamp_assignment on every assignee change, so it is the start of the
-- CURRENT assignment; re-assigning an area any time in the last 3 weeks
-- keeps it. On the sweep's unassign that same trigger re-stamps
-- assigned_at = now() and keeps assigned_by, so the freed area shows as
-- fresh "Unassigned" (dashed gray) on the manager map for the next month
-- rather than hiding behind the old-areas toggle — visible = claimable.
--
-- Gated on system_settings.auto_unassign_stale_areas_enabled (default ON —
-- applying this migration IS the owner turning the feature on; flip the flag
-- to pause the sweep without unscheduling it).
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261116120000_auto_unassign_stale_areas.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_cron;

ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS auto_unassign_stale_areas_enabled boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.run_auto_unassign_stale_areas()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _enabled boolean;
BEGIN
  SELECT auto_unassign_stale_areas_enabled INTO _enabled
  FROM public.system_settings LIMIT 1;
  IF NOT COALESCE(_enabled, false) THEN RETURN; END IF;

  -- COALESCE to created_at mirrors turf-age.ts; a turf with neither date is
  -- left alone (bad data must never silently strip an assignment).
  -- '#8a8f99' = UNASSIGNED_COLOR (src/lib/assignee-colors.ts), matching what
  -- the Area Details sheet writes on a manual "Set as unassigned".
  UPDATE public.turfs
  SET assigned_user_id = NULL,
      color = '#8a8f99'
  WHERE assigned_user_id IS NOT NULL
    AND COALESCE(assigned_at, created_at) < now() - interval '21 days';
EXCEPTION WHEN OTHERS THEN
  NULL; -- a hiccup must never surface as a cron error storm
END $$;

REVOKE ALL ON FUNCTION public.run_auto_unassign_stale_areas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_auto_unassign_stale_areas() TO service_role;

-- Daily at 11:00 UTC (3 AM PST / 4 AM PDT — before any canvassing day
-- starts; the exact local hour doesn't matter for a staleness sweep, so no
-- DST dual-slot guard is needed).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-unassign-stale-areas') THEN
    PERFORM cron.unschedule('auto-unassign-stale-areas');
  END IF;
  PERFORM cron.schedule(
    'auto-unassign-stale-areas',
    '0 11 * * *',
    $CRON$ SELECT public.run_auto_unassign_stale_areas(); $CRON$
  );
END $$;
