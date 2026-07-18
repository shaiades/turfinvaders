#!/usr/bin/env bash
# Import the extracted data into the destination Supabase project.
#   --wipe   first remove ALL existing rows (rehearsal/test data) from
#            public tables and auth users/identities on the destination.
# The whole import runs in ONE transaction with session_replication_role=replica:
# the on_auth_user_created trigger cannot fire, FK order doesn't matter, and a
# failure at any point rolls back EVERYTHING — no half-imported state.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/env.sh"
DEST_DB_URL="${DEST_DB_URL:?set DEST_DB_URL}"
HERE="$(cd "$(dirname "$0")" && pwd)"

WIPE=0
if [[ $# -gt 0 ]]; then
  case "$1" in
    --wipe) WIPE=1 ;;
    *) echo "unknown argument: $1 (did you mean --wipe?)" >&2; exit 2 ;;
  esac
fi
[[ $# -le 1 ]] || { echo "too many arguments" >&2; exit 2; }

for f in public_data.sql auth_users.csv auth_identities.csv auth_users.cols auth_identities.cols; do
  [[ -s "$SCRATCH/$f" ]] || { echo "missing $SCRATCH/$f — run 04-extract.sh first" >&2; exit 1; }
done
USERS_COLS=$(cat "$SCRATCH/auth_users.cols")
IDENT_COLS=$(cat "$SCRATCH/auth_identities.cols")
DEST=(psql "$DEST_DB_URL" -v ON_ERROR_STOP=1 -P pager=off)

WIPE_SQL=""
if [[ $WIPE -eq 1 ]]; then
  echo "==> will wipe destination public tables + auth users/identities first"
  WIPE_SQL=$(cat <<'SQL'
DO $$
DECLARE tables text;
BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ')
    INTO tables
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r';
  IF tables IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || tables || ' CASCADE';
  END IF;
END $$;
DELETE FROM auth.identities;
DELETE FROM auth.mfa_factors;
DELETE FROM auth.one_time_tokens;
DELETE FROM auth.sessions;
DELETE FROM auth.flow_state;
DELETE FROM auth.users;
SQL
)
fi

echo "==> importing (single transaction, trigger-safe replica session)"
"${DEST[@]}" -q <<SQL
SET session_replication_role = replica;
SET statement_timeout = 0;
BEGIN;
$WIPE_SQL
\copy auth.users ($USERS_COLS) FROM '$SCRATCH/auth_users.csv' CSV
\copy auth.identities ($IDENT_COLS) FROM '$SCRATCH/auth_identities.csv' CSV
\i '$SCRATCH/public_data.sql'
COMMIT;
SET session_replication_role = DEFAULT;
SQL

echo "==> ensuring sequences are at least max(column) (never regress a counter)"
"${DEST[@]}" -q <<'SQL'
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch, t.relname AS tab, a.attname AS col, s.relname AS seq
    FROM pg_class s
    JOIN pg_depend d ON d.objid = s.oid AND s.relkind = 'S'
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format(
      'SELECT setval(%L, GREATEST((SELECT last_value FROM %I.%I),
                                  COALESCE((SELECT max(%I) FROM %I.%I), 1)))',
      r.sch || '.' || r.seq, r.sch, r.seq, r.col, r.sch, r.tab);
  END LOOP;
END $$;
SQL

echo "==> re-running auth fix pass on destination"
"${DEST[@]}" -q -f "$HERE/03-auth-fixpass.sql"

echo "==> ANALYZE"
"${DEST[@]}" -qc "ANALYZE"

echo "==> OK. Next: ./06-verify.sh"
