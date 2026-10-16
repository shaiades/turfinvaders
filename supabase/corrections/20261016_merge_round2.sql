-- ═══════════════════════════════════════════════════════════════════════════
-- DUPLICATE MERGE, ROUND 2 (owner-confirmed 2026-10-16).
-- Round 1 (20261015_bulk_merge.sql) merged 6 groups and skipped 7 whose
-- keeper is an inactive ex-employee (merge_canvassers refuses inactive
-- keepers). The owner confirmed:
--   · merge those 7 anyway — each keeper is REACTIVATED for the merge and
--     re-archived right after, so nobody reappears on boards;
--   · four near-miss pairs from the dry run are the same person:
--       abdi zakirov ≙ abdi zokirov        bate ≙ nate hernandez
--       emilio ≙ emilio e camarena         levon gukayan ≙ levon gukasyan
--     (mapping direction only affects grouping — the keeper rule still
--     picks the login/oldest profile, and keep_name NULL keeps ITS name.)
--
-- Same twin CTEs as round 1; already-merged groups simply no longer group.
-- Idempotent via the Manual_Correction tag.
-- Run: supabase db query --linked --file supabase/corrections/20261016_merge_round2.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_grp record;
  v_ids uuid[];
  v_keeper uuid;
  v_losers uuid[];
  v_keeper_was_inactive boolean;
  v_result jsonb;
  v_groups jsonb := '[]'::jsonb;
  v_failures jsonb := '[]'::jsonb;
  v_merged int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.webhook_logs
             WHERE step = 'Manual_Correction'
               AND data->>'tag' = 'phase1-merge-round2-20261016') THEN
    RAISE NOTICE 'phase1-merge-round2-20261016 already applied';
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('canvasser_identity'));

  FOR v_grp IN
    WITH typo_map (wrong_key, right_key) AS (
      VALUES
        -- round 1
        ('ernie euiz',       'ernie ruiz'),
        ('eduardo orda',     'eduardo ordaz'),
        -- round 2, owner-confirmed 2026-10-16
        ('abdi zakirov',     'abdi zokirov'),
        ('bate hernandez',   'nate hernandez'),
        ('emilio camarena',  'emilio e camarena'),
        ('levon gukayan',    'levon gukasyan')
    ),
    persons AS (
      SELECT
        p.id,
        p.display_name,
        COALESCE(tm.right_key, public.fold_display_name(p.display_name)) AS grp,
        EXISTS (SELECT 1 FROM auth.users au WHERE au.id = p.id) AS has_login,
        COALESCE(p.is_placeholder, false) AS is_placeholder,
        COALESCE(p.is_active, true) AS is_active,
        p.created_at
      FROM public.profiles p
      LEFT JOIN typo_map tm
        ON tm.wrong_key = public.fold_display_name(p.display_name)
      WHERE p.merged_into IS NULL
        AND p.display_name IS NOT NULL
        AND btrim(p.display_name) <> ''
        AND NOT COALESCE(p.non_person, false)
        AND NOT public.is_pseudo_source_name(p.display_name)
    )
    SELECT grp,
           array_agg(id ORDER BY has_login DESC, is_active DESC,
                     is_placeholder ASC, created_at ASC) AS ids,
           array_agg(display_name ORDER BY has_login DESC, is_active DESC,
                     is_placeholder ASC, created_at ASC) AS names
    FROM persons
    GROUP BY grp
    HAVING count(*) > 1
    ORDER BY grp
  LOOP
    v_ids := v_grp.ids;
    v_keeper := v_ids[1];
    v_losers := v_ids[2:];

    BEGIN
      -- Ex-employee keeper: reactivate for the merge, re-archive after —
      -- the merge requires an active keeper, the boards require them gone.
      SELECT NOT COALESCE(is_active, true) INTO v_keeper_was_inactive
      FROM public.profiles WHERE id = v_keeper;
      IF v_keeper_was_inactive THEN
        UPDATE public.profiles SET is_active = true WHERE id = v_keeper;
      END IF;

      v_result := public.merge_canvassers(v_losers, v_keeper, NULL);

      IF v_keeper_was_inactive THEN
        UPDATE public.profiles SET is_active = false, team_id = NULL
        WHERE id = v_keeper;
      END IF;

      v_merged := v_merged + 1;
      v_groups := v_groups || jsonb_build_object(
        'group', v_grp.grp,
        'keeper', v_keeper,
        'keeper_was_inactive', v_keeper_was_inactive,
        'names', to_jsonb(v_grp.names),
        'result', v_result);
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures || jsonb_build_object(
        'group', v_grp.grp,
        'names', to_jsonb(v_grp.names),
        'error', SQLERRM);
    END;
  END LOOP;

  INSERT INTO public.webhook_logs (step, data) VALUES ('Manual_Correction',
    jsonb_build_object(
      'tag', 'phase1-merge-round2-20261016',
      'groups_merged', v_merged,
      'groups', v_groups,
      'failures', v_failures));
END $$;

COMMIT;

SELECT data->>'groups_merged' AS groups_merged,
       jsonb_pretty(data->'failures') AS failures
FROM public.webhook_logs
WHERE step = 'Manual_Correction'
  AND data->>'tag' = 'phase1-merge-round2-20261016';
