-- Week of 8/3/26 day-move: put replayed outcomes on the day they happened.
--
-- Run in the xogit (xogitpqeuwalerxygvjw) SQL editor AFTER
-- scripts/replay-block-cards.mjs has restored the week's outcomes. The
-- replay pushes every card through the live edge function, which stamps
-- counters on the day the replay RUNS — so outcomes the crews marked on
-- Monday 8/3 land on the replay day instead. This script re-dates them.
--
-- The true day per card is its board group ("Monday" / "Tuesday" on
-- "SD Block 8/3/26-8/8/26" / "OC Block 8/3/26 - 8/8/26") — the appointment
-- day the daily-wrap audits reconcile against; the crews mark results the
-- same evening. Only cards that already carried a result when the boards
-- were audited (Tue 8/4 ~2pm PT) are listed — cards marked later arrive via
-- live webhooks stamped on their real day and need no correction.
--
-- Everything is DERIVED from the webhook_logs markers the replay wrote
-- (bucket, canvasser, office, day counted), and each moved marker is
-- re-stamped with the true day in the same transaction — so re-running this
-- script is a no-op, and a future outcome flip/revert on a moved card
-- decrements the day the counter actually sits on.

BEGIN;

-- ── The cards and the day each truly happened ──────────────────────────────
CREATE TEMP TABLE _true_day (pulse_id text PRIMARY KEY, true_date date NOT NULL)
ON COMMIT DROP;
INSERT INTO _true_day VALUES
  -- OC Block 8/3/26 - 8/8/26 (18424812732), Monday group
  ('12704553122', '2026-08-03'), -- Blowout · Ryan
  ('12705591238', '2026-08-03'), -- Blowout · Ryan
  ('12704602081', '2026-08-03'), -- Reset · Logan Temple
  ('12705750245', '2026-08-03'), -- Sit · Stephen Tonkin
  ('12708293342', '2026-08-03'), -- Blowout · Levon Gukasyan
  ('12704346347', '2026-08-03'), -- Blowout · Logan Temple
  ('12708323022', '2026-08-03'), -- Sale $49,295 · Stephen Tonkin
  ('12706709680', '2026-08-03'), -- Sit · Logan Temple
  ('12706456910', '2026-08-03'), -- Blowout · Logan Temple
  ('12707623616', '2026-08-03'), -- Blowout · Logan Temple
  ('12707055533', '2026-08-03'), -- Blowout · Stephen Tonkin
  ('12707852044', '2026-08-03'), -- Blowout · Levon Gukasyan
  ('12705761325', '2026-08-03'), -- Reload $2,665 · Agent blank on the board
  -- OC Tuesday group
  ('12706113711', '2026-08-04'), -- CTC · Tony Aguilar
  ('12718386381', '2026-08-04'), -- Blowout · John Porzio
  ('12718468145', '2026-08-04'), -- Blowout · Logan Temple
  ('12717147545', '2026-08-04'), -- CTC · Stephen Tonkin
  -- SD Block 8/3/26-8/8/26 (18424812198), Monday group
  ('12708527960', '2026-08-03'), -- Sit · Ernie Ruiz
  ('12707478688', '2026-08-03'), -- Blowout · Miguel Munoz
  ('12708329501', '2026-08-03'), -- Sit · Eric Iriqui
  ('12704460640', '2026-08-03'), -- Reset · Ernie Ruiz
  ('12705509131', '2026-08-03'), -- Sale $25,000 · Bobby Orellano
  ('12708389009', '2026-08-03'), -- Sit · Eric Iriqui
  ('12708843130', '2026-08-03'), -- Sit · Miguel Munoz
  ('12705104105', '2026-08-03'), -- Reset · Ethan Munoz
  ('12708842936', '2026-08-03'), -- Blowout · Ethan Munoz
  ('12705688896', '2026-08-03'), -- Sit · Bobby Orellano
  ('12706395039', '2026-08-03'), -- Sale $23,191 · Miguel Munoz
  ('12707820675', '2026-08-03'), -- Blowout · Marcel
  ('12707809887', '2026-08-03'), -- Blowout · Nate Hernandez
  -- SD Tuesday group
  ('12705216542', '2026-08-04'), -- CTC · Ernie Ruiz
  ('12717223745', '2026-08-04'), -- CTC · Ernie Ruiz
  ('12717570876', '2026-08-04'); -- CTC · Ian Ryan

