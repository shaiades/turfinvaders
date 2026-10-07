-- Per-lead van attribution (owner, 2026-07-31): Fleet Dispatch bucketed a
-- rep's ENTIRE funnel under profiles.team_id — one scalar per rep, overwritten
-- by whichever Monday card fired most recently. A setter whose cards all name
-- Miguel's van could be dragged onto Logan's van by a single stray card, and
-- every lead they had ever generated moved with them.
--
-- Monday's Van column is authoritative PER CARD, so the van belongs on the
-- production row, not on the profile. daily_logs and leads already carry
-- team_id this way; daily_metrics was the one counter table that did not.
-- profiles.team_id keeps its job (roster / van membership / RLS captain
-- scoping) but no longer decides where a lead is counted.

ALTER TABLE public.daily_metrics
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL;

-- Backfill, best source first. profiles.team_id is deliberately the LAST
-- resort: it is the stale scalar this migration exists to stop trusting, and
-- seeding history from it would bake in exactly the mis-attribution being
-- fixed (Ernie Ruiz's week of 2026-07-20 has ten daily_logs rows and three
-- leads rows all stamped Miguel, while his profile currently reads Logan).
--   1) the van on that rep's daily_logs row for the same day — written by the
--      webhook from the card at the time, so it reflects the Van column then
--   2) the van on a lead they closed that day, same provenance
--   3) the rep's current van, for days with no production rows at all
UPDATE public.daily_metrics dm
SET team_id = COALESCE(
  (
    SELECT dl.team_id FROM public.daily_logs dl
    WHERE dl.canvasser_id = dm.canvasser_id
      AND dl.log_date = dm.metric_date
      AND dl.team_id IS NOT NULL
    ORDER BY dl.office_location
    LIMIT 1
  ),
  (
    SELECT l.team_id FROM public.leads l
    WHERE l.canvasser_id = dm.canvasser_id
      AND (COALESCE(l.reviewed_at, l.created_at) AT TIME ZONE 'America/Los_Angeles')::date = dm.metric_date
      AND l.team_id IS NOT NULL
    LIMIT 1
  ),
  p.team_id
)
FROM public.profiles p
WHERE p.id = dm.canvasser_id
  AND dm.team_id IS NULL;

-- The grain is now (canvasser, day, van): one rep who produced for two vans in
-- a day keeps two rows. NULLS NOT DISTINCT so the unassigned rows — pseudo
-- lead sources (referral, Self Gen…) and cards with no Van value — still
-- collapse to a single row per canvasser per day instead of multiplying on
-- every upsert. Requires PostgreSQL 15+ — fail with a readable message rather
-- than a syntax error if this ever runs somewhere older.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'daily_metrics van grain needs PostgreSQL 15+ for NULLS NOT DISTINCT; this server is %', version();
  END IF;
END $$;

DROP INDEX IF EXISTS public.daily_metrics_canvasser_date_uniq;
ALTER TABLE public.daily_metrics
  DROP CONSTRAINT IF EXISTS daily_metrics_canvasser_id_metric_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS daily_metrics_canvasser_date_van_uniq
  ON public.daily_metrics (canvasser_id, metric_date, team_id) NULLS NOT DISTINCT;

-- Van rollups (Fleet Dispatch van cards, captain cross-van cards) scan by van
-- and date, not by canvasser.
CREATE INDEX IF NOT EXISTS idx_daily_metrics_team_date
  ON public.daily_metrics (team_id, metric_date);

-- Atomic leads-generated increment, now van-aware. The old 3-arg signature is
-- dropped rather than kept alongside: a DEFAULT on the new 4th argument would
-- make a 3-arg call ambiguous between the two overloads.
DROP FUNCTION IF EXISTS public.increment_leads_generated(uuid, date, text);

CREATE OR REPLACE FUNCTION public.increment_leads_generated(
  _canvasser_id uuid,
  _metric_date date,
  _office text,
  _team_id uuid
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.daily_metrics (canvasser_id, metric_date, office_location, team_id, leads_generated)
  VALUES (_canvasser_id, _metric_date, COALESCE(_office, 'San Diego'), _team_id, 1)
  ON CONFLICT (canvasser_id, metric_date, team_id)
  DO UPDATE SET leads_generated = public.daily_metrics.leads_generated + 1;
$$;

REVOKE ALL ON FUNCTION public.increment_leads_generated(uuid, date, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_leads_generated(uuid, date, text, uuid) TO service_role;
