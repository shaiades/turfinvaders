-- ═══════════════════════════════════════════════════════════════════════════
-- CA COMPLIANCE PHASE 3 — ADMIN HUB BACKEND FIXES
-- (owner ask 2026-10-14: "simplify the time clock for admins… view it by
-- week, hours, month". The views live in the app; this migration carries
-- the two data-layer fixes the audit flagged.)
--
-- 1) approve_payroll_run v3: the approval blockers are counted LIVE from
--    the week's time entries, not from the draft's snapshotted exceptions.
--    The snapshot goes stale the moment an entry changes after the draft is
--    created — an edit could add a flagged entry and the old check would
--    approve right past it. (The open-shift check was already live.)
--
-- 2) timesheet_day_detail +meal_windows: the punch-detail export showed
--    only the first meal start and last meal end, silently dropping the
--    middle punches of a multi-meal day from the LC 1174 record. Every
--    meal's window now exports as "HH:MM–HH:MM; …" (PT).
--
-- Replaces (full bodies):
--   approve_payroll_run   v2 → v3   (20261002140000)
--   timesheet_day_detail  +meal_windows (20261022120000)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) approve v3: blockers counted live ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.approve_payroll_run(_run_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _flagged int; _meal_pending int; _open int; _ws date;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  SELECT week_start INTO _ws FROM public.payroll_runs WHERE id = _run_id;
  IF _ws IS NULL THEN RAISE EXCEPTION 'run not found'; END IF;
  -- An open shift would be closed LATER by the auto-close cron — a service
  -- write the freeze guards exempt — silently changing an approved week.
  SELECT COUNT(*) INTO _open
  FROM public.time_entries te
  WHERE te.log_date BETWEEN _ws AND _ws + 6
    AND te.clock_out IS NULL AND te.voided_at IS NULL;
  IF _open > 0 THEN
    RAISE EXCEPTION '% open shift(s) in this week — close them before approving', _open;
  END IF;
  -- Blockers are counted LIVE (v2 read the draft's snapshotted exceptions,
  -- which drift the moment an entry changes after the draft was created).
  -- The draft's PAY figures can drift too — approving freezes the snapshot,
  -- so the error says to re-create when anything is unresolved.
  SELECT COUNT(*) FILTER (WHERE te.needs_correction),
         COUNT(*) FILTER (WHERE te.meal_status = 'pending')
    INTO _flagged, _meal_pending
  FROM public.time_entries te
  WHERE te.log_date BETWEEN _ws AND _ws + 6
    AND te.clock_out IS NOT NULL AND te.voided_at IS NULL;
  IF _flagged > 0 OR _meal_pending > 0 THEN
    RAISE EXCEPTION '% flagged entr(ies) and % unattested meal(s) in this week — resolve them, then RE-CREATE the draft so the snapshot is current, and approve that',
      _flagged, _meal_pending;
  END IF;
  UPDATE public.payroll_runs
  SET status = 'approved', approved_by = auth.uid(), approved_at = now()
  WHERE id = _run_id AND status = 'draft';
  IF NOT FOUND THEN RAISE EXCEPTION 'run not found or already approved'; END IF;
END $$;

-- ── 2) timesheet_day_detail: every meal window, not just the envelope ────────

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
       m.last_meal_end,
       te.rest_break_status,
       m.meal_windows
FROM public.time_entries te
LEFT JOIN public.profiles p ON p.id = te.user_id
LEFT JOIN public.teams t ON t.id = p.team_id
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS meal_count,
         ROUND(SUM(EXTRACT(EPOCH FROM (mp.meal_end - mp.meal_start)) / 60.0)) AS meal_minutes,
         MIN(mp.meal_start) AS first_meal_start,
         MAX(mp.meal_end)  AS last_meal_end,
         string_agg(
           to_char(mp.meal_start AT TIME ZONE 'America/Los_Angeles', 'HH24:MI')
             || '–'
             || to_char(mp.meal_end AT TIME ZONE 'America/Los_Angeles', 'HH24:MI'),
           '; ' ORDER BY mp.meal_start) AS meal_windows
  FROM public.meal_periods mp
  WHERE mp.time_entry_id = te.id AND mp.meal_end IS NOT NULL
    AND mp.meal_end > mp.meal_start
) m ON true;

GRANT SELECT ON public.timesheet_day_detail TO authenticated;
