-- Atomic claim for Lead Status funnel transitions (2026-08-24).
--
-- The submission-day attribution change makes the Lead_Status_Processed
-- marker load-bearing: the previous bucket AND the day its +1 sits on are
-- both read from the latest marker. Concurrent deliveries for one card that
-- both read the same marker would each apply a transition (the race the
-- Block path closed with claim_block_card_transition after the 2026-07-29/30
-- double-count). This RPC is the same compare-and-swap, keyed on the latest
-- marker's id: the edge function reads markers, computes the transition,
-- then claims — a mismatch means another delivery got there first, and the
-- caller 502s so Monday's retry re-reads fresh state and no-ops.
--
-- The advisory lock key ('lead_status:' || pulse_id) is shared with the
-- subday-attribution backfill script, which takes the same locks so a live
-- flip cannot interleave with the historical re-bucketing.

CREATE OR REPLACE FUNCTION public.claim_lead_status_transition(
  _pulse_id text,
  _expected jsonb,     -- {"exists": false} | {"exists": true, "marker_id": "<uuid>"}
  _marker_data jsonb   -- full data payload for the new Lead_Status_Processed marker
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  latest public.webhook_logs%ROWTYPE;
  ok boolean;
  new_id uuid;
BEGIN
  IF _pulse_id IS NULL OR _pulse_id = '' THEN
    RAISE EXCEPTION 'claim_lead_status_transition: _pulse_id is required';
  END IF;

  -- Serialize every lead-status claim for this Monday item.
  PERFORM pg_advisory_xact_lock(hashtextextended('lead_status:' || _pulse_id, 0));

  SELECT * INTO latest
  FROM public.webhook_logs
  WHERE step = 'Lead_Status_Processed' AND data->>'pulseId' = _pulse_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF COALESCE((_expected->>'exists')::boolean, false) THEN
    ok := latest.id IS NOT NULL AND latest.id = (_expected->>'marker_id')::uuid;
  ELSE
    ok := latest.id IS NULL;
  END IF;

  IF NOT ok THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'actual', CASE WHEN latest.id IS NULL THEN NULL
        ELSE jsonb_build_object('id', latest.id, 'data', latest.data, 'created_at', latest.created_at)
      END
    );
  END IF;

  INSERT INTO public.webhook_logs (step, data)
  VALUES ('Lead_Status_Processed', _marker_data)
  RETURNING id INTO new_id;

  RETURN jsonb_build_object('claimed', true, 'marker_id', new_id);
END;
$$;

-- The webhook's service-role client is the only intended caller.
REVOKE ALL ON FUNCTION public.claim_lead_status_transition(text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_lead_status_transition(text, jsonb, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_lead_status_transition(text, jsonb, jsonb) TO service_role;
