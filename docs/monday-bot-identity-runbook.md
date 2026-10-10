# Monday bot identity + go-live runbook (rules K–O)

This branch adds the write lock (L), the 8:45 AM auto-issue (M), the rep-portal
fix (N), and the Dispo/Reload split (O). The code is committed; the two DB
migrations are **already applied to prod** (dormant). What's left is ops: the
Monday bot identity (K), deploying the edge function, pushing the app, and
flipping the switches when you're ready.

Everything is inert until you flip the flags — `live_dispatch_mode` still gates
every block write, and `nightly_auto_issue_enabled` defaults OFF.

---

## K — give Claude its own Monday identity (stop writing as Shai)

Today the API token in `system_settings.monday_api_token` is Shai's personal
one, so every automated write lands in the activity log as Shai — untraceable,
and (a real bug) Rule A3's "don't clobber a human" guard currently treats Shai's
own hand-edits as the bot's and can overwrite them. A dedicated bot fixes both.
**No code change is needed** — the token is read from the DB and the writer
identity is derived live via `fetchMondayMe(token)`.

1. **Create the user** (Monday admin): add a user, e.g. `turfinvaders-bot`
   (a real mailbox you control). Give it **write** access to all six boards:
   - SD Block `18433845590`, OC Block `18433845468`
   - OOH Dispo Reports `18433859050`
   - Resets/Rehash (OC Confirmed) `18411299428`
   - Sales Processing `4155553389`
   - Nightly Lineup – Approvals `18433860636`
   > Note: the SD/OC block boards are re-cloned weekly, so grant access at the
   > workspace/folder level (not just this week's board) or the bot loses write
   > access on the next rotation.

2. **Generate its token**: sign in to Monday **as the bot** → avatar →
   Developers → My Access Tokens → copy the personal API token. (Monday will not
   mint another user's token through the API — this must be an interactive login
   as the bot.)

3. **Swap the stored token.** Use the Supabase **SQL editor** (dashboard →
   SQL Editor) so the token never lands in shell history:
   ```sql
   update public.system_settings
   set monday_api_token = 'PASTE_THE_BOT_TOKEN_HERE'
   where id = (select id from public.system_settings limit 1);
   ```
   No redeploy needed — the edge functions read the token per request.

4. **Verify two identities.** Have the office make one hand-edit on a block item,
   and let the bot make one write (or ping me — I can trigger a controlled test
   write and read `get_board_activity`). Confirm the two writes show **different
   `user_id`s**. The bot's id should no longer be `40084823` (Shai).

---

## Deploy the edge function (manual — no CI)

The lock (L) and auto-issue (M) live in `monday-ooh-report`. Deploy it:
```bash
supabase functions deploy monday-ooh-report --project-ref xogitpqeuwalerxygvjw
```
Until this runs, the deployed function is the old one: no write lock, and
Approve still applies immediately. The DB migrations are already applied, so the
lock table/functions and the `approved` state are waiting for it.

## Push the app (Lovable syncs on push)

The portal (N) and Dispo/Reload split (O) are frontend. Pushing this branch
syncs it to Lovable and deploys the app. (I have **not** pushed — say the word.)

---

## Flipping the switches (owner's call, in order)

1. **Write lock (L)** — active automatically once the edge function is deployed.
   Nothing to flip. It only *adds* serialization; worst case (lock service
   hiccup) it fails open to today's behavior.

2. **Rep portal (N)** — live once the app is pushed. The reconcile cron
   (`/api/internal/reconcile-block-cards`, 4×/day) runs on its own.

3. **Auto-issue (M)** — two gates, both yours:
   - `nightly_auto_issue_enabled` → `true` turns the 8:45 job on.
   - `live_dispatch_mode` → `'live'` is what actually lets it (and every other
     dispatcher path) write to Monday. While it's `off`/`dry_run`, approved rows
     are left untouched.
   ```sql
   update public.system_settings set nightly_auto_issue_enabled = true
   where id = (select id from public.system_settings limit 1);
   ```

### Test M before trusting it (rule M11)
With the job enabled and `live_dispatch_mode='live'`:
1. The night before, approve 3 rows on the Nightly Lineup board (they go to
   state `approved`, nothing writes yet).
2. Temporarily disable the cron job if you want to control timing
   (`select cron.unschedule('nightly-auto-issue');`), then run it by hand:
   ```bash
   curl -X POST "https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/monday-ooh-report?task=auto-issue&force=true" \
     -H "x-notify-secret: <NOTIFY_SECRET>"
   ```
3. Confirm exactly those 3 block items got the rep added and all 3 rows flipped
   to `applied` (and the board's Issued column). Re-running must issue nothing
   more (idempotent).
4. Re-schedule the cron if you unscheduled it (re-run the migration, or
   `select cron.schedule('nightly-auto-issue','45 15,16 * * *',$$ select public.run_nightly_auto_issue(); $$);`).

---

## What "approve" means now (behavior change)

Pressing **Approve** / **Approve all** on the Nightly Lineup board no longer
writes to the block immediately — it marks the row `approved` and the 8:45 job
issues it. **Don't approve** (reject) and the manager-directed **Change / Add
rep** still act immediately (those are live manager actions). This matches the
"approve the night before, issue in the morning" workflow.
