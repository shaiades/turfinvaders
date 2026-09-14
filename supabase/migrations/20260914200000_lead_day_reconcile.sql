-- Lead-day reconcile (2026-09-14).
--
-- The Incoming Leads board's "Date" column (date8__1) now declares the day a
-- lead was actually GENERATED. When the office re-enters an old lead (a
-- late turn-in, or a retry "to help out the canvasser"), the card is born
-- today and used to count as today's production — 9/14 incident: two
-- Saturday leads ("Jim", "Seana Meador") showed up as today's Submitted +
-- Blowout. Backdating the Date column now moves the card's counted units to
-- the true day instead.
--
-- This RPC moves, for one pulse, (a) the leads_generated +1 recorded by its
-- Lead_Generated_Processed marker and (b) the funnel bucket +1 recorded by
-- its latest Lead_Status_Processed marker, onto _target_date — counters and
-- markers together in one transaction, under the same global advisory lock
-- as claim_lead_status_transition, whose decrement logic re-reads the
-- marker under that lock and therefore honors these in-place restamps.
--
-- Guard rails, applied per unit (gen and status move independently):
--   * backdate-only: _target_date must be strictly EARLIER than the day the
--     unit currently sits on — a board automation re-stamping "today" can
--     never drag history forward;
--   * 14-day window (matching the webhook's recycled-card clamp): both the
--     current day and the target day must be within the last 14 LA days, so
--     closed weeks stay closed;
--   * drift check: the decrement only applies where the counter actually
--     holds a unit (> 0); otherwise that unit is skipped and reported, and
--     its marker is left untouched.

CREATE OR REPLACE FUNCTION public.reconcile_lead_day(
  _pulse_id text,
  _target_date date,
  _reason text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  la_today date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  window_floor date;
  gen_marker public.webhook_logs%ROWTYPE;
  st_marker public.webhook_logs%ROWTYPE;
  results jsonb := '{}'::jsonb;
  units jsonb := '[]'::jsonb;
  u jsonb;
  res jsonb;
  col text;
  cur_date date;
  raw_canvasser uuid;
  resolved uuid;
BEGIN
  IF _pulse_id IS NULL OR _pulse_id = '' OR _target_date IS NULL THEN
    RAISE EXCEPTION 'reconcile_lead_day: _pulse_id and _target_date are required';
  END IF;
  window_floor := la_today - 14;

  -- Same global lock as claim_lead_status_transition: no flip, backfill, or
  -- other reconcile can interleave with this move.
  PERFORM pg_advisory_xact_lock(hashtextextended('lead_status', 0));

  SELECT * INTO gen_marker
  FROM public.webhook_logs
  WHERE step = 'Lead_Generated_Processed' AND data->>'pulseId' = _pulse_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  SELECT * INTO st_marker
  FROM public.webhook_logs
  WHERE step = 'Lead_Status_Processed' AND data->>'pulseId' = _pulse_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF gen_marker.id IS NULL THEN
    results := results || jsonb_build_object('gen', jsonb_build_object('moved', false, 'reason', 'no_marker'));
  ELSE
    units := units || jsonb_build_array(jsonb_build_object(
      'kind', 'gen',
      'marker_id', gen_marker.id,
      'col', 'leads_generated',
      'cur', COALESCE(gen_marker.data->>'metric_date',
                      ((gen_marker.created_at AT TIME ZONE 'America/Los_Angeles')::date)::text),
      'canvasser', NULLIF(gen_marker.data->>'canvasser_id', ''),
      'office', gen_marker.data->>'office'));
  END IF;

  IF st_marker.id IS NULL THEN
    results := results || jsonb_build_object('status', jsonb_build_object('moved', false, 'reason', 'no_marker'));
  ELSIF st_marker.data->>'recordedAs' IS NULL
     OR st_marker.data->>'recordedAs' NOT IN
        ('leads_confirmed', 'no_answers', 'killed', 'pending', 'future') THEN
    results := results || jsonb_build_object('status', jsonb_build_object('moved', false, 'reason', 'no_counted_bucket'));
  ELSE
    units := units || jsonb_build_array(jsonb_build_object(
      'kind', 'status',
      'marker_id', st_marker.id,
      'col', st_marker.data->>'recordedAs',
      'cur', COALESCE(st_marker.data->>'metric_date',
                      ((st_marker.created_at AT TIME ZONE 'America/Los_Angeles')::date)::text),
      'canvasser', NULLIF(st_marker.data->>'canvasser_id', ''),
      'office', st_marker.data->>'office'));
  END IF;

  FOR u IN SELECT * FROM jsonb_array_elements(units) LOOP
    col := u->>'col';
    cur_date := (u->>'cur')::date;
    raw_canvasser := (u->>'canvasser')::uuid;
    res := NULL;

    IF cur_date IS NULL THEN
      res := jsonb_build_object('moved', false, 'reason', 'no_current_date');
    ELSIF _target_date = cur_date THEN
      res := jsonb_build_object('moved', false, 'reason', 'already_there', 'day', cur_date::text);
    ELSIF _target_date > cur_date THEN
      res := jsonb_build_object('moved', false, 'reason', 'forward_move_blocked', 'day', cur_date::text);
    ELSIF _target_date < window_floor OR cur_date < window_floor OR _target_date > la_today THEN
      res := jsonb_build_object('moved', false, 'reason', 'out_of_window', 'day', cur_date::text);
    ELSIF raw_canvasser IS NULL THEN
      res := jsonb_build_object('moved', false, 'reason', 'no_canvasser', 'day', cur_date::text);
    END IF;

    IF res IS NULL THEN
      -- merge_canvassers repoints daily_metrics to the keeper but markers
      -- keep the loser (same rule as claim_lead_status_transition).
      resolved := NULL;
      SELECT COALESCE(p.merged_into, p.id) INTO resolved
      FROM public.profiles p WHERE p.id = raw_canvasser;
      IF resolved IS NULL THEN
        res := jsonb_build_object('moved', false, 'reason', 'canvasser_gone', 'day', cur_date::text);
      END IF;
    END IF;

    IF res IS NULL THEN
      EXECUTE format(
        'UPDATE public.daily_metrics SET %I = %I - 1
         WHERE canvasser_id = $1 AND metric_date = $2 AND %I > 0',
        col, col, col)
      USING resolved, cur_date;
      IF NOT FOUND THEN
        res := jsonb_build_object('moved', false, 'reason', 'counter_drift', 'day', cur_date::text);
      END IF;
    END IF;

    IF res IS NULL THEN
      EXECUTE format(
        'INSERT INTO public.daily_metrics (canvasser_id, metric_date, office_location, %I)
         VALUES ($1, $2, COALESCE($3, ''San Diego''), 1)
         ON CONFLICT (canvasser_id, metric_date)
         DO UPDATE SET %I = public.daily_metrics.%I + 1',
        col, col, col)
      USING resolved, _target_date, u->>'office';

      -- Restamp the marker IN PLACE (same id): the claim RPC's CAS keys on
      -- the id, and its decrement re-reads metric_date under the shared lock.
      UPDATE public.webhook_logs
      SET data = data || jsonb_build_object(
        'metric_date', _target_date::text,
        'restampedFrom', cur_date::text,
        'restampedAt', now()::text,
        'restampedReason', _reason)
      WHERE id = (u->>'marker_id')::uuid;

      res := jsonb_build_object(
        'moved', true, 'from', cur_date::text, 'day', _target_date::text,
        'canvasser_id', resolved, 'column', col);
    END IF;

    results := results || jsonb_build_object(u->>'kind', res);
  END LOOP;

  IF COALESCE((results->'gen'->>'moved')::boolean, false)
     OR COALESCE((results->'status'->>'moved')::boolean, false) THEN
    INSERT INTO public.webhook_logs (step, data)
    VALUES ('Lead_Day_Reconciled', jsonb_build_object(
      'pulseId', _pulse_id,
      'target', _target_date::text,
      'reason', _reason) || results);
  END IF;

  RETURN results;
END;
$$;

-- The webhook's service-role client is the only intended caller.
REVOKE ALL ON FUNCTION public.reconcile_lead_day(text, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_lead_day(text, date, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_lead_day(text, date, text) TO service_role;
