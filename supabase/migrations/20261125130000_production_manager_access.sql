-- ═══════════════════════════════════════════════════════════════════════════
-- PRODUCTION MANAGER — ACCESS (owner ask 2026-11-24: Austin Mills).
-- Requires 20261125120000_production_manager_enum.sql applied FIRST
-- (its own execution).
--
-- A production_manager is an office-tier worker (clocks in/out like office,
-- 20:00 auto-close, own time-off goes to the named approvers) who ALSO
-- oversees production-role staff: sees their time cards, approves/denies
-- their time-off, and records sick days for them. Scope is strictly
-- "viewer has production_manager AND the worker has production" — no other
-- roles become visible.
--
--   1) is_office_worker v2 — tier gains production_manager. Re-emitted v1
--      (20261124190000). Mirrors OFFICE_WORKER_ROLES in role-policy.ts and
--      the notify-day-off edge fn — change them together.
--   2) Read policies — time_entries / meal_periods / day_off_requests SELECT
--      gain the PM-over-production arm. Re-emitted from
--      20261025130000_hr_role_access.sql (existing role lists kept intact).
--   3) submit_day_off v3 — PM may record absences (incl. sick) for
--      production staff. Re-emitted current prod v2.
--   4) review_day_off v6 — PM may approve/deny production staff's pending
--      requests. Re-emitted v5 (20261124190000).
--
-- set_user_role is unchanged: production_manager is owner-granted only
-- (like hr/bookkeeper) — it is NOT in the Manager-grantable list.
--
-- The notify-day-off edge function gains the matching audience change —
-- deploy it with this file:
--   supabase functions deploy notify-day-off --no-verify-jwt
--
-- Idempotent; applied via: supabase db query --linked --file <this file>
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) is_office_worker v2: production_manager joins the tier ────────────────

CREATE OR REPLACE FUNCTION public.is_office_worker(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND role IN ('office'::app_role, 'production'::app_role,
                   'receptionist'::app_role, 'production_manager'::app_role)
  )
$$;

REVOKE ALL ON FUNCTION public.is_office_worker(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_office_worker(uuid) TO authenticated, service_role;

-- ── 2) Read policies: PM sees production staff's records ─────────────────────
-- Same bodies as 20261025130000 plus the one new OR arm.

DROP POLICY IF EXISTS "Users view own time entries" ON public.time_entries;
CREATE POLICY "Users view own time entries" ON public.time_entries
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper')
         OR public.has_role(auth.uid(), 'hr')
         OR (public.has_role(auth.uid(), 'production_manager')
             AND public.has_role(user_id, 'production')));

DROP POLICY IF EXISTS "meal read own or staff" ON public.meal_periods;
CREATE POLICY "meal read own or staff" ON public.meal_periods
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper')
         OR public.has_role(auth.uid(), 'hr')
         OR (public.has_role(auth.uid(), 'production_manager')
             AND public.has_role(user_id, 'production')));

DROP POLICY IF EXISTS "day off read own or staff" ON public.day_off_requests;
CREATE POLICY "day off read own or staff" ON public.day_off_requests
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper')
         OR public.has_role(auth.uid(), 'hr')
         OR (public.has_role(auth.uid(), 'production_manager')
             AND public.has_role(user_id, 'production')));

-- ── 3) submit_day_off v3: PM records absences for production staff ───────────
-- Identical to prod v2 except the new PM arm in the for-someone-else branch.
-- A PM entry for someone else is a record (auto-approved), same as a
-- captain's — a recorded sick day draws paid sick leave immediately.

