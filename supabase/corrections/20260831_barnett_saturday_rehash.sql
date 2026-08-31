-- Grace Barnett wk 8/24 — count BOTH appointments (authored 2026-08-31).
-- Ernie Ruiz canvassed her; the card ran Wed 8/26 → Blowout (No Demo).
-- Cynthia King (telemarketing re-hash) got the lead back out Saturday 8/29;
-- it ran again on the SAME Monday pulse (12896954975) in the Saturday group
-- → Blowout (No Show). The webhook saw "same state, no change" and no-op'd,
-- so only ONE of the two appointments is counted. The live path is fixed
-- going forward (sameStateRerun, PR #131); this squares last week.
--
-- Self-deciding: reads the pulse's latest Card_Outcome_Recorded marker to
-- see WHICH appointment the app already holds, then adds the missing one.
-- Idempotent via a Manual_Correction marker. Blowouts carry no points/pay.
-- Run in the xogit (xogitpqeuwalerxygvjw) SQL editor.

BEGIN;

DO $$
DECLARE
  v_cynthia uuid;
  v_ernie uuid;
  v_marker jsonb;
  v_target uuid;
  v_target_name text;
  v_date date;
  v_copy_pulse text;
  v_copy_group text;
  v_note text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.webhook_logs
             WHERE step = 'Manual_Correction'
               AND data->>'tag' = 'barnett-saturday-20260831') THEN
    RAISE NOTICE 'barnett-saturday-20260831 already applied — nothing to do';
    RETURN;
  END IF;

  SELECT id INTO v_cynthia FROM public.profiles
   WHERE lower(regexp_replace(trim(display_name), '\s+', ' ', 'g')) = 'cynthia king'
   LIMIT 1;
  SELECT id INTO v_ernie FROM public.profiles
   WHERE lower(regexp_replace(trim(display_name), '\s+', ' ', 'g')) = 'ernie ruiz'
   LIMIT 1;
  IF v_cynthia IS NULL OR v_ernie IS NULL THEN
    RAISE EXCEPTION 'profile lookup failed (cynthia=%, ernie=%)', v_cynthia, v_ernie;
  END IF;

  SELECT data INTO v_marker FROM public.webhook_logs
   WHERE step = 'Card_Outcome_Recorded' AND data->>'pulseId' = '12896954975'
   ORDER BY created_at DESC LIMIT 1;
  IF v_marker IS NULL THEN
    RAISE EXCEPTION 'no Card_Outcome_Recorded marker for pulse 12896954975 — investigate before applying';
  END IF;
  IF (v_marker->>'bucket') IS DISTINCT FROM 'blowouts' THEN
    RAISE EXCEPTION 'unexpected marker bucket % for pulse 12896954975 — investigate', v_marker->>'bucket';
  END IF;

  IF (v_marker->>'canvasser_id') = v_ernie::text THEN
    -- App holds Ernie's Wednesday No Demo → add Cynthia's Saturday No Show.
    v_target := v_cynthia; v_target_name := 'Cynthia King';
    v_date := DATE '2026-08-29';
    v_copy_pulse := '12927973765'; v_copy_group := 'Saturday';
    v_note := 'app held Ernie Wed 8/26; added Cynthia Sat 8/29 (No Show)';
  ELSIF (v_marker->>'canvasser_id') = v_cynthia::text THEN
    -- App holds Cynthia's Saturday No Show → add Ernie's Wednesday No Demo.
    v_target := v_ernie; v_target_name := 'Ernie Ruiz';
    v_date := DATE '2026-08-26';
    v_copy_pulse := '12907114978'; v_copy_group := 'Wednesday';
    v_note := 'app held Cynthia Sat 8/29; added Ernie Wed 8/26 (No Demo)';
  ELSE
    RAISE EXCEPTION 'marker canvasser % is neither Ernie nor Cynthia — investigate',
      v_marker->>'canvasser_id';
  END IF;

  -- Payroll/Weekly-Results feed (no_demo carries no points or pay).
  INSERT INTO public.daily_logs (canvasser_id, log_date, office_location)
  VALUES (v_target, v_date, 'San Diego')
  ON CONFLICT (canvasser_id, log_date, office_location) DO NOTHING;
  UPDATE public.daily_logs
     SET no_demo = COALESCE(no_demo, 0) + 1
   WHERE canvasser_id = v_target AND log_date = v_date
     AND office_location = 'San Diego';

  -- Day tiles.
  INSERT INTO public.daily_metrics (canvasser_id, metric_date, office_location, blowouts)
  VALUES (v_target, v_date, 'San Diego', 1)
  ON CONFLICT (canvasser_id, metric_date) DO UPDATE
    SET blowouts = COALESCE(public.daily_metrics.blowouts, 0) + 1;

  -- Marker for the surviving "(copy)" card that preserves this appointment,
  -- so future flips on it transition cleanly and replays no-op.
  INSERT INTO public.webhook_logs (step, data) VALUES ('Card_Outcome_Recorded',
    jsonb_build_object(
      'pulseId', v_copy_pulse, 'bucket', 'blowouts', 'nonCore', false,
      'prev', NULL, 'canvasser_id', v_target,
      'metric_date', to_char(v_date, 'YYYY-MM-DD'),
      'office_location', 'San Diego',
      'blockDay', to_char(v_date, 'YYYY-MM-DD'), 'groupTitle', v_copy_group,
      'itemName', 'Grace Barnett and son Troy sho (copy)',
      'note', 'manual correction barnett-saturday-20260831'));

  INSERT INTO public.webhook_logs (step, data) VALUES ('Manual_Correction',
    jsonb_build_object('tag', 'barnett-saturday-20260831',
      'decision', v_note, 'credited', v_target_name));
END $$;

COMMIT;

-- The dashboard editor swallows RAISE NOTICE — read the outcome here:
SELECT data->>'decision' AS applied
  FROM public.webhook_logs
 WHERE step = 'Manual_Correction'
   AND data->>'tag' = 'barnett-saturday-20260831';
