-- Chemberlen — an office appointment must not credit a canvasser
-- (owner, 2026-08-31). Companion backfill to the office-appt credit gate;
-- the gate is roll-forward, this squares the one card already written.
--
-- THE CARDS (public.block_cards, verified):
--   12869833420  8/21 Fri  "Janet Chemberlen (SHO)…"  Iss="Iss"          Sold $41,588
--   12898859448  8/25 Tue  "Chemberlen , Janet"        Iss="Office Appt"  Sold $25,948
--   12928325019  8/25 Tue  "Chemberlen , Janet (copy)" Iss="Office Appt"  Sold $25,948
--
-- Eduardo ordaz knocked the 8/21 job ($41,588) — that credit is CORRECT and
-- this script does not touch it. The job was then cancelled and the office
-- saved it on a Job Walk at $25,948 ("can save" in the card comments). The
-- office card carried Canvass Stats="Sale", so the webhook counted Eduardo a
-- sale he never knocked and minted him a $25,948 lead.
--
-- WHAT THIS DOES, for pulse 12898859448 only:
--   1. Moves the $25,948 lead from Eduardo to the "Job Walk" lead-source
--      channel — the pseudo profile the blank-Agent path has credited since
--      2026-08-10, which already holds 20 office leads. Company revenue stays
--      visible on the Command board; no person is paid for it.
--   2. Un-counts Eduardo's sale on the day it landed (8/29): daily_logs
--      demos_sits-1 and sales-1, daily_metrics sales-1.
--   3. Renames the outcome marker to Card_Outcome_Reverted with a NULL
--      bucket, so it neither counts nor poisons the next transition.
-- team_id is left as-is rather than nulled: leads.team_id is the only record
-- of which van a week's production belonged to (PR #126).
--
-- NOT DONE HERE (owner calls, deliberately):
--   * Whether the cancelled 8/21 $41,588 should be clawed back or re-priced
--     to the saved $25,948 — that edits a CLOSED week and is a pay decision.
--   * Excluding pseudo channels from the pay engine: "Job Walk" earns a
--     1% commission line today (~$259 for wk 8/24 before this card). That is
--     a payroll-touching SQL change.
-- Idempotent via the Manual_Correction tag. Run in the xogit SQL editor.

BEGIN;

DO $$
DECLARE
  v_channel uuid;
  v_lead uuid;
  v_canv uuid;
  v_day date;
  v_office text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.webhook_logs
             WHERE step = 'Manual_Correction'
               AND data->>'tag' = 'chemberlen-office-appt-20260831') THEN
    RAISE NOTICE 'chemberlen-office-appt-20260831 already applied';
    RETURN;
  END IF;

  SELECT id INTO v_channel FROM public.profiles
   WHERE lower(regexp_replace(trim(display_name), '\s+', ' ', 'g')) = 'job walk' LIMIT 1;
  IF v_channel IS NULL THEN
    RAISE EXCEPTION 'the "Job Walk" lead-source profile is missing — investigate before running';
  END IF;

  SELECT l.id, l.canvasser_id INTO v_lead, v_canv
    FROM public.leads l
   WHERE l.monday_item_id = '12898859448' AND l.status = 'confirmed'
     AND l.sale_amount = 25948;
  IF v_lead IS NULL THEN
    RAISE EXCEPTION 'the $25,948 Chemberlen lead (item 12898859448) is not where expected';
  END IF;
  IF v_canv = v_channel THEN
    RAISE NOTICE 'lead already held by the channel — nothing to move';
    RETURN;
  END IF;

  -- The day and office the sale was counted on, from the card's own marker.
  SELECT (w.data->>'metric_date')::date, COALESCE(w.data->>'office_location','Orange County')
    INTO v_day, v_office
    FROM public.webhook_logs w
   WHERE w.step = 'Card_Outcome_Recorded'
     AND w.data->>'pulseId' = '12898859448'
     AND w.data->>'bucket' = 'sales'
   ORDER BY w.created_at DESC LIMIT 1;

  UPDATE public.leads SET canvasser_id = v_channel WHERE id = v_lead;

  IF v_day IS NOT NULL THEN
    UPDATE public.daily_logs
       SET demos_sits = GREATEST(0, demos_sits - 1), sales = GREATEST(0, sales - 1)
     WHERE canvasser_id = v_canv AND log_date = v_day AND office_location = v_office;
    UPDATE public.daily_metrics SET sales = GREATEST(0, sales - 1)
     WHERE canvasser_id = v_canv AND metric_date = v_day;
    UPDATE public.webhook_logs
       SET step = 'Card_Outcome_Reverted',
           data = data || jsonb_build_object('bucket', NULL, 'reverted', true,
                    'revert_tag', 'chemberlen-office-appt-20260831',
                    'revert_reason', 'office appointment — never credits a canvasser')
     WHERE step = 'Card_Outcome_Recorded'
       AND data->>'pulseId' = '12898859448' AND data->>'bucket' = 'sales';
  END IF;

  INSERT INTO public.webhook_logs (step, data) VALUES ('Manual_Correction',
    jsonb_build_object('tag', 'chemberlen-office-appt-20260831',
      'lead', v_lead, 'moved_from', v_canv, 'moved_to', v_channel,
      'amount', 25948, 'uncounted_day', v_day, 'office', v_office));
END $$;

COMMIT;

-- The dashboard editor swallows RAISE NOTICE — read the outcome here:
SELECT (SELECT display_name FROM public.profiles WHERE id = l.canvasser_id) AS now_credited_to,
       l.sale_amount, l.status
  FROM public.leads l WHERE l.monday_item_id = '12898859448';
