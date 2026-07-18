#!/usr/bin/env bash
# Extract import artifacts from the local copy:
#   public_data.sql, auth_users.csv, auth_identities.csv,
#   auth_*.cols (column lists), baseline_counts.txt
# Needs DEST_DB_URL to compute the source∩destination auth column lists.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/env.sh"
DEST_DB_URL="${DEST_DB_URL:?set DEST_DB_URL to the destination session-pooler URL}"

LOCAL=(psql -h "$SOCKDIR" -p "$PGPORT" -U postgres -d "$DBNAME" -v ON_ERROR_STOP=1)
DEST=(psql "$DEST_DB_URL" -v ON_ERROR_STOP=1)

cols_query() { # $1 = table name; one non-generated column name per line, ordinal order
  cat <<SQL
SELECT column_name FROM information_schema.columns
WHERE table_schema='auth' AND table_name='$1' AND is_generated='NEVER'
ORDER BY ordinal_position;
SQL
}

intersect_cols() { # $1 = table; writes intersection to $SCRATCH/auth_$1.cols
  local tbl="$1"
  "${LOCAL[@]}" -Atc "$(cols_query "$tbl")" >"$SCRATCH/$tbl.local.cols"
  "${DEST[@]}"  -Atc "$(cols_query "$tbl")" >"$SCRATCH/$tbl.dest.cols"
  [[ -s "$SCRATCH/$tbl.local.cols" && -s "$SCRATCH/$tbl.dest.cols" ]] || {
    echo "!!! empty column list for auth.$tbl (connection problem?) — aborting" >&2
    exit 1
  }
  # Source-only columns would be silently DROPPED by the intersection — that is
  # data loss for every user. Surface it and require an explicit override.
  if grep -Fxv -f "$SCRATCH/$tbl.dest.cols" "$SCRATCH/$tbl.local.cols" \
       >"$SCRATCH/$tbl.dropped.cols"; then
    echo "!!! auth.$tbl columns present in the export but MISSING on the destination:" >&2
    cat "$SCRATCH/$tbl.dropped.cols" >&2
    if [[ "${ALLOW_DROPPED_AUTH_COLS:-}" != "1" ]]; then
      echo "!!! their data would be lost. Investigate (GoTrue version drift?)," >&2
      echo "!!! or re-run with ALLOW_DROPPED_AUTH_COLS=1 to accept the loss." >&2
      exit 1
    fi
  fi
  grep -Fx -f "$SCRATCH/$tbl.dest.cols" "$SCRATCH/$tbl.local.cols" \
    | sed 's/.*/"&"/' | paste -sd, - >"$SCRATCH/auth_$tbl.cols"
  [[ -s "$SCRATCH/auth_$tbl.cols" ]] || { echo "!!! empty intersection for auth.$tbl" >&2; exit 1; }
}

echo "==> computing auth column intersections (source ∩ destination)"
intersect_cols users
intersect_cols identities
USERS_COLS=$(cat "$SCRATCH/auth_users.cols")
IDENT_COLS=$(cat "$SCRATCH/auth_identities.cols")
echo "    users: $USERS_COLS"
echo "    identities: $IDENT_COLS"

echo "==> dumping public data (dependency-ordered by pg_dump)"
pg_dump -h "$SOCKDIR" -p "$PGPORT" -U postgres -d "$DBNAME" \
  --data-only --schema=public -f "$SCRATCH/public_data.sql"

echo "==> extracting auth CSVs"
"${LOCAL[@]}" -qc "\copy (SELECT $USERS_COLS FROM auth.users) TO '$SCRATCH/auth_users.csv' CSV"
"${LOCAL[@]}" -qc "\copy (SELECT $IDENT_COLS FROM auth.identities) TO '$SCRATCH/auth_identities.csv' CSV"

echo "==> recording baseline counts"
"${LOCAL[@]}" -At >"$SCRATCH/baseline_counts.txt" <<'SQL'
SELECT 'auth.users|' || count(*) FROM auth.users
UNION ALL SELECT 'auth.identities|' || count(*) FROM auth.identities;
SQL
"${LOCAL[@]}" -At >>"$SCRATCH/baseline_counts.txt" <<'SQL'
SELECT c.relname || '|' ||
       (xpath('/row/cnt/text()',
              query_to_xml(format('SELECT count(*) AS cnt FROM %I.%I','public',c.relname),
                           false,true,'')))[1]::text
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r'
ORDER BY c.relname;
SQL
sort -o "$SCRATCH/baseline_counts.txt" "$SCRATCH/baseline_counts.txt"
cat "$SCRATCH/baseline_counts.txt"

echo "==> OK. Next: ./05-import.sh --wipe"
