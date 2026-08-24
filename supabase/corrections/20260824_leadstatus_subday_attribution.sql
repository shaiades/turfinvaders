-- Lead Status funnel: re-attribute Confirmed / Future / Blowout / N/A /
-- Pending counters to the day the lead was SUBMITTED (Jorge Najera,
-- 2026-08-24). The old edge function stamped every flip on the webhook
-- receipt day, so leads that sat over the weekend counted on Monday.
--
-- Run in the xogit (xogitpqeuwalerxygvjw) SQL editor AFTER (1) applying
-- migration 20260824130000_lead_status_claim.sql and (2) deploying the
-- updated monday-live-dispatch edge function — its markers carry flipDate
-- and are excluded here, so deploy-then-backfill ordering is safe. The
-- advisory locks below share the deployed claim RPC's key, so a live flip
-- for an affected pulse blocks until this transaction commits instead of
-- interleaving with the re-bucketing.
-- To DRY-RUN: change the final COMMIT to ROLLBACK; the summary SELECT just
-- above it prints what would move either way.
--
-- Everything is DERIVED from the Lead_Status_Processed markers (which have
-- carried metric_date — the day their +1 landed — since 2026-07-27) plus the
-- Lead_Generated_Processed / Lead_Generated_Credited submission markers.
-- Part A moves each pulse's currently-counted bucket (latest marker) from
-- its receipt day to its submission day. Part B clears strands the old code
-- left behind: a cross-day transition decremented the NEW day's row (where
-- the count wasn't — floored to zero) and left the original +1 in place.
-- Moved markers are re-stamped (subdayAttributed + flipDate) and cleared
-- strands flagged (strandedCleared) in the same transaction, so re-running
-- this script is a no-op and future flips decrement the day the counter
-- actually sits on.
--
-- Canvasser resolution: merge_canvassers repoints daily_metrics rows to the
-- keeper but markers keep the loser's id. Archived losers carry merged_into
-- (chains pre-collapsed to the final keeper) and are remapped; hard-deleted
-- losers are unresolvable and skipped (counted in the summary).

BEGIN;

-- ── Serialize against live flips ───────────────────────────────────────────
-- Same lock key as claim_lead_status_transition; taken in sorted order
-- BEFORE the snapshot so a concurrent flip either committed already (and is
-- in the snapshot) or waits for our COMMIT. The edge function only ever
-- holds one of these at a time, so no deadlock is possible.
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT DISTINCT data ->> 'pulseId' AS pulse_id
    FROM public.webhook_logs
    WHERE step = 'Lead_Status_Processed' AND data ->> 'pulseId' IS NOT NULL
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('lead_status:' || p.pulse_id, 0));
  END LOOP;
END $$;

-- ── Snapshot every Lead Status marker (pre-restamp view) ───────────────────
CREATE TEMP TABLE _ls ON COMMIT DROP AS
SELECT wl.id AS marker_id,
       wl.created_at,
       wl.data ->> 'pulseId' AS pulse_id,
       (wl.data ->> 'canvasser_id')::uuid AS canvasser_id,
       wl.data ->> 'office' AS office,
       wl.data ->> 'recordedAs' AS bucket,
       wl.data ->> 'undid' AS undid,
       COALESCE((wl.data ->> 'metric_date')::date,
                (wl.created_at AT TIME ZONE 'America/Los_Angeles')::date) AS mdate,
       (wl.data ? 'flipDate' OR wl.data ? 'subdayAttributed') AS new_era,
       (wl.data ? 'strandedCleared') AS cleared,
       ROW_NUMBER() OVER (PARTITION BY wl.data ->> 'pulseId'
                          ORDER BY wl.created_at ASC,  wl.id ASC)  AS rn_asc,
       ROW_NUMBER() OVER (PARTITION BY wl.data ->> 'pulseId'
                          ORDER BY wl.created_at DESC, wl.id DESC) AS rn_desc
FROM public.webhook_logs wl
WHERE wl.step = 'Lead_Status_Processed'
  AND wl.data ->> 'pulseId' IS NOT NULL;

