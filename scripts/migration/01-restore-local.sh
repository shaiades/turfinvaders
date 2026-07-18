#!/usr/bin/env bash
# Restore the Lovable Cloud export into a local scratch Postgres 18 cluster.
# Usage: ./01-restore-local.sh /path/to/export.dump[.zst]
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/env.sh"

DUMP="${1:?usage: $0 /path/to/export.dump[.zst]}"
mkdir -p "$SCRATCH" "$SOCKDIR"

if [[ "$DUMP" == *.zst ]]; then
  echo "==> decompressing $DUMP"
  zstd -d -f "$DUMP" -o "$SCRATCH/export.dump"
  DUMP="$SCRATCH/export.dump"
fi

if [[ ! -d "$SCRATCH/pgscratch" ]]; then
  echo "==> initdb scratch cluster"
  initdb -D "$SCRATCH/pgscratch" -U postgres --no-instructions >/dev/null
fi

if ! pg_ctl -D "$SCRATCH/pgscratch" status >/dev/null 2>&1; then
  echo "==> starting scratch cluster on port $PGPORT (socket dir $SOCKDIR)"
  pg_ctl -D "$SCRATCH/pgscratch" -o "-p $PGPORT -k $SOCKDIR -c listen_addresses=''" \
    -l "$SCRATCH/pg.log" -w start || { tail -20 "$SCRATCH/pg.log" >&2; exit 1; }
fi

PSQL=(psql -h "$SOCKDIR" -p "$PGPORT" -U postgres)

echo "==> recreating database $DBNAME"
"${PSQL[@]}" -d postgres -qc "DROP DATABASE IF EXISTS $DBNAME"
"${PSQL[@]}" -d postgres -qc "CREATE DATABASE $DBNAME"

echo "==> pre-creating Supabase platform roles"
for r in anon authenticated service_role supabase_admin supabase_auth_admin \
         supabase_storage_admin supabase_functions_admin supabase_realtime_admin \
         supabase_replication_admin dashboard_user authenticator pgbouncer pgsodium_keyholder; do
  "${PSQL[@]}" -d postgres -qc "CREATE ROLE $r NOLOGIN" 2>/dev/null || true
done

echo "==> restoring (noise from Supabase-managed objects is tolerated; data errors are NOT)"
MAGIC=$(head -c 5 "$DUMP")
if [[ "$MAGIC" == "PGDMP" ]]; then
  pg_restore -h "$SOCKDIR" -p "$PGPORT" -U postgres -d "$DBNAME" \
    --no-owner --no-privileges "$DUMP" 2>"$SCRATCH/restore-errors.log" || true
else
  "${PSQL[@]}" -d "$DBNAME" -v ON_ERROR_STOP=0 -f "$DUMP" \
    2>"$SCRATCH/restore-errors.log" >/dev/null || true
fi

# Gate: an error touching table DATA (COPY) or public/auth objects means rows
# may be silently missing — and 04's baseline comes from THIS copy, so nothing
# downstream would ever notice. Refuse to continue unless explicitly overridden.
if grep "ERROR" "$SCRATCH/restore-errors.log" \
     | grep -E "COPY |copy \"|public\.|auth\.users|auth\.identities" \
     >"$SCRATCH/restore-errors-critical.log"; then
  echo "!!! restore errors touch migrated data (see $SCRATCH/restore-errors.log):" >&2
  cat "$SCRATCH/restore-errors-critical.log" >&2
  if [[ "${ALLOW_RESTORE_ERRORS:-}" != "1" ]]; then
    echo "!!! refusing to continue. Investigate, or re-run with ALLOW_RESTORE_ERRORS=1 if truly benign." >&2
    exit 1
  fi
  echo "!!! ALLOW_RESTORE_ERRORS=1 set — continuing anyway." >&2
fi
ERRS=$(grep -c "ERROR" "$SCRATCH/restore-errors.log" || true)
echo "==> restore finished; ${ERRS:-0} tolerated error lines (Supabase-managed objects)"

echo "==> per-table row counts of the restored copy:"
"${PSQL[@]}" -d "$DBNAME" -P pager=off -c "
  SELECT 'auth.users' AS tbl, count(*) AS rows FROM auth.users
  UNION ALL SELECT 'auth.identities', count(*) FROM auth.identities
  UNION ALL
  SELECT 'public.' || c.relname,
         (xpath('/row/cnt/text()',
                query_to_xml(format('SELECT count(*) AS cnt FROM %I.%I','public',c.relname),
                             false,true,'')))[1]::text::bigint
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'
  ORDER BY 1;"
echo "==> IMPORTANT: eyeball these against the live app (or Lovable's data view) before"
echo "    proceeding — this restored copy is the ONLY baseline the rest of the pipeline has."
echo "==> Next: ./run-sql-local.sh 02-auth-audit.sql"
