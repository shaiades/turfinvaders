# Shared environment for the migration scripts. Sourced, not executed.
# shellcheck shell=bash

export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"

# Homebrew PG18's postmaster dies with "postmaster became multithreaded during
# startup" when no locale is set (true in non-interactive shells); C also pins
# `sort` ordering so 04's baseline and 06's dest counts always collate the same.
export LC_ALL="${LC_ALL:-C}"

SCRATCH="${MIGRATION_SCRATCH:?set MIGRATION_SCRATCH to a private scratch dir}"
case "$SCRATCH" in
  *[[:space:]]* | *"'"*)
    echo "MIGRATION_SCRATCH must not contain whitespace or quotes: $SCRATCH" >&2
    exit 1
    ;;
esac

# Unix sockets cap sun_path at ~103 bytes, so the socket dir must be SHORT
# regardless of where MIGRATION_SCRATCH lives (data dir depth is fine).
SOCKDIR="${MIGRATION_SOCKDIR:-/tmp/ti-mig-sock}"
if [[ ${#SOCKDIR} -gt 85 ]]; then
  echo "MIGRATION_SOCKDIR too long (${#SOCKDIR} chars) for a Unix socket path" >&2
  exit 1
fi

# shellcheck disable=SC2034  # consumed by the sourcing scripts
PGPORT=5499
# shellcheck disable=SC2034
DBNAME=lovable_copy