-- ── Submission day per pulse ───────────────────────────────────────────────
-- Lead_Generated_Processed carries the credited metric_date; the Credited
-- claim (unique per pulse) dates by its receipt instant when Processed was
-- never written (crash window).
CREATE TEMP TABLE _sub ON COMMIT DROP AS
SELECT pulse_id, COALESCE(MIN(pd), MIN(cd)) AS sub_date
FROM (
  SELECT wl.data ->> 'pulseId' AS pulse_id,
         COALESCE((wl.data ->> 'metric_date')::date,
                  (wl.created_at AT TIME ZONE 'America/Los_Angeles')::date) AS pd,
         NULL::date AS cd
  FROM public.webhook_logs wl
  WHERE wl.step = 'Lead_Generated_Processed' AND wl.data ->> 'pulseId' IS NOT NULL
  UNION ALL
  SELECT wl.data ->> 'pulseId', NULL,
         (wl.created_at AT TIME ZONE 'America/Los_Angeles')::date
  FROM public.webhook_logs wl
  WHERE wl.step = 'Lead_Generated_Credited' AND wl.data ->> 'pulseId' IS NOT NULL
) s
GROUP BY pulse_id;

-- ── Part A: move the currently-counted bucket to the submission day ────────
-- Latest old-era marker per pulse; target = submission day, else the day the
-- pulse FIRST counted (pre-pipeline/recycled cards stay pinned where they
-- landed — single-marker pulses with no gen markers are no-ops by design,
-- mirroring the live attribution chain).
CREATE TEMP TABLE _moves ON COMMIT DROP AS
SELECT l.marker_id, l.pulse_id,
       COALESCE(p.merged_into, p.id) AS canvasser_id,
       l.office, l.bucket,
       l.mdate AS from_date,
       COALESCE(s.sub_date, e.mdate) AS to_date
FROM _ls l
JOIN _ls e ON e.pulse_id = l.pulse_id AND e.rn_asc = 1
LEFT JOIN _sub s ON s.pulse_id = l.pulse_id
JOIN public.profiles p ON p.id = l.canvasser_id
WHERE l.rn_desc = 1
  AND NOT l.new_era
  AND l.bucket IS NOT NULL
  AND COALESCE(s.sub_date, e.mdate) IS DISTINCT FROM l.mdate;

-- ── Part B: clear stranded +1s from old-era cross-day transitions ──────────
-- A non-latest marker whose old-era successor sits on a different day and
-- provably undid this bucket (nxt.undid = bucket): the live decrement hit
-- the successor's day and floored, leaving this day's +1 in place. New-era
-- successors already decremented the right day; markers already cleared are
-- skipped on re-runs.
CREATE TEMP TABLE _stranded ON COMMIT DROP AS
SELECT l.marker_id,
       COALESCE(p.merged_into, p.id) AS canvasser_id,
       l.office, l.bucket, l.mdate AS day
FROM _ls l
JOIN _ls nxt ON nxt.pulse_id = l.pulse_id AND nxt.rn_asc = l.rn_asc + 1
JOIN public.profiles p ON p.id = l.canvasser_id
WHERE l.bucket IS NOT NULL
  AND NOT l.cleared
  AND NOT nxt.new_era
  AND nxt.mdate IS DISTINCT FROM l.mdate
  AND nxt.undid = l.bucket;

-- ── Deltas per (canvasser, day) ────────────────────────────────────────────
-- Grouped by canvasser+day ONLY (office would split one daily_metrics row
-- into two delta rows, and UPDATE..FROM would apply just one). Office is
-- only a guess for seeding brand-new rows; existing rows are never re-homed.
CREATE TEMP TABLE _delta ON COMMIT DROP AS
SELECT canvasser_id, day, MAX(office) AS office,
       SUM(((bucket = 'leads_confirmed')::int) * sgn) AS leads_confirmed,
       SUM(((bucket = 'no_answers')::int)      * sgn) AS no_answers,
       SUM(((bucket = 'killed')::int)          * sgn) AS killed,
       SUM(((bucket = 'pending')::int)         * sgn) AS pending,
       SUM(((bucket = 'future')::int)          * sgn) AS future
