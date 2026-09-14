# RepCard 2026 historical import

One-time backfill of Tidal Remodeling's **RepCard** tenant (company `2343`) into
TurfInvaders, scoped to **calendar-year 2026** and **stripped of homeowner PII**
(no names/addresses/phones — only rep performance and turf geometry).

## What lands

| Table | Rows | Source |
|---|---|---|
| `repcard_canvasser_results` | 107 | RepCard SCCE leaderboard, `This Year` (2026-01-01 → 2026-09-14) |
| `repcard_territory_history` | 2,700 | RepCard `GET /api/user-area` polygons, assignedAt in 2026 |

Both tables are **isolated, read-only history**. Nothing in the app writes to
them, and they are intentionally *not* wired into `daily_logs`, `daily_metrics`,
`leads`, or `turfs` — so this import cannot move any leaderboard or payroll
number. `polygon_coordinates` uses the same `[{lat,lng}]` shape as `public.turfs`,
so the existing NeonMap polygon renderer can draw them as a coverage layer.

Rep identity is denormalized (`rep_name` + `team`/`office` + `repcard_user_id`).
Most 2026 reps have since left the roster, so resolve to a live `profiles` row by
name at query time (reuse the canvasser name matcher) rather than a hard FK.

## Apply (owner — runs against prod)

Prod project is `xogitpqeuwalerxygvjw`. Apply the schema, then the data:

```bash
# 1) schema (tables + RLS + indexes)
supabase db query --linked --file supabase/migrations/20260914170000_repcard_history_import.sql
# 2) data (re-runnable; clears the 2026 rows first)
supabase db query --linked --file scripts/repcard/repcard_2026_seed.sql
```

Or paste each file into the Supabase SQL editor. The seed is wrapped in a single
transaction and is safe to re-run (it deletes the 2026 source rows before
re-inserting; territory upserts on `repcard_area_id`).

## Provenance / re-pull

Pulled via the RepCard public API (`https://app.repcard.com/api`, `x-api-key`
auth). Key endpoints: `GET /api/user-area?fromDate=&toDate=&per_page=100&page=`
(territory) and the dashboard SCCE leaderboard (results). Human-readable copies of
the extracted data live in `data/` next to this README.