-- ── Outcomes counted on the wrong day ──────────────────────────────────────
-- Latest Card_Outcome_Recorded per card (an outcome flip after the replay
-- supersedes the replay's marker — its counter transition already targeted
-- the marker day, so only the latest state's day needs moving). A pulse is
-- moved at most ONCE ever: the patch below stamps `daymoved` on the marker,
-- and any pulse carrying that stamp is skipped — so outcome flips that
-- happen after this script has run keep their own (live) day.
CREATE TEMP TABLE _latest ON COMMIT DROP AS
SELECT DISTINCT ON (wl.data ->> 'pulseId')
       wl.id AS marker_id,
       wl.data ->> 'pulseId' AS pulse_id,
       (wl.data ->> 'canvasser_id')::uuid AS canvasser_id,
       wl.data ->> 'office_location' AS office_location,
       wl.data ->> 'bucket' AS bucket,
       COALESCE((wl.data ->> 'nonCore')::boolean, false) AS non_core,
       (wl.data ->> 'metric_date')::date AS from_date,
       td.true_date
FROM public.webhook_logs wl
JOIN _true_day td ON td.pulse_id = wl.data ->> 'pulseId'
WHERE wl.step = 'Card_Outcome_Recorded'
ORDER BY wl.data ->> 'pulseId', wl.created_at DESC;

CREATE TEMP TABLE _moves ON COMMIT DROP AS
SELECT l.*
FROM _latest l
WHERE l.from_date IS DISTINCT FROM l.true_date
  AND NOT EXISTS (
    SELECT 1 FROM public.webhook_logs w2
    WHERE w2.step = 'Card_Outcome_Recorded'
      AND w2.data ->> 'pulseId' = l.pulse_id
      AND w2.data ? 'daymoved'
  );

-- ── New-lead credits that rode in with the replay ──────────────────────────
-- Lead_Credit_Applied carries no metric_date of its own (the counter lands on
-- the processing day); stamping true_date onto the marker below is also the
-- re-run guard.
CREATE TEMP TABLE _credit_moves ON COMMIT DROP AS
SELECT wl.id AS marker_id,
       (wl.data ->> 'canvasser_id')::uuid AS canvasser_id,
       l.office_location,
       ((wl.created_at AT TIME ZONE 'America/Los_Angeles')::date) AS from_date,
       td.true_date
FROM public.webhook_logs wl
JOIN _true_day td ON td.pulse_id = wl.data ->> 'pulseId'
JOIN _latest l ON l.pulse_id = wl.data ->> 'pulseId'
WHERE wl.step = 'Lead_Credit_Applied'
  AND NOT (wl.data ? 'metric_date')
  AND ((wl.created_at AT TIME ZONE 'America/Los_Angeles')::date)
      IS DISTINCT FROM td.true_date;

-- ── daily_logs (payroll + Weekly Results feed) ─────────────────────────────
-- Bucket → counter vector, exactly the edge function's DAILY_LOG_VECS.
CREATE TEMP TABLE _log_delta ON COMMIT DROP AS
SELECT canvasser_id, office_location, day, SUM(sits) AS sits, SUM(sales) AS sales,
       SUM(no_demo) AS no_demo, SUM(future_leads) AS future_leads, SUM(ctc) AS ctc,
       SUM(non_core) AS non_core, SUM(called_in) AS called_in
FROM (
  SELECT canvasser_id, office_location, from_date AS day,
         -(CASE WHEN bucket IN ('sit','sales') THEN 1 ELSE 0 END) AS sits,
         -(CASE WHEN bucket = 'sales' THEN 1 ELSE 0 END) AS sales,
         -(CASE WHEN bucket = 'blowouts' THEN 1 ELSE 0 END) AS no_demo,
         -(CASE WHEN bucket = 'resets' THEN 1 ELSE 0 END) AS future_leads,
         -(CASE WHEN bucket = 'ctc' THEN 1 ELSE 0 END) AS ctc,
         -(CASE WHEN non_core THEN 1 ELSE 0 END) AS non_core,
         0 AS called_in
  FROM _moves
  UNION ALL
  SELECT canvasser_id, office_location, true_date,
         CASE WHEN bucket IN ('sit','sales') THEN 1 ELSE 0 END,
         CASE WHEN bucket = 'sales' THEN 1 ELSE 0 END,
         CASE WHEN bucket = 'blowouts' THEN 1 ELSE 0 END,
         CASE WHEN bucket = 'resets' THEN 1 ELSE 0 END,
         CASE WHEN bucket = 'ctc' THEN 1 ELSE 0 END,
         CASE WHEN non_core THEN 1 ELSE 0 END,
         0
  FROM _moves
  UNION ALL
  SELECT canvasser_id, office_location, from_date, 0, 0, 0, 0, 0, 0, -1 FROM _credit_moves
  UNION ALL
  SELECT canvasser_id, office_location, true_date, 0, 0, 0, 0, 0, 0, 1 FROM _credit_moves
) x
GROUP BY canvasser_id, office_location, day;

INSERT INTO public.daily_logs
  (canvasser_id, team_id, log_date, office_location,
   demos_sits, sales, no_demo, future_leads, ctc, non_core, leads_called_in)
SELECT d.canvasser_id, p.team_id, d.day, d.office_location, 0, 0, 0, 0, 0, 0, 0
FROM _log_delta d
JOIN public.profiles p ON p.id = d.canvasser_id
ON CONFLICT (canvasser_id, log_date, office_location) DO NOTHING;

UPDATE public.daily_logs dl SET
  demos_sits      = GREATEST(0, dl.demos_sits + d.sits),
  sales           = GREATEST(0, dl.sales + d.sales),
  no_demo         = GREATEST(0, dl.no_demo + d.no_demo),
  future_leads    = GREATEST(0, dl.future_leads + d.future_leads),
  ctc             = GREATEST(0, dl.ctc + d.ctc),
  non_core        = GREATEST(0, dl.non_core + d.non_core),
  leads_called_in = GREATEST(0, dl.leads_called_in + d.called_in)
FROM _log_delta d
WHERE dl.canvasser_id = d.canvasser_id
  AND dl.log_date = d.day
  AND dl.office_location = d.office_location;

-- ── daily_metrics (dispatch day tiles) ─────────────────────────────────────
-- Bucket → column, exactly the edge function's METRIC_COL (Sit lives in
-- pitch_missed; CTC has no daily_metrics mirror), plus leads_submitted from
-- the credits.
CREATE TEMP TABLE _metric_delta ON COMMIT DROP AS
SELECT canvasser_id, office_location, day, SUM(pm) AS pm, SUM(sales) AS sales,
       SUM(resets) AS resets, SUM(blowouts) AS blowouts, SUM(submitted) AS submitted
