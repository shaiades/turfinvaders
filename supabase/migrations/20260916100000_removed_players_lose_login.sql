-- Removing a player now removes their LOGIN, not just their roster spot
-- (owner ask 2026-09-16). Every removal surface already funnels into
-- profiles.is_active = false — archive_agent (Remove from roster),
-- auto_archive_agents (nightly sweep), deleteProfile's archive branch,
-- merge_canvassers' archived losers — and reactivate_agent flips it back.
-- So the enforcement point is a trigger on that column: archived => the
-- matching auth.users row is banned (GoTrue then refuses new sign-ins AND
-- refresh-token grants; an in-flight access token dies at its normal
-- expiry, and the app shell's AccessRevokedScreen kicks open sessions
-- immediately). Reactivated => ban lifted, login works again.
--
-- History is deliberately untouched everywhere in this file: nothing here
-- writes daily_logs / daily_metrics / leads / payroll / user_roles. Boards,
-- Close Kombat, and former-member history (PR #126 snapshot rules) keep
-- counting removed people exactly as before.
--
-- BUT is_active=false does not currently mean "removed" for everyone
-- (verified in prod 2026-09-16): the nightly sweep archives anyone with no
-- daily_metrics for 14 days, and desk/closer roles produce no door metrics
-- BY DESIGN — all 18 sales_rep accounts sat archived while 11 of them
-- worked Close Kombat that same week, and the sweep also missed time-clock
-- punches (Jorge N: punched 9/15, swept 9/16 because his door metrics went
-- stale). Banning on the flag as-is would have locked out the working
-- closer crew. So this migration first makes the flag TRUE, then enforces
-- it:
--   1) sweep fix — desk roles (sales_rep / confirmer / office_staff) are
--      never auto-archived, and time-clock punches count as activity;
--   2) data repair — reactivate the rows only the broken sweep produced;
--   3) ban trigger — archived <=> banned, from now on;
--   4) backfill — everyone still archived with a login loses it today.
--
-- Notes:
--   * banned_until uses a concrete far-future timestamp, NOT 'infinity' —
--     GoTrue scans the column into a Go time.Time, which 'infinity' breaks.
--   * Owner-role accounts are never banned here, whatever is_active says —
--     archive_agent already refuses owners, but a stray manual UPDATE must
--     not be able to lock out the only person who could undo it.
--   * Placeholder profiles (board-minted, no auth user) match zero rows in
--     auth.users — the ban UPDATE is a no-op for them.
--   * NULL is_active counts as active (legacy Fleet Manager semantics), so
--     only an explicit false bans.

-- ---------------------------------------------------------------------------
-- 1) Sweep fix. Body from 20260812010000 (cron/service guard kept, grants
--    kept); two changes marked NEW. The sweep is CANVASSING-roster hygiene:
--    people whose job never produces door metrics must not age off it.
CREATE OR REPLACE FUNCTION public.auto_archive_agents()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _cutoff timestamptz := now() - interval '14 days';
  _archived integer := 0;
BEGIN
  -- Cron / service contexts carry no JWT. A signed-in user (any role) must
  -- not be able to fire a bulk archive sweep.
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'auto_archive_agents runs from cron/service contexts only';
  END IF;

  WITH last_activity AS (
    -- NEW: time-clock punches count as activity alongside door metrics, so
    -- a working agent whose door counters lag (training days, ride-alongs)
    -- doesn't get archived — and, now that archive bans, locked out.
    SELECT user_id, MAX(last_date) AS last_date
    FROM (
      SELECT canvasser_id AS user_id, MAX(metric_date) AS last_date
      FROM public.daily_metrics GROUP BY 1
      UNION ALL
      SELECT user_id, MAX(clock_in)::date AS last_date
      FROM public.time_entries GROUP BY 1
    ) activity
    GROUP BY 1
  ),
  targets AS (
    SELECT p.id
    FROM public.profiles p
    LEFT JOIN last_activity la ON la.user_id = p.id
    WHERE p.is_active = true
      AND (
        (la.last_date IS NOT NULL AND la.last_date < (_cutoff)::date)
        OR (la.last_date IS NULL AND p.created_at < _cutoff)
      )
      -- Never archive owners.
      AND NOT public.has_role(p.id, 'owner'::app_role)
      -- NEW: never auto-archive desk/closer roles — no door metrics is
      -- their permanent, correct state. Removing THEM is always a human
      -- action (Manage Players), which now also revokes their login.
      AND NOT EXISTS (
        SELECT 1 FROM public.user_roles r
        WHERE r.user_id = p.id
          AND r.role IN ('sales_rep'::app_role, 'confirmer'::app_role, 'office_staff'::app_role)
      )
  )
  UPDATE public.profiles p
  SET is_active = false,
      team_id = NULL,
      updated_at = now()
  FROM targets t
  WHERE p.id = t.id;

  GET DIAGNOSTICS _archived = ROW_COUNT;
  RETURN _archived;