FROM (
  SELECT canvasser_id, office, from_date AS day, bucket, -1 AS sgn FROM _moves
  UNION ALL
  SELECT canvasser_id, office, to_date,          bucket, +1        FROM _moves
  UNION ALL
  SELECT canvasser_id, office, day,              bucket, -1        FROM _stranded
) x
GROUP BY canvasser_id, day;

-- Seed rows only where a positive delta needs somewhere to land; negative-
-- only days without a row have nothing to decrement (the live floor already
-- swallowed it).
INSERT INTO public.daily_metrics
  (canvasser_id, metric_date, office_location,
   leads_confirmed, no_answers, killed, pending, future)
SELECT d.canvasser_id, d.day, COALESCE(d.office, 'San Diego'), 0, 0, 0, 0, 0
FROM _delta d
WHERE d.leads_confirmed > 0 OR d.no_answers > 0 OR d.killed > 0
   OR d.pending > 0 OR d.future > 0
ON CONFLICT (canvasser_id, metric_date) DO NOTHING;

UPDATE public.daily_metrics dm SET
  leads_confirmed = GREATEST(0, dm.leads_confirmed + d.leads_confirmed),
  no_answers      = GREATEST(0, dm.no_answers      + d.no_answers),
  killed          = GREATEST(0, dm.killed          + d.killed),
  pending         = GREATEST(0, dm.pending         + d.pending),
  future          = GREATEST(0, dm.future          + d.future)
FROM _delta d
WHERE dm.canvasser_id = d.canvasser_id AND dm.metric_date = d.day;

-- ── Re-stamp markers (also the re-run guards) ──────────────────────────────
-- metric_date keeps its invariant — the day this pulse's +1 now sits on —
-- so the deployed edge function decrements the right row on the next flip.
-- flipDate records the original receipt day, matching new-marker semantics.
UPDATE public.webhook_logs wl
SET data = jsonb_set(wl.data, '{metric_date}', to_jsonb(m.to_date::text))
        || jsonb_build_object('subdayAttributed', true, 'flipDate', m.from_date::text)
FROM _moves m
WHERE wl.id = m.marker_id;

UPDATE public.webhook_logs wl
SET data = wl.data || '{"strandedCleared": true}'::jsonb
FROM _stranded s
WHERE wl.id = s.marker_id;

-- ── Summary (visible in dry-run and apply alike) ───────────────────────────
SELECT
  (SELECT count(*) FROM _moves)    AS moved_to_submission_day,
  (SELECT count(*) FROM _stranded) AS strands_cleared,
  (SELECT count(*) FROM _ls l
     WHERE l.rn_desc = 1 AND NOT l.new_era AND l.bucket IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = l.canvasser_id))
                                   AS skipped_deleted_profile,
  (SELECT count(DISTINCT pulse_id) FROM _ls) AS pulses_seen;

COMMIT;

-- ── Reconciliation (run separately, before and after) ──────────────────────
-- Expected-from-markers vs actual daily_metrics, per day. After the backfill
-- the two should match day-for-day; residuals are floored decrements the old
-- code burned against other pulses (already short before this script ran).
--
-- WITH cur AS (
--   SELECT DISTINCT ON (data ->> 'pulseId')
--          (data ->> 'metric_date')::date AS day,
--          data ->> 'recordedAs' AS bucket
--   FROM public.webhook_logs
--   WHERE step = 'Lead_Status_Processed'
--   ORDER BY data ->> 'pulseId', created_at DESC)
-- SELECT day,
--        SUM((bucket = 'leads_confirmed')::int) AS con,
--        SUM((bucket = 'future')::int)          AS fut,
--        SUM((bucket = 'killed')::int)          AS kil,
--        SUM((bucket = 'no_answers')::int)      AS na,
--        SUM((bucket = 'pending')::int)         AS pen
-- FROM cur WHERE bucket IS NOT NULL GROUP BY 1 ORDER BY 1;
--
-- SELECT metric_date, SUM(leads_confirmed) AS con, SUM(future) AS fut,
--        SUM(killed) AS kil, SUM(no_answers) AS na, SUM(pending) AS pen
-- FROM public.daily_metrics
-- WHERE metric_date >= '2026-07-27'
-- GROUP BY 1 ORDER BY 1;
