# Monday.com Sale Price → Payroll: Rollout Runbook

This runbook accompanies the changes that make the live Monday.com webhook
capture the **Sale Price** column and feed payroll. Follow the phases in
order. Nothing here modifies data — Phase 0 is read-only.

## Phase 0 — Forensics (run BEFORE deploying)

Open the Supabase dashboard → SQL editor (project `uugdbtsxpkztxajssjph`) and run:

```sql
-- 1. Which endpoint is Monday actually posting to?
--    step='0_Endpoint_Hit' rows  = the live edge function (monday-live-dispatch)
--    source=...            rows  = the app API routes
SELECT step, source, count(*), max(created_at) AS last_seen
FROM webhook_logs
WHERE created_at > now() - interval '14 days'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

```sql
-- 2. Drift check: what live counters exist that payroll never saw?
--    daily_metrics = live leaderboard table; daily_logs = payroll table.
SELECT m.metric_date, count(*) AS metric_rows,
       sum(m.sales) AS metrics_sales,
       (SELECT count(*) FROM daily_logs dl WHERE dl.log_date = m.metric_date) AS log_rows,
       (SELECT COALESCE(sum(dl.sales),0) FROM daily_logs dl WHERE dl.log_date = m.metric_date) AS logs_sales
FROM daily_metrics m
WHERE m.metric_date > current_date - 21
GROUP BY 1 ORDER BY 1 DESC;
```

```sql
-- 3. Confirmed sales with no price (candidates the new pipeline will heal
--    when their price is edited in Monday):
SELECT id, canvasser_id, customer_name, created_at
FROM leads
WHERE is_sale AND status = 'confirmed' AND sale_amount IS NULL
ORDER BY created_at DESC LIMIT 50;
```

**Also check in Monday.com** (Board → Integrations, both OC and SD boards):
count the webhooks pointing at this app. If BOTH the edge function URL
(`…/functions/v1/monday-live-dispatch…`) AND the legacy URL
(`…/api/public/monday-webhook…`) are configured on the same board, remove one
**before** deploying, otherwise counters will double-count once the edge
function starts writing `daily_logs`.

## Phase 1 — Database migration

File: `supabase/migrations/20260718173539_cf77b609-3e3c-4fb3-9ec6-5657b3065bdd.sql`

If Lovable Cloud does not auto-apply repo migrations, paste the file's
contents into the Supabase SQL editor and run it once. It is additive and
instant: a new nullable `leads.monday_item_id` column, a unique index, and the
`leads.canvasser_id` FK re-pointed to `profiles` (NOT VALID → cannot fail on
existing rows).

## Phase 2 — Edge function deploy

The updated `supabase/functions/monday-live-dispatch/index.ts` deploys via the
normal Lovable git sync (or `supabase functions deploy monday-live-dispatch
--project-ref uugdbtsxpkztxajssjph`). After deploy:

1. Open Live Dispatch → Webhook Logs (X-Ray). On the next Monday event you
   should see the usual steps plus `Sale_Price_Inspect` on sale-related
   events.
2. If `Sale_Price_Inspect` shows `salePriceRaw: ""` while the Monday item
   clearly has a price, the Sale Price column is a **Formula column** —
   tell your developer/Claude; the GraphQL query needs a one-line extension
   (`... on FormulaValue { display_value }`).

### Secret gate (optional hardening, later)
The function now supports a shared secret. To enable: set function secrets
`MONDAY_WEBHOOK_SECRET=<random string>`; watch logs for `Secret_Check_Failed`;
add `&secret=<the string>` to the webhook URL(s) in Monday; once logs are
clean, set `MONDAY_WEBHOOK_ENFORCE_SECRET=true`. Until the secret is set, the
function behaves exactly as before.

## Phase 2 verification (safe, isolated)

1. In Supabase Studio → Authentication → Add user: `test-price@knockout.local`
   (any strong password). The signup trigger creates its profile; set its
   `display_name` to `ZZ Pricetest` (Table editor → profiles).
2. On the active Monday board, create ONE item with Agent = `ZZ Pricetest`,
   then exercise in order: (a) set Sale Price, then Sale = Sold;
   (b) second item: Sold first, add price after; (c) edit a price;
   (d) revert a Sold back to blank.
3. Expected `webhook_logs` steps: `Sale_Price_Inspect` each time, then
   `Sale_Lead_Created` / `Sale_Missing_Price` / `Sale_Lead_Updated` /
   `Sale_Lead_Voided` respectively.
4. SQL: `SELECT id, status, sale_amount, reviewed_at, monday_item_id FROM
   leads WHERE monday_item_id IS NOT NULL ORDER BY created_at DESC;`
   → exactly one row per test item, tracking Monday's current state.
5. Payroll: Dashboard → Payroll, current week → ZZ Pricetest shows the sale
   volume and commission (volume × 1%). Executive Dashboard → Last Week's
   Results uses the same engine.
6. Cleanup: delete the test items in Monday (optional), then delete
   `ZZ Pricetest` in Fleet Manager and any leftover test `leads` rows:
   `DELETE FROM leads WHERE monday_item_id IN ('<test item ids>');`

## Ongoing monitoring queries

```sql
-- Sales that arrived without a price (fix the price in Monday; it heals):
SELECT * FROM leads WHERE is_sale AND status='confirmed' AND sale_amount IS NULL;

-- Legacy webhook still double-posting? (leads with no Monday id, post-deploy,
-- that came from neither CSV nor the app):
SELECT * FROM leads
WHERE is_sale AND monday_item_id IS NULL AND created_at > '<deploy date>';

