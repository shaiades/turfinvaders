# Rescued WIP — fleet-dispatch-van-org

**This is preserved work-in-progress for review, not a ready-to-merge change.**

## Where it came from
Recovered on 2026-10-07 from the `fleet-dispatch-van-org-38daf5` worktree of the
old iCloud checkout (`~/Library/Mobile Documents/.../Turf Invaders`) just before
that checkout was retired. The copy now lives at
`~/Developer/turfinvaders-rescued-from-icloud/`.

This work was **never committed and never pushed** — it existed only as
uncommitted changes in that worktree's working tree. There is no corresponding
branch on GitHub.

## What it contains
- `changes.patch` — uncommitted edits to 5 tracked files:
  - `src/components/FleetDispatch.tsx`
  - `src/integrations/supabase/types.ts` (generated Supabase types)
  - `src/lib/dispatch.functions.ts`
  - `src/routes/_authenticated/dashboard.tsx`
  - `supabase/functions/monday-live-dispatch/index.ts`
- `migrations-reference/` — two untracked migrations that accompanied it (van
  aliases + per-van daily metrics). Kept **here**, not in `supabase/migrations/`,
  so they are *not* treated as live migrations.

## Why it is not reconstructed as a normal change
The base this WIP was written against is ~2+ months old (migrations dated
2026-07-31), and the fleet-dispatch / Monday-live-dispatch area has had several
PRs merged since — e.g. #291 (van membership for admin riders), #272 (van-move
locking), #255 (cancelled sales on Fleet Dispatch). Re-applying `changes.patch`
onto current `main` produces **33 conflicts across the 5 files**, and a good deal
of the intent is likely already covered by those merged PRs.

So it is preserved verbatim for a human to judge what, if anything, is still
worth porting — rather than mechanically force-merged.

## How to port it (if you decide to)
From the repo root, on a fresh branch off `main`:

```bash
git apply --3way rescued-wip/fleet-dispatch-van-org/changes.patch
# Resolve the conflicts (expect ~33), checking each against what #291/#272/#255
# already landed so you don't reintroduce superseded logic.
```

For the migrations, compare against the current schema first; only move a file
into `supabase/migrations/` if its table/columns aren't already present, and
renumber the timestamp so it sorts after existing migrations.

## Safe to delete
If you review this and decide none of it is needed, delete the whole
`rescued-wip/` folder — it carries no runtime code and nothing imports it.
