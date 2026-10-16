-- ═══════════════════════════════════════════════════════════════════════════
-- BULK DUPLICATE MERGE (conversion audit 2026-10-15, Phase 1 §1).
-- Executes EXACTLY the plan printed by 20261015_dupe_dry_run.sql — run the
-- dry run first and eyeball every 2_MERGE group. The grouping CTEs and the
-- keeper rule here are TWINS of that file: change them together.
--
-- Prereq: 20261027120000_merge_canvassers_v2.sql applied (v2 merge function,
-- fold_display_name, profiles.non_person). Irreversible for the merged rows
-- (same as any merge_canvassers call); each group runs in its own
-- subtransaction, so one bad group (e.g. an inactive keeper) is reported and
-- skipped instead of aborting the batch.
--
--   1. Flags non-person rows (lead-source channels, "Test", compound
--      "A & B" names) non_person = true. They stay creditable by the Monday
--      webhook but disappear from rosters, leaderboards and View As.
--   2. Merges every accent-folded same-name group (Levon Gukasyan ×4,
--      Cris Lopez/López ×5, Jose Miranda ×3, Devhante ×4, Arturo Delgado
--      Mora ×2, Kieran Oconnor case twins, Eduardo Ordaz case twins, …) plus
--      the audit-confirmed typo pairs in TYPO_MAP. Keeper = login first,
--      then active, then non-placeholder, then oldest. Losers' names become
--      canvasser_aliases, so future Monday cards credit the keeper.
--
-- Idempotent via the Manual_Correction tag. Re-running after a partial
-- apply is safe only by removing the tag row first — but merged groups
-- simply no longer group, so a second pass is a no-op for them.
--
-- Run: supabase db query --linked --file supabase/corrections/20261015_bulk_merge.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_n int;
  v_flagged int := 0;
  v_grp record;
  v_ids uuid[];
  v_keeper uuid;
  v_losers uuid[];
  v_result jsonb;
  v_groups jsonb := '[]'::jsonb;
  v_failures jsonb := '[]'::jsonb;
  v_merged int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.webhook_logs
             WHERE step = 'Manual_Correction'
               AND data->>'tag' = 'phase1-bulk-merge-20261015') THEN
    RAISE NOTICE 'phase1-bulk-merge-20261015 already applied';
    RETURN;
  END IF;

  -- Serialize with single merges/renames from the app.
  PERFORM pg_advisory_xact_lock(hashtext('canvasser_identity'));

  -- ── 1) Non-person rows. TWIN of the dry run's non_person predicate. ───────
  UPDATE public.profiles p
  SET non_person = true, updated_at = now()
  WHERE p.merged_into IS NULL
    AND NOT COALESCE(p.non_person, false)
    AND (
      public.is_pseudo_source_name(p.display_name)
      OR public.normalize_display_name(p.display_name) = 'test'
      OR p.display_name LIKE '%&%'
    );
  GET DIAGNOSTICS v_flagged = ROW_COUNT;

  -- ── 2) Merge groups. CTEs are TWINS of the dry run. ───────────────────────
  FOR v_grp IN
    WITH typo_map (wrong_key, right_key) AS (
      VALUES
        ('ernie euiz',   'ernie ruiz'),
        ('eduardo orda', 'eduardo ordaz')
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
      -- keep_name NULL: the keeper's current display name survives; losers'
      -- spellings become aliases inside merge_canvassers.
      v_result := public.merge_canvassers(v_losers, v_keeper, NULL);
      v_merged := v_merged + 1;
      v_groups := v_groups || jsonb_build_object(
        'group', v_grp.grp,
        'keeper', v_keeper,
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
      'tag', 'phase1-bulk-merge-20261015',
      'non_person_flagged', v_flagged,
      'groups_merged', v_merged,
      'groups', v_groups,
      'failures', v_failures));
END $$;

COMMIT;

-- The dashboard editor swallows RAISE NOTICE — read the outcome here.
-- 'failures' lists groups that were skipped (fix the stated reason, delete
-- the tag row, re-run; already-merged groups no-op).
SELECT data->>'non_person_flagged' AS non_person_flagged,
       data->>'groups_merged' AS groups_merged,
       jsonb_pretty(data->'failures') AS failures
FROM public.webhook_logs
WHERE step = 'Manual_Correction'
  AND data->>'tag' = 'phase1-bulk-merge-20261015';
