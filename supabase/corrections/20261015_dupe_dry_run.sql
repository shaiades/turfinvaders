-- ═══════════════════════════════════════════════════════════════════════════
-- DUPLICATE-PROFILE DRY RUN (conversion audit 2026-10-15, Phase 1 §1).
-- READ-ONLY — changes nothing. Run it, eyeball every group, then run
-- supabase/corrections/20261015_bulk_merge.sql, which executes EXACTLY the
-- plan this prints (same grouping SQL, same keeper rule — keep the two files
-- in sync).
--
-- Requires 20261027120000_merge_canvassers_v2.sql (fold_display_name,
-- unaccent, fuzzystrmatch, profiles.non_person) to be applied first.
--
-- Run: supabase db query --linked --file supabase/corrections/20261015_dupe_dry_run.sql
--
-- Sections in the output (one result set):
--   1_NON_PERSON   rows the bulk script will flag non_person = true (hidden
--                  from rosters/leaderboards/View As; webhook still credits
--                  them): lead-source channels, "Test", and compound
--                  "A & B" attribution rows.
--   2_MERGE        duplicate groups by accent-folded normalized name, plus
--                  the two audit-confirmed typo pairs (Ernie Euiz → Ernie
--                  Ruiz, Eduardo Orda → Eduardo Ordaz). role=KEEPER absorbs
--                  the role=loser rows; aliases are recorded so future
--                  Monday names resolve to the keeper.
--   3_REVIEW       fold-keys within levenshtein distance 2 of each other —
--                  possibly the same person, NOT auto-merged. Confirm with
--                  the field, then add the pair to TYPO_MAP in both files.
-- ═══════════════════════════════════════════════════════════════════════════

WITH
-- Audit-confirmed typo pairs: fold-key of the misspelling → fold-key of the
-- real name. TWIN of TYPO_MAP in 20261015_bulk_merge.sql.
typo_map (wrong_key, right_key) AS (
  VALUES
    ('ernie euiz',   'ernie ruiz'),
    ('eduardo orda', 'eduardo ordaz')
),
-- Non-person detection. TWIN of the UPDATE in 20261015_bulk_merge.sql.
base AS (
  SELECT
    p.id,
    p.display_name,
    public.fold_display_name(p.display_name) AS fold_key,
    EXISTS (SELECT 1 FROM auth.users au WHERE au.id = p.id) AS has_login,
    COALESCE(p.is_placeholder, false) AS is_placeholder,
    COALESCE(p.is_active, true) AS is_active,
    p.created_at,
    (
      public.is_pseudo_source_name(p.display_name)
      OR public.normalize_display_name(p.display_name) = 'test'
      OR p.display_name LIKE '%&%'
      OR COALESCE(p.non_person, false)
    ) AS non_person
  FROM public.profiles p
  WHERE p.merged_into IS NULL
    AND p.display_name IS NOT NULL
    AND btrim(p.display_name) <> ''
),
stats AS (
  SELECT
    b.id,
    COALESCE(dl.doors, 0)  AS doors,
    COALESCE(ld.leads, 0)  AS leads,
    COALESCE(dl.sales, 0)  AS sales,
    GREATEST(dl.last_log, ld.last_lead) AS last_activity
  FROM base b
  LEFT JOIN LATERAL (
    SELECT sum(doors_knocked)::bigint AS doors,
           sum(sales)::bigint AS sales,
           max(log_date) AS last_log
    FROM public.daily_logs WHERE canvasser_id = b.id
  ) dl ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::bigint AS leads, max(created_at)::date AS last_lead
    FROM public.leads WHERE canvasser_id = b.id
  ) ld ON true
),
persons AS (
  SELECT b.*, COALESCE(tm.right_key, b.fold_key) AS grp
  FROM base b
  LEFT JOIN typo_map tm ON tm.wrong_key = b.fold_key
  WHERE NOT b.non_person
),
-- Keeper rule (TWIN of the bulk script): login first, then active, then
-- real (non-placeholder) rows, then oldest.
ranked AS (
  SELECT p.*,
         row_number() OVER (
           PARTITION BY p.grp
           ORDER BY p.has_login DESC, p.is_active DESC,
                    p.is_placeholder ASC, p.created_at ASC
         ) AS pos,
         count(*) OVER (PARTITION BY p.grp) AS group_size
  FROM persons p
),
review_pairs AS (
  SELECT a.grp AS grp_a, b.grp AS grp_b
  FROM (SELECT DISTINCT grp FROM persons) a
  JOIN (SELECT DISTINCT grp FROM persons) b
    ON a.grp < b.grp
   AND length(a.grp) >= 8
   AND abs(length(a.grp) - length(b.grp)) <= 2
   AND extensions.levenshtein(a.grp, b.grp) <= 2
)
SELECT * FROM (
  -- 1) non-person flags
  SELECT
    '1_NON_PERSON' AS section,
    b.fold_key     AS grp,
    'FLAG non_person' AS role,
    b.id::text     AS profile_id,
    b.display_name,
    b.has_login, b.is_placeholder, b.is_active,
    s.doors, s.leads, s.sales, s.last_activity,
    CASE WHEN public.is_pseudo_source_name(b.display_name)
         THEN 'lead-source channel (already shielded from merge/rename)'
         WHEN b.display_name LIKE '%&%'
         THEN 'compound attribution row — stays creditable, hidden from game'
         ELSE 'test/non-person row' END AS note
  FROM base b JOIN stats s ON s.id = b.id
  WHERE b.non_person

  UNION ALL

  -- 2) merge plan
  SELECT
    '2_MERGE',
    r.grp,
    CASE WHEN r.pos = 1 THEN 'KEEPER' ELSE 'loser → keeper' END,
    r.id::text,
    r.display_name,
    r.has_login, r.is_placeholder, r.is_active,
    s.doors, s.leads, s.sales, s.last_activity,
    CASE
      WHEN r.pos = 1 AND NOT r.is_active
        THEN '⚠ keeper inactive — reactivate before running the bulk merge'
      WHEN r.pos = 1 THEN 'absorbs ' || (r.group_size - 1) || ' row(s)'
      WHEN r.fold_key <> r.grp THEN 'typo-pair member (TYPO_MAP)'
      ELSE ''
    END
  FROM ranked r JOIN stats s ON s.id = r.id
  WHERE r.group_size > 1

  UNION ALL

  -- 3) near-miss names for human review
  SELECT
    '3_REVIEW',
    rp.grp_a || '  ≈  ' || rp.grp_b,
    'review',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    'levenshtein ≤ 2 — confirm with the field, then add to TYPO_MAP'
  FROM review_pairs rp
) out
ORDER BY section, grp,
         CASE WHEN role IN ('KEEPER', 'FLAG non_person', 'review') THEN 0 ELSE 1 END,
         display_name;
