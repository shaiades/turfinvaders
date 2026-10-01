-- ═══════════════════════════════════════════════════════════════════════════
-- DAY-OFF / ABSENCE SYSTEM (owner-approved 2026-10-01).
--
-- Before this, an approved day off and a no-show looked identical — "no
-- punch" — on dispatch, the suspension board, and the Daily Wrap. Now:
--
--   · Anyone requests their OWN day off from their phone (born 'pending').
--   · The van captain approves/denies their crew's requests (never their
--     own — a captain's own request waits for an Admin). Deny needs a note.
--   · Captains and Admins can directly MARK a crew member sick / no-show /
--     excused: a record, not a request — born 'approved' with the review
--     stamp (a captain marking THEMSELF falls back to 'pending').
--   · Revoke-not-delete: cancelled/denied rows are the history.
--   · Two-way push via notify-day-off (clone of the dojo loop): reviewers
--     on submit, the worker on the outcome or when marked absent.
--
-- Shape precedents: time_clock_exceptions (one active row per person/day),
-- objection_attempts (status lifecycle + born-pending doctrine),
-- approve_time_entry (captain own-team-never-self checks).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.day_off_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  absence_date date NOT NULL,            -- one LA calendar day per row
  kind text NOT NULL CHECK (kind IN ('day_off','sick','no_show','excused','other')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','cancelled')),
  reason text,
  requested_by uuid NOT NULL,            -- self, their captain, or an Admin
  reviewed_by uuid,
  reviewed_at timestamptz,
  deny_reason text,
  cancelled_at timestamptz,
  cancelled_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX day_off_requests_user_date_idx ON public.day_off_requests(user_id, absence_date);
CREATE INDEX day_off_requests_date_idx ON public.day_off_requests(absence_date)
  WHERE status = 'approved';
-- One LIVE row (pending or approved) per person per day.
CREATE UNIQUE INDEX day_off_requests_one_active
  ON public.day_off_requests(user_id, absence_date)
  WHERE status IN ('pending','approved');

GRANT SELECT ON public.day_off_requests TO authenticated;
GRANT ALL ON public.day_off_requests TO service_role;
ALTER TABLE public.day_off_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "day off read own or staff" ON public.day_off_requests
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain')
         OR public.has_role(auth.uid(), 'bookkeeper'));
-- No write policies: the RPCs below are the only write path.

-- ── RPCs ────────────────────────────────────────────────────────────────────

-- Submit one or more days. Self: a REQUEST (born pending; kinds a worker
-- may claim). Captain (own team) / Admin for someone else: a RECORD (born
-- approved + review-stamped). Per-date skip-and-report; authorization is
-- the only RAISE.
CREATE OR REPLACE FUNCTION public.submit_day_off(
  _user_id uuid, _dates date[], _kind text, _reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _is_admin boolean := public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff');
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
      IF NOT _is_captain THEN RAISE EXCEPTION 'not authorized'; END IF;
      IF public.my_team_id(auth.uid()) IS NULL
         OR public.my_team_id(_user_id) IS DISTINCT FROM public.my_team_id(auth.uid()) THEN
        RAISE EXCEPTION 'captains record absences for their own team only';
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

-- Approve or deny a PENDING request. Admins: anyone. Captains: own team,
-- never their own. Deny requires the note the worker will read.
CREATE OR REPLACE FUNCTION public.review_day_off(
  _id uuid, _approve boolean, _deny_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row record;
  _is_admin boolean := public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff');
BEGIN
  SELECT user_id, status INTO _row FROM public.day_off_requests WHERE id = _id;
  IF _row.user_id IS NULL THEN RAISE EXCEPTION 'request not found'; END IF;
  IF _row.status <> 'pending' THEN RAISE EXCEPTION 'only pending requests can be reviewed'; END IF;

  IF NOT _is_admin THEN
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
END $$;

-- Cancel a live row: the worker (their own; approved rows only while the
-- day is still ahead), whoever entered it, captains (own team), Admins.
CREATE OR REPLACE FUNCTION public.cancel_day_off(_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row record;
  _is_admin boolean := public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff');
  _today_la date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  _allowed boolean := false;
BEGIN
  SELECT user_id, status, absence_date, requested_by INTO _row
  FROM public.day_off_requests WHERE id = _id;
  IF _row.user_id IS NULL THEN RAISE EXCEPTION 'request not found'; END IF;
  IF _row.status NOT IN ('pending','approved') THEN
    RAISE EXCEPTION 'only pending or approved rows can be cancelled';
  END IF;

  IF _is_admin OR _row.requested_by = auth.uid() THEN
    _allowed := true;
  ELSIF _row.user_id = auth.uid() THEN
    _allowed := (_row.status = 'pending' OR _row.absence_date >= _today_la);
  ELSIF public.has_role(auth.uid(), 'captain')
        AND public.my_team_id(auth.uid()) IS NOT NULL
        AND public.my_team_id(_row.user_id) = public.my_team_id(auth.uid()) THEN
    _allowed := true;
  END IF;
  IF NOT _allowed THEN RAISE EXCEPTION 'not authorized'; END IF;

  UPDATE public.day_off_requests
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  WHERE id = _id;
END $$;

REVOKE ALL ON FUNCTION public.submit_day_off(uuid, date[], text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_day_off(uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_day_off(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_day_off(uuid, date[], text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_day_off(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_day_off(uuid) TO authenticated;

-- ── Two-way push (dojo doctrine: a push failure NEVER breaks the write) ─────

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.notify_day_off_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _secret text;
  _kind text;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    _kind := 'submission';                       -- worker asked → tell reviewers
  ELSIF TG_OP = 'INSERT' AND NEW.status = 'approved' THEN
    _kind := 'record';                           -- marked absent → tell the worker
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'pending'
        AND NEW.status IN ('approved', 'denied') THEN
    _kind := 'outcome';                          -- reviewed → tell the worker
  ELSE
    RETURN NEW;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO _secret
    FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
    IF _secret IS NULL OR _secret = '' THEN RETURN NEW; END IF;

    PERFORM net.http_post(
      url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/notify-day-off',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-notify-secret', _secret
      ),
      body := jsonb_build_object(
        'kind', _kind,
        'request_id', NEW.id,
        'user_id', NEW.user_id,
        'requested_by', NEW.requested_by,
        'reviewed_by', NEW.reviewed_by,
        'absence_date', NEW.absence_date,
        'absence_kind', NEW.kind,
        'status', NEW.status,
        'deny_reason', NEW.deny_reason
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- a notification must NEVER break a request or a review
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS day_off_requests_notify ON public.day_off_requests;
CREATE TRIGGER day_off_requests_notify
  AFTER INSERT OR UPDATE OF status ON public.day_off_requests
  FOR EACH ROW EXECUTE FUNCTION public.notify_day_off_request();

-- ── Realtime: the approval queues update live ───────────────────────────────

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.day_off_requests;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
