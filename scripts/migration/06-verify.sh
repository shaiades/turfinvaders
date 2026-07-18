#!/usr/bin/env bash
# Verify the destination against the baseline extracted in 04-extract.sh.
# Exits non-zero if row counts differ or any hard gate fails.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/env.sh"
DEST_DB_URL="${DEST_DB_URL:?set DEST_DB_URL}"
DEST=(psql "$DEST_DB_URL" -v ON_ERROR_STOP=1 -P pager=off)
FAILED=0

echo "==> row-count parity"
"${DEST[@]}" -At >"$SCRATCH/dest_counts.txt" <<'SQL'
SELECT 'auth.users|' || count(*) FROM auth.users
UNION ALL SELECT 'auth.identities|' || count(*) FROM auth.identities;
SQL
"${DEST[@]}" -At >>"$SCRATCH/dest_counts.txt" <<'SQL'
SELECT c.relname || '|' ||
       (xpath('/row/cnt/text()',
              query_to_xml(format('SELECT count(*) AS cnt FROM %I.%I','public',c.relname),
                           false,true,'')))[1]::text
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r'
ORDER BY c.relname;
SQL
sort -o "$SCRATCH/dest_counts.txt" "$SCRATCH/dest_counts.txt"
if diff "$SCRATCH/baseline_counts.txt" "$SCRATCH/dest_counts.txt"; then
  echo "    counts match ✓"
else
  echo "    COUNT MISMATCH ✗ (left=baseline, right=destination)" >&2
  FAILED=1
fi

gate() { # gate <name> <expected> <actual>
  if [[ "$3" == "$2" ]]; then
    echo "    ✓ $1 = $3"
  else
    echo "    ✗ $1: expected [$2], got [$3]" >&2
    FAILED=1
  fi
}

echo "==> hard gates"
ORPHANS=$("${DEST[@]}" -Atc "SELECT count(*) FROM auth.identities i
  WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id=i.user_id)")
gate "orphaned identities" "0" "$ORPHANS"

UNCONFIRMED=$("${DEST[@]}" -Atc "SELECT count(*) FROM auth.users
  WHERE deleted_at IS NULL AND email_confirmed_at IS NULL")
gate "unconfirmed live users" "0" "$UNCONFIRMED"

TRIGGER=$("${DEST[@]}" -Atc "SELECT COALESCE(string_agg(tgname || ':' || tgenabled, ','), 'MISSING')
  FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal")
gate "auth.users trigger" "on_auth_user_created:O" "$TRIGGER"

NO_RLS=$("${DEST[@]}" -Atc "SELECT COALESCE(string_agg(c.relname, ','), 'none')
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity")
gate "tables without RLS" "none" "$NO_RLS"

SECDEF=$("${DEST[@]}" -Atc "SELECT count(*) FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef")
gate "SECURITY DEFINER functions" "17" "$SECDEF"

CRON=$("${DEST[@]}" -Atc "SELECT COALESCE(string_agg(jobname || '[' || schedule || ':' || active || ']', ',' ORDER BY jobname), 'MISSING') FROM cron.job")
gate "cron jobs" "auto-archive-agents-daily[0 8 * * *:t],time-entries-auto-clock-out[*/15 * * * *:t]" "$CRON"

PUBTABLES=$("${DEST[@]}" -Atc "SELECT COALESCE(string_agg(tablename, ',' ORDER BY tablename), 'MISSING')
  FROM pg_publication_tables WHERE pubname='supabase_realtime'")
gate "realtime publication" "daily_logs,daily_metrics,field_pins,hype_events,lead_events,leads,offices,teams,territories,webhook_logs" "$PUBTABLES"

REPLIDENT=$("${DEST[@]}" -Atc "SELECT string_agg(relname || ':' || relreplident, ',' ORDER BY relname)
  FROM pg_class WHERE relname IN ('daily_metrics','webhook_logs') AND relkind='r'")
gate "replica identity FULL" "daily_metrics:f,webhook_logs:f" "$REPLIDENT"

SETTINGS=$("${DEST[@]}" -Atc "SELECT count(*) FROM public.system_settings")
if [[ "$SETTINGS" -ge 1 ]]; then
  echo "    ✓ system_settings rows = $SETTINGS"
else
  echo "    ✗ system_settings is empty (Monday token missing)" >&2
  FAILED=1
fi

if [[ $FAILED -ne 0 ]]; then
  echo "==> VERIFICATION FAILED — do NOT flip. Fix, re-import, re-verify." >&2
  exit 1
fi

echo "==> all automated gates passed ✓. Remaining HUMAN gates:"
echo "    1. Real login with a pre-migration email + original password"
echo "    2. Broker-era Google user signs in and lands on their migrated account"
echo "    3. Realtime propagates between two live sessions"
echo "    4. Edge fn: curl -X POST <NEWURL>/functions/v1/monday-live-dispatch -d '{\"challenge\":\"x\"}' (no auth header)"
