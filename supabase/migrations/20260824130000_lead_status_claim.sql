-- Atomic Lead Status funnel transition (2026-08-24).
--
-- ⚠ ORDERING: apply this migration BEFORE deploying the monday-live-dispatch
-- edge function that calls it. The new edge code has NO fallback — with the
-- RPC missing, every Lead Status flip 502s (logged as
-- Lead_Status_Claim_RPC_Missing) until Monday's ~30-minute retry loop gives
-- up and the flip is lost. Applying the RPC first is harmless: nothing calls
-- it until the deploy.
--
-- The submission-day attribution change makes the Lead_Status_Processed
-- marker load-bearing: the previous bucket, the day its +1 sits on, and the
-- canvasser holding it are all read from the latest marker. This RPC makes
-- the whole transition one transaction — CAS on the latest marker's id,
-- decrement of the previous bucket where its +1 actually sits (derived from
-- the marker re-read UNDER the lock, so a backfill restamp that moved the
-- count is always honored), relative-arithmetic counter writes (no absolute
-- read-modify-write to clobber a concurrent delivery's work), and the marker
-- insert. A crash can no longer separate counters from their marker, and no
-- release/compensation path exists to race.
--
-- The advisory lock is a single global key — NOT per-pulse — for two
-- reasons: the subday-attribution backfill takes the same one lock (a
-- per-pulse scheme would need thousands of slots from the shared lock
-- table), and flips are hand-entered by the confirmation team, so global
-- serialization costs nothing.

-- A superseded 3-arg draft of this function existed briefly on main (never
-- applied to prod). CREATE OR REPLACE with a different signature would
-- CREATE AN OVERLOAD, not replace it — drop the old shape first (no-op on
-- fresh environments). Consequence: rolling the edge function back to the
-- draft that called the 3-arg shape would 502 every flip; roll forward, not
-- back.
DROP FUNCTION IF EXISTS public.claim_lead_status_transition(text, jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.claim_lead_status_transition(
  _pulse_id text,
  _expected jsonb,          -- {"exists": false} | {"exists": true, "marker_id": "<uuid>"}
  _new_bucket text,         -- mapped funnel column, or null for unmapped labels
  _canvasser_id uuid,       -- current Agent match (receives the +1)
  _attributed_date date,    -- submission-day attribution (the +1 day)
  _office text,             -- office guess for brand-new rows only
  _marker_data jsonb        -- audit payload; authoritative fields are overwritten below
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  latest public.webhook_logs%ROWTYPE;
  ok boolean;
  prev_bucket text := NULL;
  prev_date date := NULL;
  prev_canvasser uuid := NULL;
  resolved_prev uuid := NULL;
  dec_applied boolean := false;
  dec_skipped boolean := false;
  new_id uuid;
BEGIN
  IF _pulse_id IS NULL OR _pulse_id = '' THEN
    RAISE EXCEPTION 'claim_lead_status_transition: _pulse_id is required';
  END IF;
  IF _canvasser_id IS NULL OR _attributed_date IS NULL THEN
    RAISE EXCEPTION 'claim_lead_status_transition: _canvasser_id and _attributed_date are required';
  END IF;
  IF _new_bucket IS NOT NULL
     AND _new_bucket NOT IN ('leads_confirmed', 'no_answers', 'killed', 'pending', 'future') THEN
    RAISE EXCEPTION 'claim_lead_status_transition: unknown bucket %', _new_bucket;
  END IF;

  -- Serialize every lead-status transition (and the backfill) globally.
  PERFORM pg_advisory_xact_lock(hashtextextended('lead_status', 0));

  SELECT * INTO latest
  FROM public.webhook_logs
  WHERE step = 'Lead_Status_Processed' AND data->>'pulseId' = _pulse_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  -- NULL-safe CAS: a missing/null expected marker_id must REJECT, not
  -- NULL-propagate into a granted claim.
  IF COALESCE((_expected->>'exists')::boolean, false) THEN
    ok := latest.id IS NOT NULL
      AND (_expected->>'marker_id') IS NOT NULL
      AND latest.id = (_expected->>'marker_id')::uuid;
  ELSE
    ok := latest.id IS NULL;
  END IF;

  IF NOT COALESCE(ok, false) THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'actual', CASE WHEN latest.id IS NULL THEN NULL
        ELSE jsonb_build_object('id', latest.id, 'data', latest.data, 'created_at', latest.created_at)
      END
    );
  END IF;

  -- Previous state from the row we just read UNDER the lock — the backfill
  -- restamps metric_date in place (same id), so this read, not the caller's,
  -- is the truth about where the previous +1 sits.
  IF latest.id IS NOT NULL THEN
    prev_bucket := latest.data->>'recordedAs';
    IF prev_bucket IS NOT NULL
       AND prev_bucket NOT IN ('leads_confirmed', 'no_answers', 'killed', 'pending', 'future') THEN
      prev_bucket := NULL;
    END IF;
    prev_date := COALESCE((latest.data->>'metric_date')::date,
                          (latest.created_at AT TIME ZONE 'America/Los_Angeles')::date);
    prev_canvasser := NULLIF(latest.data->>'canvasser_id', '')::uuid;
    IF prev_canvasser IS NOT NULL THEN
      -- merge_canvassers repoints daily_metrics to the keeper but markers
      -- keep the loser; archived losers carry merged_into (pre-collapsed).
      SELECT COALESCE(p.merged_into, p.id) INTO resolved_prev
      FROM public.profiles p WHERE p.id = prev_canvasser;
      -- Not found (hard-deleted loser): resolved_prev stays NULL and the
      -- decrement is SKIPPED — never re-targeted at another canvasser.
    END IF;
  END IF;

  -- Decrement the previous bucket where (and for whom) it was counted.
  IF prev_bucket IS NOT NULL THEN
    IF resolved_prev IS NOT NULL AND prev_date IS NOT NULL THEN
      EXECUTE format(
        'UPDATE public.daily_metrics SET %I = GREATEST(0, %I - 1)
         WHERE canvasser_id = $1 AND metric_date = $2',
        prev_bucket, prev_bucket)
      USING resolved_prev, prev_date;
      dec_applied := true;
    ELSE
      dec_skipped := true;
    END IF;
  END IF;

  -- Increment the new bucket on the attributed day, relative arithmetic.
  -- ON CONFLICT only touches the counter column — an existing day-row is
  -- never re-homed to a different office.
  IF _new_bucket IS NOT NULL THEN
    EXECUTE format(
      'INSERT INTO public.daily_metrics (canvasser_id, metric_date, office_location, %I)
       VALUES ($1, $2, COALESCE($3, ''San Diego''), 1)
       ON CONFLICT (canvasser_id, metric_date)
       DO UPDATE SET %I = public.daily_metrics.%I + 1',
      _new_bucket, _new_bucket, _new_bucket)
    USING _canvasser_id, _attributed_date, _office;
  END IF;

  -- The marker records what was actually applied (authoritative fields
  -- overwrite the caller's audit payload). metric_date invariant: the day
  -- this card's +1 now sits on.
  INSERT INTO public.webhook_logs (step, data)
  VALUES ('Lead_Status_Processed',
    COALESCE(_marker_data, '{}'::jsonb)
    || jsonb_build_object(
         'pulseId', _pulse_id,
         'canvasser_id', _canvasser_id,
         'metric_date', _attributed_date::text,
         'recordedAs', _new_bucket,
         'undid', prev_bucket)
    || CASE WHEN prev_date IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('undidDate', prev_date::text) END
    || CASE WHEN resolved_prev IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('undidCanvasserId', resolved_prev) END
    || CASE WHEN dec_skipped THEN jsonb_build_object('undidSkipped', true)
            ELSE '{}'::jsonb END)
  RETURNING id INTO new_id;

  RETURN jsonb_build_object(
    'claimed', true,
    'marker_id', new_id,
    'decApplied', dec_applied,
    'decSkipped', dec_skipped
  );
END;
$$;

-- The webhook's service-role client is the only intended caller.
REVOKE ALL ON FUNCTION public.claim_lead_status_transition(text, jsonb, text, uuid, date, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_lead_status_transition(text, jsonb, text, uuid, date, text, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_lead_status_transition(text, jsonb, text, uuid, date, text, jsonb) TO service_role;
