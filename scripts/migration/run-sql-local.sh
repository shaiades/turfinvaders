#!/usr/bin/env bash
# Run a SQL file against the local scratch copy of the Lovable export.
# Usage: ./run-sql-local.sh 02-auth-audit.sql
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/env.sh"
exec psql -h "$SOCKDIR" -p "$PGPORT" -U postgres -d "$DBNAME" \
  -v ON_ERROR_STOP=1 -P pager=off -f "$HERE/${1:?usage: $0 <file.sql>}"