FROM (
  SELECT canvasser_id, office_location, from_date AS day,
         -(CASE WHEN bucket = 'sit' THEN 1 ELSE 0 END) AS pm,
         -(CASE WHEN bucket = 'sales' THEN 1 ELSE 0 END) AS sales,
         -(CASE WHEN bucket = 'resets' THEN 1 ELSE 0 END) AS resets,
         -(CASE WHEN bucket = 'blowouts' THEN 1 ELSE 0 END) AS blowouts,
         0 AS submitted
  FROM _moves
  UNION ALL
  SELECT canvasser_id, office_location, true_date,
         CASE WHEN bucket = 'sit' THEN 1 ELSE 0 END,
         CASE WHEN bucket = 'sales' THEN 1 ELSE 0 END,
         CASE WHEN bucket = 'resets' THEN 1 ELSE 0 END,
         CASE WHEN bucket = 'blowouts' THEN 1 ELSE 0 END,
         0
  FROM _moves
  UNION ALL
  SELECT canvasser_id, office_location, from_date, 0, 0, 0, 0, -1 FROM _credit_moves
  UNION ALL
  SELECT canvasser_id, office_location, true_date, 0, 0, 0, 0, 1 FROM _credit_moves
) x
GROUP BY canvasser_id, office_location, day;

