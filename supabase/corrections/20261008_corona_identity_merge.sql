-- "Sam Corona" and "Samuel Corona" are the same person (owner confirmed
-- 2026-10-08; the 2026-10-01 handle mapping in 20261004120000_activity_tests
-- already said so). Keep him as "Samuel Corona" everywhere.
--
-- There is exactly ONE profile (5433a126…, auth-backed, display_name
-- "Sam Corona") — no duplicate profile rows, so this is NOT a
-- merge_canvassers job. The split lives in the name-keyed surfaces:
-- every Monday-fed row says "Samuel Corona" (block_cards.reps ×134,
-- report_reps ×16, report_sales ×19, production_jobs ×5, rep_photos,
-- lead_issued_notifications) while everything that snapshots
-- profiles.display_name says "Sam Corona" — most visibly the Close Kombat
-- contest_ledger, where his board points sit under "Samuel Corona" and his
-- 2026-10-08 before/after proof point sits under "Sam Corona" as a second
-- fighter row (kombat-month.functions.ts takes rep_name straight from the
-- profile at approval time).
--
-- Fix, in the rename_canvasser shape but runnable from the SQL editor
-- (no auth.uid() here, so the RPC itself would refuse):
--   1. profiles.display_name → 'Samuel Corona' (now exact-matches the
--      board, so the rep-identity ladder and the Bouncer's exact tier both
--      bind without leaning on tier 3).
--   2. canvasser_aliases: 'sam corona' → his profile, so a future Monday
--      event carrying the old spelling routes to him instead of minting a
--      placeholder; any stale alias claiming 'samuel corona' is cleared
--      first (live bearer outranks alias — same rule as rename_canvasser).
--   3. contest_ledger / ooh_report_queue / ooh_dispatch_decisions /
--      respawn_requests / hype_events: rewrite the 'Sam Corona' snapshots.
--      contest_ledger respects the (source_kind, source_id, rep_name,
--      category) unique key — a row whose rename would collide is left
--      alone and reported instead of exploding mid-transaction.
--
-- block_cards.reps/agent and the other Monday-raw columns already carry the
-- surviving name and are untouched (sales standings follow Monday — same
-- scope rule as 20260816010000_canvasser_rename_merge).
--
-- Idempotent via the Manual_Correction tag. Run in the xogit
-- (xogitpqeuwalerxygvjw) SQL editor.

BEGIN;

DO $$
DECLARE
  v_profile uuid;
  v_n int;
  v_counts jsonb := '{}'::jsonb;
  v_ledger_skipped int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.webhook_logs
             WHERE step = 'Manual_Correction'
               AND data->>'tag' = 'corona-identity-merge-20261008') THEN
    RAISE NOTICE 'corona-identity-merge-20261008 already applied';
    RETURN;
  END IF;

  -- Serialize with rename/merge RPCs so alias bookkeeping can't race.
  PERFORM pg_advisory_xact_lock(hashtext('canvasser_identity'));

  -- The one Corona profile, pinned by id AND name so a re-run against a
  -- drifted database aborts instead of renaming a stranger.
  SELECT id INTO v_profile FROM public.profiles
  WHERE id = '5433a126-9ee8-418e-8f0a-d02a66c0a1ff'
    AND public.normalize_display_name(display_name)
        IN ('sam corona', 'samuel corona');
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'Expected profile 5433a126… named Sam/Samuel Corona — aborting';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles
             WHERE public.normalize_display_name(display_name) = 'samuel corona'
               AND id <> v_profile) THEN
    RAISE EXCEPTION 'Another profile already bears "Samuel Corona" — aborting';
  END IF;

  -- 1) The profile becomes the live bearer of the board name…
  UPDATE public.profiles
  SET display_name = 'Samuel Corona', updated_at = now()
  WHERE id = v_profile
    AND display_name IS DISTINCT FROM 'Samuel Corona';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('profiles_renamed', v_n);

  -- …so any alias shadowing that name must go (it would outrank him in the
  -- edge matcher), and the old spelling becomes his alias — unless some
  -- other live profile still bears it, in which case stealing their events
  -- would be worse than minting a placeholder.
  DELETE FROM public.canvasser_aliases WHERE alias_norm = 'samuel corona';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('aliases_cleared', v_n);

  IF NOT EXISTS (SELECT 1 FROM public.profiles
                 WHERE public.normalize_display_name(display_name) = 'sam corona'
                   AND id <> v_profile) THEN
    INSERT INTO public.canvasser_aliases (alias_norm, alias_raw, profile_id, source)
    VALUES ('sam corona', 'Sam Corona', v_profile, 'rename')
    ON CONFLICT (alias_norm) DO UPDATE
      SET profile_id = EXCLUDED.profile_id,
          alias_raw  = EXCLUDED.alias_raw,
          source     = EXCLUDED.source,
          updated_at = now();
    v_counts := v_counts || jsonb_build_object('alias_recorded', true);
  ELSE
    v_counts := v_counts || jsonb_build_object('alias_recorded', false);
  END IF;

  -- 2) Denormalized name snapshots follow the person.
  UPDATE public.hype_events SET canvasser_name = 'Samuel Corona'
  WHERE canvasser_id = v_profile AND canvasser_name <> 'Samuel Corona';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('hype_events', v_n);

  UPDATE public.contest_ledger l SET rep_name = 'Samuel Corona'
  WHERE l.rep_name = 'Sam Corona'
    AND NOT EXISTS (SELECT 1 FROM public.contest_ledger k
                    WHERE k.rep_name = 'Samuel Corona'
                      AND k.source_kind = l.source_kind
                      AND k.source_id = l.source_id
                      AND k.category = l.category);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('contest_ledger', v_n);
  SELECT count(*) INTO v_ledger_skipped
  FROM public.contest_ledger WHERE rep_name = 'Sam Corona';
  v_counts := v_counts || jsonb_build_object('contest_ledger_skipped', v_ledger_skipped);

  UPDATE public.ooh_report_queue SET rep_name = 'Samuel Corona'
  WHERE rep_name = 'Sam Corona';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('ooh_report_queue', v_n);

  UPDATE public.ooh_dispatch_decisions SET rep_name = 'Samuel Corona'
  WHERE rep_name = 'Sam Corona';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('ooh_dispatch_decisions', v_n);

  UPDATE public.respawn_requests SET rep_name = 'Samuel Corona'
  WHERE rep_name = 'Sam Corona';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('respawn_requests', v_n);

  INSERT INTO public.webhook_logs (step, data) VALUES ('Manual_Correction',
    jsonb_build_object('tag', 'corona-identity-merge-20261008',
      'profile_id', v_profile, 'kept_name', 'Samuel Corona',
      'counts', v_counts));
END $$;

COMMIT;

-- The dashboard editor swallows RAISE NOTICE — read the outcome here:
SELECT data->'counts' AS counts
FROM public.webhook_logs
WHERE step = 'Manual_Correction'
  AND data->>'tag' = 'corona-identity-merge-20261008';
