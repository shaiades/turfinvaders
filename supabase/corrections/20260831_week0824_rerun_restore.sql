-- Week of 8/24 — restore the re-run outcomes the old netting swallowed
-- (authored 2026-08-31; companion to PR #131's sameStateRerun fix, which
-- only covers events from the cutover forward).
--
-- A reset that ran again is TWO cards on the Block board (the Reset card
-- plus the outcome card) and the marketing report counts both; the old
-- webhook applied the second mark as a transition and decremented the
-- Reset. Verified per family against Monday's activity log: each restored
-- row below is a board card whose outcome the app no longer holds. Grace
-- Barnett is handled by 20260831_barnett_saturday_rehash.sql, NOT here.
--
-- Self-guarding: a row is skipped when its card's pulse already carries a
-- Card_Outcome_Recorded marker (i.e. the app DID count it — protects
-- against any reconstruction error). Idempotent via a Manual_Correction
-- tag. Resets/blowouts carry no points or pay.
-- APPLIED 2026-08-31: 10 rows restored, 2 skipped by the guard (Chris &
-- Dawn Moline and Veronica and kaine Flores already carried markers).
-- After it, Alex Depalma / Cynthia King / Ian Ryan / Miguel Munoz / Renat
-- Kogay match the block board exactly. Re-running is a no-op.
-- Run in the xogit (xogitpqeuwalerxygvjw) SQL editor.

BEGIN;