INSERT INTO public.daily_metrics
  (canvasser_id, metric_date, office_location,
   pitch_missed, sales, resets, blowouts, leads_submitted)
SELECT d.canvasser_id, d.day, d.office_location, 0, 0, 0, 0, 0
FROM _metric_delta d
ON CONFLICT (canvasser_id, metric_date) DO NOTHING;

UPDATE public.daily_metrics dm SET
  pitch_missed    = GREATEST(0, dm.pitch_missed + d.pm),
  sales           = GREATEST(0, dm.sales + d.sales),
  resets          = GREATEST(0, dm.resets + d.resets),
  blowouts        = GREATEST(0, dm.blowouts + d.blowouts),
  leads_submitted = GREATEST(0, dm.leads_submitted + d.submitted)
FROM _metric_delta d
WHERE dm.canvasser_id = d.canvasser_id
  AND dm.metric_date = d.day;

-- ── Sale leads: pin commissions to the sale day ────────────────────────────
-- The replay pins created_at/reviewed_at to ~noon PT of the replay day; the
-- three Monday sales (and the agent-less Reload, once its Agent is filled and
-- it replays) belong on 8/3. Same Mon–Sun pay week either way; this squares
-- the day view. Only rows the replay itself created can match the guard.
UPDATE public.leads
SET created_at = '2026-08-03T20:00:00Z', reviewed_at = '2026-08-03T20:00:00Z'
WHERE monday_item_id IN ('12708323022', '12705509131', '12706395039', '12705761325')
  AND notes = 'Monday live sale'
  AND created_at >= '2026-08-04T00:00:00Z';

-- ── Re-stamp the moved markers (also the re-run guard) ─────────────────────
-- Future flips/reverts on these cards will decrement the day the counter now
-- actually sits on.
UPDATE public.webhook_logs wl
SET data = jsonb_set(wl.data, '{metric_date}', to_jsonb(m.true_date::text))
        || '{"daymoved": true}'::jsonb
FROM _moves m
WHERE wl.id = m.marker_id;

UPDATE public.webhook_logs wl
SET data = jsonb_set(wl.data, '{metric_date}', to_jsonb(c.true_date::text))
FROM _credit_moves c
WHERE wl.id = c.marker_id;

-- ── Part B: burst-race top-up ──────────────────────────────────────────────
-- The 2026-08-04 replay pushed ~40 deliveries through the edge function at
-- once, and its daily_logs/daily_metrics writes are read-modify-write — two
-- concurrent deliveries for the SAME canvasser read the same row and one
-- increment was lost (observed live: 1 blowout, 1 CTC, 5 leads_called_in
-- short of the 36 recorded markers). The markers ARE atomic, so re-derive
-- the expected counters from them and ADD whatever is missing. GREATEST(0,…)
-- means rows padded by manual entry are never reduced, and a re-run is a
-- no-op. Runs after the day-move above so marker days are already true days.

CREATE TEMP TABLE _exp AS
WITH latest AS (
  SELECT DISTINCT ON (wl.data ->> 'pulseId')
         (wl.data ->> 'canvasser_id')::uuid AS canvasser_id,
         wl.data ->> 'office_location' AS office_location,
         (wl.data ->> 'metric_date')::date AS day,
         wl.data ->> 'bucket' AS bucket,
         COALESCE((wl.data ->> 'nonCore')::boolean, false) AS non_core
  FROM public.webhook_logs wl
  WHERE wl.step = 'Card_Outcome_Recorded'
    AND (wl.data ->> 'metric_date')::date >= '2026-08-03'
  ORDER BY wl.data ->> 'pulseId', wl.created_at DESC
),
credits AS (
  SELECT (wl.data ->> 'canvasser_id')::uuid AS canvasser_id,
         COALESCE(
           (wl.data ->> 'metric_date')::date,
           (wl.created_at AT TIME ZONE 'America/Los_Angeles')::date
         ) AS day
  FROM public.webhook_logs wl
  WHERE wl.step = 'Lead_Credit_Applied'
    AND wl.created_at >= '2026-08-03T07:00:00Z'
)
SELECT canvasser_id, office_location, day,
       SUM(sits) AS sits, SUM(sales) AS sales, SUM(no_demo) AS no_demo,
       SUM(future_leads) AS future_leads, SUM(ctc) AS ctc,
       SUM(non_core) AS non_core, SUM(called_in) AS called_in
