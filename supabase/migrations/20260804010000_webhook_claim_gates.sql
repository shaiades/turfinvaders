-- Webhook claim gates (2026-08-04): close the double-count races found in the
-- OC/SD week-of-7/27 audit. Two same-second Monday deliveries could both pass
-- the read-then-insert claim checks in monday-live-dispatch and each write
-- counters (one sale and one blowout each counted twice, live 2026-07-29/30).
--
-- 1. Once-ever claim steps become UNIQUE per Monday item, so the insert
--    itself is the claim (23505 = lost the race). Pre-existing duplicate
--    claim rows are removed first, keeping the EARLIEST (first claim wins);
--    the counters they double-wrote are corrected separately by the
--    week-of-7/27 backfill.
-- 2. claim_block_card_transition(): verifies the caller's view of the last
--    recorded card state and inserts the new state markers atomically under
--    a per-pulse advisory lock. The edge function retries once on a lost
--    claim, re-diffing against the actual state this returns.
--
-- Apply by hand in the xogit (xogitpqeuwalerxygvjw) SQL editor — migrations
-- do not auto-apply. The edge function runs safely before this lands (it
-- logs Claim_RPC_Missing and falls back to the legacy racy path).

-- ── 1a. Drop duplicate once-ever claims, keeping the earliest ──────────────
DELETE FROM public.webhook_logs w
USING public.webhook_logs k
WHERE w.step IN ('Lead_Generated_Credited', 'Lead_Credit_Applied')
  AND k.step = w.step
  AND (w.data->>'pulseId') IS NOT NULL
  AND (k.data->>'pulseId') = (w.data->>'pulseId')
  AND (k.created_at < w.created_at
       OR (k.created_at = w.created_at AND k.id < w.id));

-- ── 1b. The insert IS the claim from now on ────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS webhook_logs_lead_generated_claim_uq
  ON public.webhook_logs ((data->>'pulseId'))
  WHERE step = 'Lead_Generated_Credited' AND (data->>'pulseId') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS webhook_logs_lead_credit_claim_uq
  ON public.webhook_logs ((data->>'pulseId'))
  WHERE step = 'Lead_Credit_Applied' AND (data->>'pulseId') IS NOT NULL;

-- Marker lookups run on every webhook delivery; give them a real index
-- (the old .contains() path could only ever seq-scan).
CREATE INDEX IF NOT EXISTS webhook_logs_step_pulse_created_idx
  ON public.webhook_logs (step, (data->>'pulseId'), created_at DESC)
  WHERE (data->>'pulseId') IS NOT NULL;

-- ── 2. Atomic card-state transition claim ──────────────────────────────────
-- _expected_outcome: {"exists": false} | {"exists": true, "bucket": text|null,
--                     "nonCore": bool}
-- _expected_ol:      {"exists": false} | {"exists": true, "ol": bool}
-- Returns {"claimed": true, "outcome_marker_id", "ol_marker_id"} on success,
-- else {"claimed": false, "actual_outcome": {data, created_at}|null,
--       "actual_ol": {data, created_at}|null} for the caller to re-diff.
CREATE OR REPLACE FUNCTION public.claim_block_card_transition(
  _pulse_id text,
  _claim_outcome boolean DEFAULT false,
  _expected_outcome jsonb DEFAULT NULL,
  _outcome_data jsonb DEFAULT NULL,
  _claim_ol boolean DEFAULT false,
  _expected_ol jsonb DEFAULT NULL,
  _ol_data jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  latest_outcome public.webhook_logs%ROWTYPE;
  latest_ol public.webhook_logs%ROWTYPE;
  outcome_ok boolean := true;
  ol_ok boolean := true;
  new_outcome_id uuid;
  new_ol_id uuid;
BEGIN
  IF _pulse_id IS NULL OR _pulse_id = '' THEN
    RAISE EXCEPTION 'claim_block_card_transition: _pulse_id is required';
  END IF;

  -- Serialize every claim for this Monday item within the transaction.
  PERFORM pg_advisory_xact_lock(hashtextextended('block_card:' || _pulse_id, 0));

  SELECT * INTO latest_outcome
  FROM public.webhook_logs
  WHERE step = 'Card_Outcome_Recorded' AND data->>'pulseId' = _pulse_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  SELECT * INTO latest_ol
  FROM public.webhook_logs
  WHERE step = 'Card_OL_Recorded' AND data->>'pulseId' = _pulse_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF _claim_outcome THEN
    IF COALESCE((_expected_outcome->>'exists')::boolean, false) THEN
      outcome_ok := latest_outcome.id IS NOT NULL
        AND (latest_outcome.data->>'bucket') IS NOT DISTINCT FROM (_expected_outcome->>'bucket')
        AND COALESCE((latest_outcome.data->>'nonCore')::boolean, false)
            = COALESCE((_expected_outcome->>'nonCore')::boolean, false);
    ELSE
      outcome_ok := latest_outcome.id IS NULL;
    END IF;
  END IF;

  IF _claim_ol THEN
    IF COALESCE((_expected_ol->>'exists')::boolean, false) THEN
      ol_ok := latest_ol.id IS NOT NULL
        AND COALESCE((latest_ol.data->>'ol')::boolean, false)
            = COALESCE((_expected_ol->>'ol')::boolean, false);
    ELSE
      ol_ok := latest_ol.id IS NULL;
    END IF;
  END IF;

  IF NOT (outcome_ok AND ol_ok) THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'actual_outcome', CASE WHEN latest_outcome.id IS NULL THEN NULL
        ELSE jsonb_build_object('data', latest_outcome.data, 'created_at', latest_outcome.created_at) END,
      'actual_ol', CASE WHEN latest_ol.id IS NULL THEN NULL
        ELSE jsonb_build_object('data', latest_ol.data, 'created_at', latest_ol.created_at) END
    );
  END IF;

  IF _claim_outcome THEN
    INSERT INTO public.webhook_logs (step, data)
    VALUES ('Card_Outcome_Recorded', _outcome_data)
    RETURNING id INTO new_outcome_id;
  END IF;

  IF _claim_ol THEN
    INSERT INTO public.webhook_logs (step, data)
    VALUES ('Card_OL_Recorded', _ol_data)
    RETURNING id INTO new_ol_id;
  END IF;

  RETURN jsonb_build_object(
    'claimed', true,
    'outcome_marker_id', new_outcome_id,
    'ol_marker_id', new_ol_id
  );
END;
$$;

-- The webhook's service-role client is the only intended caller.
REVOKE ALL ON FUNCTION public.claim_block_card_transition(text, boolean, jsonb, jsonb, boolean, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_block_card_transition(text, boolean, jsonb, jsonb, boolean, jsonb, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_block_card_transition(text, boolean, jsonb, jsonb, boolean, jsonb, jsonb) TO service_role;
