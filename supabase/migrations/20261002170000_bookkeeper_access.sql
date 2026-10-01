-- ═══════════════════════════════════════════════════════════════════════════
-- BOOKKEEPER ACCESS (owner-approved 2026-10-01, for Mary).
--
-- Read-only arms for the bookkeeper role across the time + payroll surface,
-- plus the leads/daily_logs reads she needs to verify commission inputs
-- (the clawback-outstanding view is security_invoker over leads — without a
-- leads read its 'collect' arm is invisible to her). ZERO write arms
-- anywhere: the record-keeper and the auditor stay separate people.
--
-- Also:
--   · auto_archive_agents v4 — a desk role with no door metrics must not
--     age off the roster (archive = BANNED login since 20260916100000).
--   · timesheet_day_detail — one-select per-day punch detail for the CA
--     records export (security_invoker: whoever selects sees only what
--     their own RLS admits).
--   · time_entry_audit(happened_at) index for date-range audit exports.
--
-- Requires 20261002160000_bookkeeper_role_enum.sql applied FIRST (its own
-- execution).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) Read arms (recreate each SELECT policy with the bookkeeper OR) ───────

DROP POLICY IF EXISTS "Users view own time entries" ON public.time_entries;
CREATE POLICY "Users view own time entries" ON public.time_entries
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper'));

DROP POLICY IF EXISTS "meal read own or staff" ON public.meal_periods;
CREATE POLICY "meal read own or staff" ON public.meal_periods
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper'));

DROP POLICY IF EXISTS "audit read own or staff" ON public.time_entry_audit;
CREATE POLICY "audit read own or staff" ON public.time_entry_audit
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.time_entries te
                 WHERE te.id = time_entry_audit.time_entry_id
                   AND te.user_id = auth.uid())
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper'));

DROP POLICY IF EXISTS "passes read own or staff" ON public.time_clock_exceptions;
CREATE POLICY "passes read own or staff" ON public.time_clock_exceptions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper'));

DROP POLICY IF EXISTS "attestations read own or staff" ON public.time_week_attestations;
CREATE POLICY "attestations read own or staff" ON public.time_week_attestations
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper'));

DROP POLICY IF EXISTS "runs staff read" ON public.payroll_runs;
CREATE POLICY "runs staff read" ON public.payroll_runs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'bookkeeper'));

DROP POLICY IF EXISTS "lines read own or staff" ON public.payroll_run_lines;
CREATE POLICY "lines read own or staff" ON public.payroll_run_lines
  FOR SELECT TO authenticated
  USING (canvasser_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'bookkeeper'));

DROP POLICY IF EXISTS "clawbacks read own or staff" ON public.commission_clawbacks;
CREATE POLICY "clawbacks read own or staff" ON public.commission_clawbacks
  FOR SELECT TO authenticated
  USING (canvasser_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'bookkeeper'));

DROP POLICY IF EXISTS "Managers view all profiles" ON public.profiles;
CREATE POLICY "Managers view all profiles"
  ON public.profiles FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'captain'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'bookkeeper'::app_role)
  );

DROP POLICY IF EXISTS "Managers view all teams" ON public.teams;
CREATE POLICY "Managers view all teams"
  ON public.teams FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'captain'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'bookkeeper'::app_role)
  );

DROP POLICY IF EXISTS "Managers read all roles" ON public.user_roles;
CREATE POLICY "Managers read all roles"
  ON public.user_roles FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'captain'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'bookkeeper'::app_role)
  );

-- Commission verification: sale amounts + production the pay engine reads.
DROP POLICY IF EXISTS "leads read scoped" ON public.leads;
CREATE POLICY "leads read scoped"
  ON public.leads FOR SELECT
  USING (
    canvasser_id = auth.uid()
    OR public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'captain'::app_role)
    OR public.has_role(auth.uid(), 'bookkeeper'::app_role)
  );

DROP POLICY IF EXISTS "daily_logs read scoped" ON public.daily_logs;
CREATE POLICY "daily_logs read scoped"
  ON public.daily_logs FOR SELECT
  USING (
    canvasser_id = auth.uid()
    OR public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'captain'::app_role)
    OR public.has_role(auth.uid(), 'bookkeeper'::app_role)
  );

-- ── 2) auto_archive_agents v4: bookkeeper joins the desk-role exemption ─────
--       (full body from 20260916100000; ONE list change)

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
    -- Time-clock punches count as activity alongside door metrics, so
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
      -- Never auto-archive desk/closer roles — no door metrics is their
      -- permanent, correct state. Removing THEM is always a human action
      -- (Manage Players), which now also revokes their login. bookkeeper
      -- added 2026-10-02: Mary never knocks a door.
      AND NOT EXISTS (
        SELECT 1 FROM public.user_roles r
        WHERE r.user_id = p.id
          AND r.role IN ('sales_rep'::app_role, 'confirmer'::app_role,
                         'office_staff'::app_role, 'bookkeeper'::app_role)
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

-- ── 3) The CA records view: per-day punch detail in one select ──────────────

CREATE OR REPLACE VIEW public.timesheet_day_detail
WITH (security_invoker = on) AS
SELECT te.id,
       te.user_id,
       p.display_name,
       t.name AS team_name,
       te.log_date,
       te.clock_in,
       te.clock_out,
       te.billable_hours,
       te.meal_status,
       te.second_meal_status,
       te.entry_source,
       te.flag_reasons,
       te.needs_correction,
       te.reviewed_by,
       te.reviewed_at,
       te.voided_at,
       te.void_reason,
       m.meal_count,
       m.meal_minutes,
       m.first_meal_start,
       m.last_meal_end
FROM public.time_entries te
LEFT JOIN public.profiles p ON p.id = te.user_id
LEFT JOIN public.teams t ON t.id = p.team_id
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS meal_count,
         ROUND(SUM(EXTRACT(EPOCH FROM (mp.meal_end - mp.meal_start)) / 60.0)) AS meal_minutes,
         MIN(mp.meal_start) AS first_meal_start,
         MAX(mp.meal_end)  AS last_meal_end
  FROM public.meal_periods mp
  WHERE mp.time_entry_id = te.id AND mp.meal_end IS NOT NULL
    AND mp.meal_end > mp.meal_start
) m ON true;

GRANT SELECT ON public.timesheet_day_detail TO authenticated;

CREATE INDEX IF NOT EXISTS time_entry_audit_happened_idx
  ON public.time_entry_audit(happened_at);
