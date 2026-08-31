-- Week of 8/24 — remove the outcomes the case-blind ghost fallback
-- double-counted (root cause fixed in PR #132), and void the two duplicate
-- sale leads. Authored 2026-08-31 after a per-day audit of production
-- against the SD/OC Block boards.
--
-- Each row below is ONE extra outcome: a card whose ORIGINAL pulse was
-- counted on the day the office first marked it AND whose "(copy)" was
-- counted again, where the block board holds only one card. The pulse named
-- is the one to un-count; the surviving pulse is the one whose day matches
-- the board. Verified per rep per day: every target sits on a day where the
-- app is strictly above the board's card count for that cell.
--
-- DELIBERATELY OUT OF SCOPE (audited, left alone — see the session notes):
--   * Eduardo ordaz 8/24 sit  — Sam Warren, leaked in from the 8/17 week
--     (flip-day attribution, fixed forward by PR #130, not a duplicate)
--   * Eduardo ordaz 8/29 sale $25,948 — Chemberlen: an office Job Walk card
--     with no Agent; the office-appointment credit rule is an owner call
--   * Marcel 8/25 sale — a third sale counter with no matching leads row;
--     different failure, needs its own trace
--   * Logan Temple rs-1/bo+1 and the three markers whose canvasser_id no
--     longer resolves (Steele, Brett Pool, Sonny Singh)
--   * Every legit re-run (Ortega, Flores, Libiran, Adams, Vahdat, Moline,
--     Flemming, Durga) — the board really does hold two cards for those
--
-- Safety: each target is matched on pulse + bucket + metric_date, so a
-- marker that has since moved is skipped rather than mis-decremented;
-- counters floor at 0; markers are RENAMED to Card_Outcome_Reverted with a
-- NULL bucket (never deleted) so they neither count nor poison the next
-- transition. Idempotent via the Manual_Correction tag.
-- Run in the xogit (xogitpqeuwalerxygvjw) SQL editor.

BEGIN;

DO $$
DECLARE
  r record;
  v_canv uuid;
  v_office text;
  v_applied jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_leads int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.webhook_logs
             WHERE step = 'Manual_Correction'
               AND data->>'tag' = 'week0824-dedupe-20260831') THEN
    RAISE NOTICE 'week0824-dedupe-20260831 already applied';
    RETURN;
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      -- pulse to un-count, bucket, day it was counted on, who/what (audit only)
      ('12883878439', 'blowouts', DATE '2026-08-25', 'Ernie Ruiz',     'Mike and Patti Frugone'),
      ('12896143077', 'ctc',      DATE '2026-08-26', 'Ernie Ruiz',     'Julia and Michael Rugnetta'),
      ('12917265653', 'sales',    DATE '2026-08-28', 'Ernie Ruiz',     'Kathy Potter (widow)'),
      ('12923340538', 'blowouts', DATE '2026-08-29', 'Ernie Ruiz',     'Torre and Alysa Spencer'),
      ('12927849745', 'ctc',      DATE '2026-08-29', 'Ernie Ruiz',     'Jacki and John Congdon'),
      ('12888232397', 'sit',      DATE '2026-08-25', 'Eduardo ordaz',  'Martha and Deb Rankin'),
      ('12926217849', 'ctc',      DATE '2026-08-28', 'Eduardo ordaz',  'Steve and Cathy Miller'),
      ('12872903299', 'sit',      DATE '2026-08-24', 'Eric Iriqui',    'Rockwell, Doug & Emily'),
      ('12925176942', 'blowouts', DATE '2026-08-29', 'Jose Miranda',   'Katie & Mr Dominick'),
      ('12885778444', 'blowouts', DATE '2026-08-25', 'Kieran Oconnor', 'Margaret Santalahti'),
      ('12924232191', 'ctc',      DATE '2026-08-29', 'Dan Lima',       'Barbaro, Brett and spouse'),
      ('12915457172', 'ctc',      DATE '2026-08-28', 'Marcel',         'Donna Hoover (widowed)'),
      ('12924537187', 'ctc',      DATE '2026-08-29', 'Nate Hernandez', 'Edgar and Jose Muniz'),
      ('12882672198', 'sit',      DATE '2026-08-24', 'Stephen Tonkin', 'Jamie & Valentine Brockamp'),
      ('12897129522', 'sales',    DATE '2026-08-30', 'Stephen Tonkin', 'Jamie & Valentine Brockamp')
    ) AS t(pulse, bucket, day, who, customer)
  LOOP
    SELECT (w.data->>'canvasser_id')::uuid, COALESCE(w.data->>'office_location','San Diego')
      INTO v_canv, v_office
      FROM public.webhook_logs w
     WHERE w.step = 'Card_Outcome_Recorded'
       AND w.data->>'pulseId' = r.pulse
       AND w.data->>'bucket' = r.bucket
       AND (w.data->>'metric_date')::date = r.day
     ORDER BY w.created_at DESC LIMIT 1;

    IF v_canv IS NULL THEN
      v_skipped := v_skipped || jsonb_build_object('pulse', r.pulse, 'who', r.who,
                     'customer', r.customer, 'why', 'no live marker at that bucket/day');
      CONTINUE;
    END IF;

    -- Payroll / Weekly-Results feed. A sale also implies its sit.
    IF r.bucket = 'sit' THEN
      UPDATE public.daily_logs SET demos_sits = GREATEST(0, demos_sits - 1)
       WHERE canvasser_id = v_canv AND log_date = r.day AND office_location = v_office;
    ELSIF r.bucket = 'sales' THEN
      UPDATE public.daily_logs SET demos_sits = GREATEST(0, demos_sits - 1),
                                   sales      = GREATEST(0, sales - 1)
       WHERE canvasser_id = v_canv AND log_date = r.day AND office_location = v_office;
    ELSIF r.bucket = 'blowouts' THEN
      UPDATE public.daily_logs SET no_demo = GREATEST(0, no_demo - 1)
       WHERE canvasser_id = v_canv AND log_date = r.day AND office_location = v_office;
    ELSIF r.bucket = 'ctc' THEN
      UPDATE public.daily_logs SET ctc = GREATEST(0, ctc - 1)
       WHERE canvasser_id = v_canv AND log_date = r.day AND office_location = v_office;
    ELSIF r.bucket = 'resets' THEN
      UPDATE public.daily_logs SET future_leads = GREATEST(0, future_leads - 1)
       WHERE canvasser_id = v_canv AND log_date = r.day AND office_location = v_office;
    END IF;

    -- Day tiles (CTC has no daily_metrics mirror; Sit lives in pitch_missed).
    IF r.bucket = 'sit' THEN
      UPDATE public.daily_metrics SET pitch_missed = GREATEST(0, pitch_missed - 1)
       WHERE canvasser_id = v_canv AND metric_date = r.day;
    ELSIF r.bucket = 'sales' THEN
      UPDATE public.daily_metrics SET sales = GREATEST(0, sales - 1)
       WHERE canvasser_id = v_canv AND metric_date = r.day;
    ELSIF r.bucket = 'blowouts' THEN
      UPDATE public.daily_metrics SET blowouts = GREATEST(0, blowouts - 1)
       WHERE canvasser_id = v_canv AND metric_date = r.day;
    ELSIF r.bucket = 'resets' THEN
      UPDATE public.daily_metrics SET resets = GREATEST(0, resets - 1)
       WHERE canvasser_id = v_canv AND metric_date = r.day;
    END IF;

    UPDATE public.webhook_logs
       SET step = 'Card_Outcome_Reverted',
           data = data || jsonb_build_object('bucket', NULL, 'reverted', true,
                    'revert_tag', 'week0824-dedupe-20260831',
                    'revert_reason', 'duplicate of the same appointment on another pulse')
     WHERE step = 'Card_Outcome_Recorded'
       AND data->>'pulseId' = r.pulse
       AND data->>'bucket' = r.bucket
       AND (data->>'metric_date')::date = r.day;

    v_applied := v_applied || jsonb_build_object('who', r.who, 'customer', r.customer,
                   'bucket', r.bucket, 'day', to_char(r.day, 'YYYY-MM-DD'));
  END LOOP;

  -- The two duplicate sale leads (volume + commission). Voided, never
  -- deleted, and each only while its surviving twin is still confirmed for
  -- the same amount — so a re-run or a half-applied state can never leave
  -- the customer with no lead at all.
  --   Kathy Potter (widow)   $8,278  keep #12906196100 (8/27, board day)
  --                                  void #12917265653 (8/28, the copy)
  --   Jamie & V. Brockamp   $82,211  keep #12867931355 (8/25, board day)
  --                                  void #12897129522 (8/30, the copy)
  FOR r IN
    SELECT * FROM (VALUES
      ('12917265653', '12906196100'),
      ('12897129522', '12867931355')
    ) AS t(void_item, keep_item)
  LOOP
    UPDATE public.leads v
       SET status = 'denied',
           deny_reason = 'Duplicate copy card — week0824-dedupe-20260831'
      FROM public.leads k
     WHERE v.monday_item_id = r.void_item AND v.status = 'confirmed'
       AND k.monday_item_id = r.keep_item AND k.status = 'confirmed'
       AND k.sale_amount = v.sale_amount;
    IF FOUND THEN v_leads := v_leads + 1; END IF;
  END LOOP;

  INSERT INTO public.webhook_logs (step, data) VALUES ('Manual_Correction',
    jsonb_build_object('tag', 'week0824-dedupe-20260831',
      'applied', v_applied, 'skipped', v_skipped, 'leads_voided', v_leads));
END $$;

COMMIT;

-- The dashboard editor swallows RAISE NOTICE — read the outcome here:
SELECT jsonb_array_length(data->'applied') AS outcomes_removed,
       (data->>'leads_voided') AS leads_voided,
       jsonb_array_length(data->'skipped') AS skipped
  FROM public.webhook_logs
 WHERE step = 'Manual_Correction' AND data->>'tag' = 'week0824-dedupe-20260831';
