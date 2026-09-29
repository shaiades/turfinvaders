-- Van assignment lock (owner decision 2026-09-29 — supersedes "Monday's Van
-- column is authoritative for van membership", owner 2026-07-28):
--   * In-app van moves STICK. Every move through useMoveAgents stamps
--     van_locked_at, and the monday-live-dispatch Van sync skips locked
--     profiles (logging webhook_logs step 'Van_Locked' instead of writing).
--     The CSV historical importer skips locked profiles the same way.
--   * Locked <=> van_locked_at IS NOT NULL. van_locked_by records who pinned
--     them (shown in the unlock UI). Precedent: turfs.assigned_by/assigned_at
--     (20260815020000), including its server-owns-provenance stamping.
--   * Explicit Lock/Unlock is manager-tier (owner / office_staff / captain),
--     target-gated client-side by canManageTarget; unlocking hands the person
--     back to Monday on their NEXT card event (no immediate re-sync).
--   * New profiles (Bouncer auto-create, Add Player, CSV, signup) start
--     unlocked so Monday still auto-places new people. No backfill: existing
--     assignments stay Monday-driven until their first in-app move.
--   * Creation-time van picks (createCanvasser / addTeamMember) deliberately
--     do NOT lock — provisional seating, not a countermanded Monday decision.
--   * archive_agent / reactivate_agent / merge_canvassers are untouched: the
--     lock SURVIVES archive (lossless round-trip, PR #76 philosophy — bonus:
--     webhook matching has no is_active filter, so a locked archived person
--     can no longer be re-teamed by a stray card; unlocked archived people
--     remain re-teamable, a pre-existing exposure this narrows but doesn't
--     close). A merge keeps the keeper (auth) side's lock; losers' locks are
--     moot (team_id NULL'd or row deleted).
--   * Guard trigger below is SEPARATE from guard_profile_pay_columns (that
--     one stays single-sourced, same reasoning as 20260922230000). NOTE it is
--     CHANGE-CONDITIONAL (IS DISTINCT FROM), unlike the pay guard's
--     unconditional revert — do not "harmonize" it to the unconditional
--     style, or writers that send full-row objects (bulk admin tooling,
--     refresh_canvasser_rank-style engines) would need explicit allowances.
--   * The guard ALSO pins team_id on LOCKED rows to manager-tier/service
--     writers. "Users update own profile" (20260627214147) has no column
--     restriction, so a rep could always PATCH their own team_id — before
--     this feature the webhook force-sync self-healed that within minutes,
--     but a locked row is skipped by the webhook, which would have made a
--     self-move permanent (and shown "Pinned by <manager>" provenance for
--     it). Locked-rows-only on purpose: claim_roster_spot (20260911100000,
--     SECURITY DEFINER, caller = the claiming rep) legitimately copies
--     team_id onto the caller's FRESH signup profile, which is always
--     unlocked — a blanket team_id guard would silently strand claimed reps
--     vanless. Unlocked self-moves stay the pre-existing hole, healed by the
--     next Monday card event exactly as before.
--   * No new RLS: captain/office_staff writes ride "Managers update
--     non-privileged profiles" (20260803030000), owners ride "Owners manage
--     profiles"; a canvasser's self-write rides "Users update own profile"
--     and is silently reverted by the guard.
-- Rollback: behavior-only — UPDATE public.profiles SET van_locked_at = NULL,
--   van_locked_by = NULL WHERE van_locked_at IS NOT NULL; (service role)
--   restores exact pre-change behavior with zero redeploys. Full DDL down:
--   DROP TRIGGER IF EXISTS profiles_guard_van_lock ON public.profiles;
--   DROP FUNCTION IF EXISTS public.guard_profile_van_lock();
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS van_locked_by,
--     DROP COLUMN IF EXISTS van_locked_at;
--   CAUTION: the DDL down requires reverting/redeploying the FRONT-END
--   first — the shipped client hard-selects van_locked_at/van_locked_by in
--   the roster query and sends van_locked_at on every move, so dropping the
--   columns under a live deploy 400s the whole fleet-management surface.
--   Only the edge fn is fail-soft against missing columns.
-- Idempotent; apply by hand: supabase db query --linked --file <this file>

-- ── A) Lock columns ──────────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS van_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS van_locked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ── B) Self-edit guard + provenance stamping ─────────────────────────────────
-- "Users update own profile" has no column restriction, so without this a
-- canvasser could unpin (or pin) themself. Manager-tier writers get the lock
-- stamped server-side (now() / auth.uid()) so clients never dictate
-- provenance; service-role writers (webhook, server fns, SQL tooling) pass
-- values through as sent.
CREATE OR REPLACE FUNCTION public.guard_profile_van_lock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.van_locked_at IS DISTINCT FROM OLD.van_locked_at
     OR NEW.van_locked_by IS DISTINCT FROM OLD.van_locked_by THEN
    IF auth.uid() IS NULL THEN
      RETURN NEW;  -- service role / server tooling: values pass as sent
    ELSIF public.has_role(auth.uid(), 'owner'::app_role)
       OR public.has_role(auth.uid(), 'office_staff'::app_role)
       OR public.has_role(auth.uid(), 'captain'::app_role) THEN
      IF NEW.van_locked_at IS NOT NULL THEN
        NEW.van_locked_at := now();       -- server owns provenance
        NEW.van_locked_by := auth.uid();  -- (stamp_turf_assignment precedent)
      ELSE
        NEW.van_locked_by := NULL;        -- unlock clears both
      END IF;
    ELSE
      NEW.van_locked_at := OLD.van_locked_at;  -- silent revert, pay-guard idiom
      NEW.van_locked_by := OLD.van_locked_by;
    END IF;
  END IF;
  -- A LOCKED row's team_id is manager-tier/service-only (see header): the
  -- webhook skips locked rows, so a self-move would otherwise stick forever.
  -- Unlocked rows keep the pre-existing self-edit behavior (Monday heals).
  IF OLD.van_locked_at IS NOT NULL
     AND NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    IF auth.uid() IS NULL
       OR public.has_role(auth.uid(), 'owner'::app_role)
       OR public.has_role(auth.uid(), 'office_staff'::app_role)
       OR public.has_role(auth.uid(), 'captain'::app_role) THEN
      NULL;  -- allowed
    ELSE
      NEW.team_id := OLD.team_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.guard_profile_van_lock() FROM PUBLIC, authenticated, anon;

DROP TRIGGER IF EXISTS profiles_guard_van_lock ON public.profiles;
CREATE TRIGGER profiles_guard_van_lock
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_van_lock();