END;
$$;

REVOKE ALL ON FUNCTION public.auto_archive_agents() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_archive_agents() TO service_role;

-- ---------------------------------------------------------------------------
-- 2) Data repair, BEFORE the trigger exists so these flips can't touch
--    auth.users. Reactivate exactly the rows the old sweep archived wrongly:
--    (a) desk/closer roles — the fixed sweep never targets them, and their
--        archived state was meaningless noise (their app ignores it);
--    (b) anyone with a time-clock punch inside the window — the old sweep
--        couldn't see punches (Jorge N's case). Door-metrics-fresh rows are
--        deliberately NOT repaired: the sweep can't archive those, so an
--        archived row with fresh metrics was a HUMAN removal and stays
--        removed (Parsa, removed 9/15).
--    team_id stays NULL — reactivation never re-vans anyone (matches
--    reactivate_agent semantics).
UPDATE public.profiles p
SET is_active = true, updated_at = now()
WHERE p.is_active IS NOT DISTINCT FROM false
  AND (
    EXISTS (
      SELECT 1 FROM public.user_roles r
      WHERE r.user_id = p.id
        AND r.role IN ('sales_rep'::app_role, 'confirmer'::app_role, 'office_staff'::app_role)
    )
    OR EXISTS (
      SELECT 1 FROM public.time_entries t
      WHERE t.user_id = p.id
        AND t.clock_in >= now() - interval '14 days'
    )
  );

-- ---------------------------------------------------------------------------
-- 3) The ban trigger: archived <=> banned, whatever surface does the write.
CREATE OR REPLACE FUNCTION public.sync_removed_player_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _ban_until CONSTANT timestamptz := '3000-01-01 00:00:00+00';
BEGIN
  IF NEW.is_active IS NOT DISTINCT FROM false THEN
    IF NOT public.has_role(NEW.id, 'owner'::app_role) THEN
      UPDATE auth.users
      SET banned_until = _ban_until
      WHERE id = NEW.id
        AND (banned_until IS DISTINCT FROM _ban_until);
    END IF;
  ELSE
    -- Reactivated (or inserted active): lift any ban so the login works the
    -- moment they're back on the roster.
    UPDATE auth.users
    SET banned_until = NULL
    WHERE id = NEW.id
      AND banned_until IS NOT NULL;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.sync_removed_player_access() FROM PUBLIC, anon, authenticated;

-- INSERT is included so a row minted directly in the archived state (e.g. a
-- future import of former members) locks its login on arrival. UPDATE OF
-- is_active fires whenever the column is assigned; the function's own
-- IS DISTINCT FROM guards make re-archiving an already-banned account a
-- no-op instead of a churn write.
DROP TRIGGER IF EXISTS trg_profiles_sync_removed_access ON public.profiles;
CREATE TRIGGER trg_profiles_sync_removed_access
AFTER INSERT OR UPDATE OF is_active ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.sync_removed_player_access();

-- ---------------------------------------------------------------------------
-- 4) Backfill: everyone still archived after the repair loses login today,
--    same owner-role exclusion as the trigger.
UPDATE auth.users u
SET banned_until = '3000-01-01 00:00:00+00'::timestamptz
FROM public.profiles p
WHERE p.id = u.id
  AND p.is_active IS NOT DISTINCT FROM false
  AND NOT public.has_role(u.id, 'owner'::app_role)
  AND (u.banned_until IS DISTINCT FROM '3000-01-01 00:00:00+00'::timestamptz);