CREATE OR REPLACE FUNCTION public.submit_day_off(
  _user_id uuid, _dates date[], _kind text, _reason text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _is_admin boolean := public.is_time_admin(auth.uid());
  _is_captain boolean := public.has_role(auth.uid(), 'captain');
  _self boolean := (_user_id = auth.uid());
  _as_record boolean;
  _d date;
  _code text;
  _new_id uuid;
  _results jsonb := '[]'::jsonb;
  _ok int := 0;
  _skipped int := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF _dates IS NULL OR array_length(_dates, 1) IS NULL OR array_length(_dates, 1) > 31 THEN
    RAISE EXCEPTION 'pick 1–31 days';
  END IF;

  IF _self THEN
    IF _kind NOT IN ('day_off','sick','other') THEN
      RAISE EXCEPTION 'you can request a day off or call in sick — other kinds are entered by your captain';
    END IF;
  ELSE
    IF NOT _is_admin THEN
      -- Production manager records absences for production staff
      -- (owner ask 2026-11-24: Austin marks production people sick).
      IF public.has_role(auth.uid(), 'production_manager')
         AND public.has_role(_user_id, 'production') THEN
        NULL;
      ELSE
        IF NOT _is_captain THEN RAISE EXCEPTION 'not authorized'; END IF;
        IF public.my_team_id(auth.uid()) IS NULL
           OR public.my_team_id(_user_id) IS DISTINCT FROM public.my_team_id(auth.uid()) THEN
          RAISE EXCEPTION 'captains record absences for their own team only';
        END IF;
      END IF;
    END IF;
  END IF;

  -- A manager/captain entry for someone ELSE is a record, auto-approved.
  -- Anything for yourself — captain included — awaits someone else's review.
  _as_record := NOT _self;

  FOR _d IN SELECT DISTINCT u FROM unnest(_dates) u ORDER BY 1 LOOP
    BEGIN
      _code := NULL;
      IF EXISTS (SELECT 1 FROM public.day_off_requests r
                 WHERE r.user_id = _user_id AND r.absence_date = _d
                   AND r.status IN ('pending','approved')) THEN
        _code := 'already_requested';
      ELSE
        INSERT INTO public.day_off_requests
          (user_id, absence_date, kind, status, reason, requested_by, reviewed_by, reviewed_at)
        VALUES
          (_user_id, _d, _kind,
           CASE WHEN _as_record THEN 'approved' ELSE 'pending' END,
           NULLIF(btrim(COALESCE(_reason, '')), ''),
           auth.uid(),
           CASE WHEN _as_record THEN auth.uid() END,
           CASE WHEN _as_record THEN now() END)
        RETURNING id INTO _new_id;
        -- A recorded (auto-approved) sick day draws paid sick leave now.
        IF _as_record AND _kind = 'sick' THEN
          PERFORM public.apply_sick_usage(_new_id);
        END IF;
        _ok := _ok + 1;
        _results := _results || jsonb_build_object('date', _d, 'status', 'ok', 'id', _new_id);
        CONTINUE;
      END IF;
      _skipped := _skipped + 1;
      _results := _results || jsonb_build_object('date', _d, 'status', 'skipped', 'code', _code);
    EXCEPTION
      WHEN unique_violation THEN
        _skipped := _skipped + 1;
        _results := _results || jsonb_build_object('date', _d, 'status', 'skipped', 'code', 'already_requested');
      WHEN OTHERS THEN
        _skipped := _skipped + 1;
        _results := _results || jsonb_build_object('date', _d, 'status', 'error', 'code', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', _ok, 'skipped', _skipped, 'results', _results);
END $$;

REVOKE ALL ON FUNCTION public.submit_day_off(uuid, date[], text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_day_off(uuid, date[], text, text) TO authenticated, service_role;

-- ── 4) review_day_off v6: PM approves/denies production staff's requests ─────
-- Identical to v5 (20261124190000) except the PM arm inside the office-tier
-- branch. The PM's OWN requests still go to the named approvers: the PM holds
-- production_manager, not production, so the arm never matches self.

CREATE OR REPLACE FUNCTION public.review_day_off(
  _id uuid, _approve boolean, _deny_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row record;
  _is_admin boolean := public.is_time_admin(auth.uid());
  _approvers uuid[];
BEGIN
  SELECT user_id, status, kind INTO _row FROM public.day_off_requests WHERE id = _id;
  IF _row.user_id IS NULL THEN RAISE EXCEPTION 'request not found'; END IF;
  IF _row.status <> 'pending' THEN RAISE EXCEPTION 'only pending requests can be reviewed'; END IF;

  -- Office-tier requests are reviewed ONLY by the named approvers (owner
  -- decisions 2026-11-23/24) — plus the production manager for production
  -- staff (owner ask 2026-11-24). Empty list = not configured yet → admin rule.
  IF public.is_office_worker(_row.user_id) THEN
    IF public.has_role(auth.uid(), 'production_manager')
       AND public.has_role(_row.user_id, 'production')
       AND _row.user_id <> auth.uid() THEN
      NULL;  -- production manager reviews production staff
    ELSE
      _approvers := public.office_timeoff_approver_ids();
      IF array_length(_approvers, 1) IS NOT NULL THEN
        IF NOT (auth.uid() = ANY(_approvers)) THEN
          RAISE EXCEPTION 'office time-off is reviewed by the named owners only';
        END IF;
      ELSIF NOT _is_admin THEN
        RAISE EXCEPTION 'not authorized';
      END IF;
    END IF;
  ELSIF NOT _is_admin THEN
    IF NOT public.has_role(auth.uid(), 'captain') THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
    IF public.my_team_id(auth.uid()) IS NULL
       OR public.my_team_id(_row.user_id) IS DISTINCT FROM public.my_team_id(auth.uid()) THEN
      RAISE EXCEPTION 'captains review requests for their own team only';
    END IF;
    IF _row.user_id = auth.uid() THEN
      RAISE EXCEPTION 'you cannot review your own request — ask a manager';
    END IF;
  END IF;

  IF NOT _approve AND COALESCE(btrim(_deny_reason), '') = '' THEN
    RAISE EXCEPTION 'a note is required to deny — the worker reads it';
  END IF;

  UPDATE public.day_off_requests
  SET status = CASE WHEN _approve THEN 'approved' ELSE 'denied' END,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      deny_reason = CASE WHEN _approve THEN NULL ELSE btrim(_deny_reason) END
  WHERE id = _id;

  -- An approved sick request draws paid sick leave.
  IF _approve AND _row.kind = 'sick' THEN
    PERFORM public.apply_sick_usage(_id);
  END IF;
END $$;
