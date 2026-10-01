-- ═══════════════════════════════════════════════════════════════════════════
-- WEEKLY HOURS ATTESTATION (owner-approved 2026-10-01).
--
-- The worker's own sign-off on their week: "these hours are right" or
-- "something's wrong" + a note. With captains and managers able to enter and
-- correct punches, the worker's contemporaneous confirmation is the record
-- that makes those third-party entries defensible in a wage dispute — and a
-- dispute is a flare the office sees BEFORE payroll, not a complaint months
-- later.
--
--   · Supersede-not-delete: re-attesting stamps the old row superseded_at
--     and inserts a new one; nothing is ever erased.
--   · hours_at_attestation snapshots what the worker SAW when signing, so
--     a later correction can't make the sign-off look like it covered
--     different hours.
--   · SOFT payroll gate: create_payroll_run (v4, next migration) stamps
--     each line's exceptions with the attestation state; approval is NOT
--     blocked — unattested/disputed chips are for run review eyes.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.time_week_attestations (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  week_start date NOT NULL,          -- the LA Monday of the attested week
  status text NOT NULL CHECK (status IN ('confirmed','disputed')),
  note text,                         -- required when disputed
  hours_at_attestation numeric,      -- billable hours shown at sign-off
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
);

CREATE UNIQUE INDEX time_week_attestations_one_active
  ON public.time_week_attestations(user_id, week_start) WHERE superseded_at IS NULL;
CREATE INDEX time_week_attestations_week_idx ON public.time_week_attestations(week_start);

GRANT SELECT ON public.time_week_attestations TO authenticated;
GRANT ALL ON public.time_week_attestations TO service_role;
ALTER TABLE public.time_week_attestations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "attestations read own or staff" ON public.time_week_attestations
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'owner')
         OR public.has_role(auth.uid(), 'office_staff')
         OR public.has_role(auth.uid(), 'captain'));
-- No write policies: attest_week is the only write path.

CREATE OR REPLACE FUNCTION public.attest_week(
  _week_start date, _confirm boolean, _note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _today_la date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  _hours numeric;
  _new_id uuid;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF EXTRACT(ISODOW FROM _week_start)::int <> 1 THEN
    RAISE EXCEPTION 'week_start must be a Monday';
  END IF;
  IF _week_start > _today_la - (EXTRACT(ISODOW FROM _today_la)::int - 1) THEN
    RAISE EXCEPTION 'you can only attest the current or a past week';
  END IF;
  IF NOT _confirm AND COALESCE(btrim(_note), '') = '' THEN
    RAISE EXCEPTION 'tell us what''s wrong — a note is required to dispute';
  END IF;

  SELECT COALESCE(SUM(te.billable_hours), 0) INTO _hours
  FROM public.time_entries te
  WHERE te.user_id = _uid
    AND te.log_date BETWEEN _week_start AND _week_start + 6
    AND te.clock_out IS NOT NULL AND te.voided_at IS NULL;

  UPDATE public.time_week_attestations
  SET superseded_at = now()
  WHERE user_id = _uid AND week_start = _week_start AND superseded_at IS NULL;

  INSERT INTO public.time_week_attestations (user_id, week_start, status, note, hours_at_attestation)
  VALUES (_uid, _week_start,
          CASE WHEN _confirm THEN 'confirmed' ELSE 'disputed' END,
          NULLIF(btrim(COALESCE(_note, '')), ''),
          _hours)
  RETURNING id INTO _new_id;
  RETURN _new_id;
END $$;

REVOKE ALL ON FUNCTION public.attest_week(date, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attest_week(date, boolean, text) TO authenticated;
