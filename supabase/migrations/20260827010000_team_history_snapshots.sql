-- Durable van-at-the-time attribution for production history.
-- Removing someone from a van (Free Agents move or archive_agent) nulls
-- profiles.team_id, and every view that joined through the live pointer lost
-- their history (owner, 2026-08-27: "we need to see their history, we just
-- don't want them showing up every day moving forward with no data").
-- daily_logs/leads already carry write-time team_id snapshots; this closes
-- the two remaining durability gaps:
--   1) daily_metrics (the funnel/leaderboard pipeline) has NO team column —
--      van attribution was derived live from profiles.team_id, so a removed
--      member's funnel numbers had no van at all. Add a snapshot team_id,
--      stamp it on INSERT via trigger (covers every writer: the Monday edge
--      function's upsert, increment_leads_generated, and
--      claim_lead_status_transition — no writer edits, no deploy-order
--      coupling), and backfill from the daily_logs snapshots.
--   2) daily_logs.team_id / leads.team_id were ON DELETE SET NULL — deleting
--      a van silently erased which van history belonged to. They (and the
--      new daily_metrics FK) become ON DELETE RESTRICT; deleteVan in the app
--      pre-checks and explains ("rename the van instead").
-- Idempotent; apply by hand in the Supabase dashboard SQL editor.

-- 1) Snapshot column. Role-based RLS on daily_metrics already covers the new
--    column (table-level grants); REPLICA IDENTITY FULL already set.
ALTER TABLE public.daily_metrics
  ADD COLUMN IF NOT EXISTS team_id uuid;

-- Named constraint so the generated types' daily_metrics_team_id_fkey matches.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'daily_metrics_team_id_fkey'
      AND conrelid = 'public.daily_metrics'::regclass
  ) THEN
    ALTER TABLE public.daily_metrics
      ADD CONSTRAINT daily_metrics_team_id_fkey
      FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_daily_metrics_team ON public.daily_metrics (team_id);

-- 2) Write-time stamping: fill-if-null on INSERT only, so increments to an
--    existing day-row never re-home it (same invariant as office_location).
--    SECURITY DEFINER to read profiles regardless of the caller's RLS
--    (precedent: bump_daily_log_from_pin).
CREATE OR REPLACE FUNCTION public.stamp_daily_metrics_team()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.team_id IS NULL THEN
    SELECT team_id INTO NEW.team_id FROM public.profiles WHERE id = NEW.canvasser_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_daily_metrics_team() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_daily_metrics_stamp_team ON public.daily_metrics;
CREATE TRIGGER trg_daily_metrics_stamp_team
  BEFORE INSERT ON public.daily_metrics
  FOR EACH ROW EXECUTE FUNCTION public.stamp_daily_metrics_team();

-- 3) Backfill, best snapshot first. Every pass is NULL-guarded and derives
--    only from daily_logs SNAPSHOTS (never the live profiles pointer, which
--    drifts — a rerun after someone changes vans must not re-attribute their
--    unassigned-era rows). Rows that stay NULL are honest free-agent /
--    pseudo-source attribution; the app resolves those against the live van
--    at read time, exactly as before this migration.
-- 3a) Exact same-day, same-office daily_logs snapshot.
UPDATE public.daily_metrics dm
SET team_id = dl.team_id
FROM public.daily_logs dl
WHERE dm.team_id IS NULL
  AND dl.canvasser_id = dm.canvasser_id
  AND dl.log_date = dm.metric_date
  AND dl.office_location = dm.office_location
  AND dl.team_id IS NOT NULL;

-- 3b) Same-day, any office.
UPDATE public.daily_metrics dm
SET team_id = (
  SELECT dl.team_id FROM public.daily_logs dl
  WHERE dl.canvasser_id = dm.canvasser_id
    AND dl.log_date = dm.metric_date
    AND dl.team_id IS NOT NULL
  ORDER BY dl.log_date DESC
  LIMIT 1
)
WHERE dm.team_id IS NULL
  AND EXISTS (
    SELECT 1 FROM public.daily_logs dl
    WHERE dl.canvasser_id = dm.canvasser_id
      AND dl.log_date = dm.metric_date
      AND dl.team_id IS NOT NULL
  );

-- 3c) Latest snapshot on or before the metric date — "the van they were in
--     at the time", accurate to their last produced day. Confirms landing a
--     few days after submission attribute to the van they submitted from.
UPDATE public.daily_metrics dm
SET team_id = (
  SELECT dl.team_id FROM public.daily_logs dl
  WHERE dl.canvasser_id = dm.canvasser_id
    AND dl.log_date <= dm.metric_date
    AND dl.team_id IS NOT NULL
  ORDER BY dl.log_date DESC
  LIMIT 1
)
WHERE dm.team_id IS NULL
  AND EXISTS (
    SELECT 1 FROM public.daily_logs dl
    WHERE dl.canvasser_id = dm.canvasser_id
      AND dl.log_date <= dm.metric_date
      AND dl.team_id IS NOT NULL
  );

-- (No live-pointer pass on purpose: stamping NULL rows from profiles.team_id
--  would make a RERUN re-home unassigned-era production to whatever van the
--  person is on that day. Metrics-only rows with no log evidence stay NULL.)

-- 4) FK hardening: history snapshots must survive van deletion. The app's
--    deleteVan now refuses vans with production rows and says to rename
--    instead; these constraints are the DB backstop for any other writer.
--    (Snapshots already NULLed by past van deletions are unrecoverable —
--    accepted loss; those rows fall to Unassigned in the views.)
ALTER TABLE public.daily_logs DROP CONSTRAINT IF EXISTS daily_logs_team_id_fkey;
ALTER TABLE public.daily_logs
  ADD CONSTRAINT daily_logs_team_id_fkey
  FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT;

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_team_id_fkey;
ALTER TABLE public.leads
  ADD CONSTRAINT leads_team_id_fkey
  FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT;

-- profiles.team_id stays ON DELETE SET NULL on purpose: the LIVE pointer
-- should clear if a (history-free) van is deleted.