FROM (
  SELECT canvasser_id, office_location, day,
         CASE WHEN bucket IN ('sit', 'sales') THEN 1 ELSE 0 END AS sits,
         CASE WHEN bucket = 'sales' THEN 1 ELSE 0 END AS sales,
         CASE WHEN bucket = 'blowouts' THEN 1 ELSE 0 END AS no_demo,
         CASE WHEN bucket = 'resets' THEN 1 ELSE 0 END AS future_leads,
         CASE WHEN bucket = 'ctc' THEN 1 ELSE 0 END AS ctc,
         CASE WHEN non_core THEN 1 ELSE 0 END AS non_core,
         0 AS called_in
  FROM latest
  UNION ALL
  -- Credits carry no office; attribute them to the canvasser's outcome
  -- office that day (every credited card also recorded an outcome).
  SELECT c.canvasser_id,
         (SELECT l.office_location FROM latest l
          WHERE l.canvasser_id = c.canvasser_id LIMIT 1),
         c.day, 0, 0, 0, 0, 0, 0, 1
  FROM credits c
) u
WHERE office_location IS NOT NULL
GROUP BY canvasser_id, office_location, day;

-- daily_logs: add only the missing units.
UPDATE public.daily_logs dl SET
  demos_sits      = dl.demos_sits      + GREATEST(0, e.sits - dl.demos_sits),
  sales           = dl.sales           + GREATEST(0, e.sales - dl.sales),
  no_demo         = dl.no_demo         + GREATEST(0, e.no_demo - dl.no_demo),
  future_leads    = dl.future_leads    + GREATEST(0, e.future_leads - dl.future_leads),
  ctc             = dl.ctc             + GREATEST(0, e.ctc - dl.ctc),
  non_core        = dl.non_core        + GREATEST(0, e.non_core - dl.non_core),
  leads_called_in = dl.leads_called_in + GREATEST(0, e.called_in - dl.leads_called_in)
FROM _exp e
WHERE dl.canvasser_id = e.canvasser_id
  AND dl.log_date = e.day
  AND dl.office_location = e.office_location;

-- daily_metrics: same top-up for the Block mirrors + leads_submitted.
UPDATE public.daily_metrics dm SET
  pitch_missed    = dm.pitch_missed    + GREATEST(0, (e.sits - e.sales) - dm.pitch_missed),
  sales           = dm.sales           + GREATEST(0, e.sales - dm.sales),
  resets          = dm.resets          + GREATEST(0, e.future_leads - dm.resets),
  blowouts        = dm.blowouts        + GREATEST(0, e.no_demo - dm.blowouts),
  leads_submitted = dm.leads_submitted + GREATEST(0, e.called_in - dm.leads_submitted)
FROM _exp e
WHERE dm.canvasser_id = e.canvasser_id
  AND dm.metric_date = e.day;

DROP TABLE _exp;

COMMIT;

-- Post-apply spot check (all 33 marked outcomes, minus the agent-less Kolt
-- Reload = 32 credited): Monday 8/3 → 10 sits (3 sales among them),
-- 12 blowouts, 3 resets, 25 leads_called_in; Tuesday 8/4 → 2 blowouts,
-- 5 CTC, 7 leads_called_in (plus whatever lands live after this audit):
--   SELECT log_date, office_location, SUM(demos_sits) sits, SUM(sales) sales,
--          SUM(no_demo) bo, SUM(future_leads) rs, SUM(ctc) ctc,
--          SUM(leads_called_in) called_in
--   FROM daily_logs WHERE log_date >= '2026-08-03'
--   GROUP BY 1, 2 ORDER BY 1, 2;