DO $$
DECLARE
  r record;
  v_canv uuid;
  v_team uuid;
  v_applied jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.webhook_logs
             WHERE step = 'Manual_Correction'
               AND data->>'tag' = 'week0824-rerun-restore-20260831') THEN
    RAISE NOTICE 'week0824-rerun-restore-20260831 already applied — nothing to do';
    RETURN;
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      -- customer, office, dropped card pulse, agent, bucket, block day, group
      ('Chris & Dawn Moline',        'Orange County', '12916441422', 'Logan Temple',  'resets',   DATE '2026-08-27', 'Thursday'),
      ('Fred and Mrs Vahdat',        'Orange County', '12898872217', 'Kieran Oconnor','resets',   DATE '2026-08-25', 'Tuesday'),
      ('Rockwell, Doug & Emily',     'San Diego',     '12888424435', 'Eric Iriqui',   'resets',   DATE '2026-08-24', 'Monday'),
      ('Veronica and kaine Flores',  'San Diego',     '12895361706', 'Cynthia King',  'resets',   DATE '2026-08-25', 'Tuesday'),
      ('Pam & Steve Adams',          'San Diego',     '12906531137', 'Ian Ryan',      'resets',   DATE '2026-08-26', 'Wednesday'),
      ('Pam & Steve Adams',          'San Diego',     '12924830635', 'Ian Ryan',      'resets',   DATE '2026-08-27', 'Thursday'),
      ('Aida Libiran widowed',       'San Diego',     '12904778070', 'Ernie Ruiz',    'resets',   DATE '2026-08-26', 'Wednesday'),
      ('Alma Hope and Jamie',        'San Diego',     '12883749802', 'Marcel',        'resets',   DATE '2026-08-24', 'Monday'),
      -- Durga Wed card is Iss="Not Issued" on the board but its Reset is a
      -- marked outcome; restored to match the board tally. Revert if the
      -- office rules Not-Issued cards out.
      ('G, Durga and spouse',        'San Diego',     '12904950960', 'Renat Kogay',   'resets',   DATE '2026-08-26', 'Wednesday'),
      ('G, Durga and spouse',        'San Diego',     '12918440721', 'Renat Kogay',   'resets',   DATE '2026-08-27', 'Thursday'),
      ('Angelo and Arndi Ortega',    'San Diego',     '12925552430', 'Alex Depalma',  'resets',   DATE '2026-08-28', 'Friday'),
      ('Loraine & Lillian Flemming', 'San Diego',     '12914715225', 'Miguel Munoz',  'blowouts', DATE '2026-08-27', 'Thursday')
    ) AS t(customer, office, pulse, agent, bucket, day, grp)
  LOOP
    -- The app already holds an outcome for this exact card → nothing dropped.
    IF EXISTS (SELECT 1 FROM public.webhook_logs
               WHERE step = 'Card_Outcome_Recorded'
                 AND data->>'pulseId' = r.pulse) THEN
      v_skipped := v_skipped || jsonb_build_object('customer', r.customer, 'pulse', r.pulse);
      CONTINUE;
    END IF;

    -- Resolve the canvasser the way the webhook does: exact normalized
    -- display name → recorded alias → unique prefix.
    SELECT id, team_id INTO v_canv, v_team FROM public.profiles
     WHERE lower(regexp_replace(trim(display_name), '\s+', ' ', 'g'))
         = lower(r.agent) LIMIT 1;
    IF v_canv IS NULL THEN
      SELECT p.id, p.team_id INTO v_canv, v_team
        FROM public.canvasser_aliases a JOIN public.profiles p ON p.id = a.canvasser_id
       WHERE a.alias_norm = lower(regexp_replace(trim(r.agent), '\s+', ' ', 'g'))
       LIMIT 1;
    END IF;
    IF v_canv IS NULL THEN
      IF (SELECT count(*) FROM public.profiles
           WHERE lower(display_name) LIKE lower(r.agent) || '%') = 1 THEN
        SELECT id, team_id INTO v_canv, v_team FROM public.profiles
         WHERE lower(display_name) LIKE lower(r.agent) || '%';
      ELSE
        RAISE EXCEPTION 'agent "%" does not resolve to exactly one profile (row %)',
          r.agent, r.customer;
      END IF;
    END IF;

    -- Payroll/Weekly-Results feed: resets → future_leads, blowouts → no_demo.
    INSERT INTO public.daily_logs (canvasser_id, team_id, log_date, office_location)
    VALUES (v_canv, v_team, r.day, r.office)
    ON CONFLICT (canvasser_id, log_date, office_location) DO NOTHING;
    IF r.bucket = 'resets' THEN
      UPDATE public.daily_logs SET future_leads = COALESCE(future_leads, 0) + 1
       WHERE canvasser_id = v_canv AND log_date = r.day AND office_location = r.office;
    ELSE
      UPDATE public.daily_logs SET no_demo = COALESCE(no_demo, 0) + 1
       WHERE canvasser_id = v_canv AND log_date = r.day AND office_location = r.office;
    END IF;

    -- Day tiles.
    IF r.bucket = 'resets' THEN
      INSERT INTO public.daily_metrics (canvasser_id, metric_date, office_location, resets)
      VALUES (v_canv, r.day, r.office, 1)
      ON CONFLICT (canvasser_id, metric_date) DO UPDATE
        SET resets = COALESCE(public.daily_metrics.resets, 0) + 1;
    ELSE
      INSERT INTO public.daily_metrics (canvasser_id, metric_date, office_location, blowouts)
      VALUES (v_canv, r.day, r.office, 1)
      ON CONFLICT (canvasser_id, metric_date) DO UPDATE
        SET blowouts = COALESCE(public.daily_metrics.blowouts, 0) + 1;
    END IF;

    -- Marker so future flips on this card transition cleanly and replays no-op.
    INSERT INTO public.webhook_logs (step, data) VALUES ('Card_Outcome_Recorded',
      jsonb_build_object(
        'pulseId', r.pulse, 'bucket', r.bucket, 'nonCore', false, 'prev', NULL,
        'canvasser_id', v_canv,
        'metric_date', to_char(r.day, 'YYYY-MM-DD'),
        'office_location', r.office,
        'blockDay', to_char(r.day, 'YYYY-MM-DD'), 'groupTitle', r.grp,
        'itemName', r.customer,
        'note', 'manual correction week0824-rerun-restore-20260831'));

    v_applied := v_applied || jsonb_build_object(
      'customer', r.customer, 'agent', r.agent, 'bucket', r.bucket,
      'day', to_char(r.day, 'YYYY-MM-DD'));
  END LOOP;

  INSERT INTO public.webhook_logs (step, data) VALUES ('Manual_Correction',
    jsonb_build_object('tag', 'week0824-rerun-restore-20260831',
      'applied', v_applied, 'skipped', v_skipped));
END $$;

COMMIT;

-- The dashboard editor swallows RAISE NOTICE — read the outcome here:
SELECT jsonb_pretty(data) AS result
  FROM public.webhook_logs
 WHERE step = 'Manual_Correction'
   AND data->>'tag' = 'week0824-rerun-restore-20260831';
