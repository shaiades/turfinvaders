# Lovable Cloud → self-owned Supabase: cutover pipeline

Runbook for migrating the Turf Invaders backend out of Lovable Cloud.
Full plan: see the migration plan document. These scripts make the freeze
window pure execution — every step is idempotent and safe to re-run.

**Nothing here ever writes to the Lovable Cloud project.** Rollback at any
point before the frontend flip = unfreeze and keep using Lovable.

## Environment

```sh
export DEST_DB_URL='postgresql://postgres.<NEWREF>:<PW>@aws-0-us-west-1.pooler.supabase.com:5432/postgres'
export MIGRATION_SCRATCH=/path/to/private/scratch          # holds dump + extracts; DELETE after migration
```

`MIGRATION_SCRATCH` must not contain whitespace or quotes (enforced).
`env.sh` (sourced by every script) pins PATH to Postgres 18, sets `LC_ALL=C`
(Homebrew PG dies on unset locales; also makes sort orders reproducible), and
puts the cluster's Unix socket in a short dir (`/tmp/ti-mig-sock`) because
socket paths cap at ~103 bytes.

The dump and every extract contain `auth.users.encrypted_password` bcrypt
hashes. Keep them in `MIGRATION_SCRATCH` (never the repo), and securely
delete the whole directory once the migration is verified stable.

## Order of operations (cutover day)

| # | Step | Command | Freeze? |
|---|------|---------|---------|
| 0 | Schema already replayed + edge function deployed + app verified on Vercel against the empty project | (Phases A–D) | no |
| 1 | Announce write-freeze; trigger Export project data in Lovable UI; download dump | manual | **start** |
| 2 | Restore dump into local scratch cluster | `./01-restore-local.sh <dump>` | yes |
| 3 | Audit auth data (read-only report; informs Google OAuth expectations) | `./run-sql-local.sh 02-auth-audit.sql` | yes |
| 4 | Fix passes on the local copy | `./run-sql-local.sh 03-auth-fixpass.sql` | yes |
| 5 | Extract data + baseline counts | `./04-extract.sh` | yes |
| 6 | Wipe rehearsal/test data from destination, then import | `./05-import.sh --wipe` | yes |
| 7 | Verify destination against baseline | `./06-verify.sh` | yes |
| 8 | Human gates: real login with original password; Google user lands on migrated account | manual | yes |
| 9 | Flip: merge branch → main, Vercel prod deploy, repoint Monday webhooks, announce URL | manual | **end** |

If any step fails: stop, unfreeze, debug against the local copy at leisure,
rerun with a fresh export after the 24 h cooldown.

## Notes

- Local scratch cluster runs on port **5499**, db `lovable_copy`, user `postgres`.
- `05-import.sh` uses `SET session_replication_role = replica` so the
  `on_auth_user_created` trigger cannot fire during `auth.users` import and
  FK order doesn't matter. It re-runs `03-auth-fixpass.sql` on the
  destination afterwards as a belt-and-suspenders pass.
- Auth CSVs are extracted with the **intersection** of source/destination
  column lists (GoTrue versions may differ; generated columns excluded).
- We intentionally do NOT migrate: `auth.sessions`, `auth.refresh_tokens`,
  `auth.one_time_tokens`, `auth.flow_state` (everyone re-logs-in),
  `auth.audit_log_entries`, `auth.schema_migrations` (never touch),
  `cron.job` (recreated by repo migrations), `storage.*` (unused), `vault.*`.