-- Duplicate guard health:
SELECT monday_item_id, count(*) FROM leads
WHERE monday_item_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
```

## Phase 5 — Pay policy features (owner-confirmed 2026-07-18)

Migration `20260718183328_*.sql` + app changes add:

1. **Monthly Volume Bonus surfaced** — the pay engine's existing
   "$1,500 per full $100k confirmed sale volume per calendar month" is now
   shown: a "Monthly Volume Bonus" panel under the Payroll tab (month of the
   selected week) and an MTD estimate line on each canvasser's Take-Home
   widget. No formula change — the SQL already computed it.
2. **Starting Pay Lock automation** — Jr. Diamond/Sr. Diamond/Captain keep
   the $35/hr + 2% lock only while their rolling 4-week sit average
   (completed Mon–Sat weeks) stays at 5+. First violation → "Lock warning"
   (chip in the Payroll Ledger, banner on the canvasser's dashboard).
   Second violation within 90 days → "Lock reverted": they are paid on the
   normal weekly point tiers (rank and $75 sit bonus retained). Reinstatement
   is automatic after 3 consecutive completed weeks at 7+ sits. Evaluated
   weekly (on activity, plus a Monday 8am PT cron for zero-activity weeks).
3. **Security hardening** — pay-affecting profile columns (current_rank,
   the sit counters, recruits_count, pay-lock state) can no longer be edited
   by canvassers on their own row; only the engine and owners can write them.

**Known policy tension to be aware of:** the poster says a reverted lock
retains rank, but the rank engine independently demotes ranks when the
qualifying streaks lapse (pre-existing behavior). Someone slumping hard
enough may simply lose the Diamond rank (and with it the lock) before the
pay-lock state machine matters. The state machine governs the window where
the rank is still held.

## Phase 6 — Pay rules correction (owner-confirmed 2026-07-18)

Migration `20260718192842_*.sql` + app changes:

1. **Clocked hours paid in full** — the 7.5/6.5 daily caps are gone (early
   training time must be paid by law). A **30-minute lunch is deducted from
   every closed shift** (the UI always said this; now the math does it).
   Sundays remain unpaid; the pay week remains Mon–Sat. All existing closed
   time entries were recomputed under the new rules.
2. **No more estimated hours** — base pay comes only from clocked time.
   Activity on a day no longer credits hours (leads can land on days the
   canvasser didn't work). **No clock-in = no base pay**, including for
   historical weeks (owner accepted past unclocked weeks showing $0 base).
   Commission, sit bonuses, and monster bonuses are unaffected by hours.
3. **Monthly volume bonus timing** — earned in month M, **paid in month
   M+1**. The Payroll tab's panel and the canvasser dashboard line now say
   so explicitly.

**Cautions:**
- Canvassers MUST clock in/out to earn base pay — communicate this before
  deploy or paychecks will drop to commission+bonuses only.
- With caps removed, a **forgotten clock-out** auto-closes at 6:00 PM
  weekdays / 5:00 PM Saturdays and now pays the full span (9am→6pm = 9h −
  0.5 lunch = 8.5h, where it used to cap at 7.5). Review the Timesheets tab
  weekly for unusually long spans.

## Rollback

- Revert the deploy commit (forward-only `git revert`, never rewrite history —
  Lovable syncs from this repo). The function instantly returns to
  counters-only behavior.
- Live-created sale rows are exactly identifiable
  (`WHERE monday_item_id IS NOT NULL`) and can be denied or deleted; every
  dashboard and the pay engine recompute live, so payroll self-corrects.
- The migration is additive and can stay in place harmlessly.

## Cautions for day-to-day use

- **Enable the webhook secret soon after go-live.** Until it is enforced, the
  endpoint accepts unauthenticated posts (unchanged from today), but it now
  writes payroll data, so the stakes are higher.
- **CSV re-imports** of a date range DELETE the confirmed sale leads in that
  range (including Monday-created ones) and replace them with CSV rows. After
  go-live, avoid re-importing weeks that were tracked live unless the CSV is
  the intended correction — it is the canonical correction path.
- **Late price edits in Monday** update the lead in place, which changes the
  (recomputed) commission for that past week. `Sale_Lead_Updated` log rows
  are the audit trail. A lead denied by a human at the Confirmation Desk is
  never auto-re-confirmed by Monday events.
- **Status edits to old items land on today.** Like the live leaderboard,
  outcome changes are recorded on the day the change happens in Monday, not
  the day the lead originally ran. Reverting yesterday's Sold today removes
  the commission correctly (the lead is voided) but cannot subtract the
  sit/sale point from yesterday's logs — use a CSV re-import or Manual Weekly
  Entry to correct past days.
- **Monday webhook retries** can rarely double-apply an outcome to the
  counters (pre-existing behavior on the leaderboard, now also payroll
  counters). The Sale-Price lead itself is fully idempotent — money is never
  double-counted. If a week looks off, CSV re-import overwrites it cleanly.
- **Manual Daily Log edits vs live webhook**: if a canvasser edits their own
  Daily Log page for a day the webhook is also writing, last write wins.
  Prefer one source per day.
- **Deleting a profile** in Fleet Manager no longer removes their historical
  sale leads (revenue history is preserved; the row shows "Unknown" once the
  profile is gone). Delete their leads manually if that is the intent.
- New agent names arriving from Monday are auto-provisioned as Free Agent
  placeholder profiles; their sales now carry real money — assign/merge them
  promptly in Fleet Manager.
