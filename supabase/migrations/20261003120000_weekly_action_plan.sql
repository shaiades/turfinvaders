-- Weekly Action Plan (owner directive 2026-10-01): mirror the Monday
-- Production board (4300880129) so each sales rep gets a weekly plan of
-- their jobs in progress in Close Kombat — job states, homeowner temperature
-- from production notes, reloads/Advantage+, priority pins, clustering and
-- phase guidance. Raw production notes are ADMIN-ONLY (reps see only the
-- classified summary — RLS is the boundary, not the UI). Idempotent.

-- 1) Mirror table — one row per Production item ("Homeowner") in scope
--    (Queue To Start / In Progress / Delayed / recently Completed).
CREATE TABLE IF NOT EXISTS public.production_jobs (
  monday_item_id   text PRIMARY KEY,
  board_id         text NOT NULL,
  group_id         text NOT NULL,
  group_title      text NOT NULL,
  homeowner_name   text,
  -- RAW Monday rep names (board truth — no FK to profiles; the client
  -- resolves "me" with buildRepMatcher, the Close Kombat doctrine).
  reps             text[] NOT NULL DEFAULT '{}',
  rep_monday_ids   bigint[] NOT NULL DEFAULT '{}',
  -- "Production" people column = the project manager(s) on Monday.
  pm_name          text,
  pm_monday_ids    bigint[] NOT NULL DEFAULT '{}',
  projects         text,
  reloads          text,            -- available reloads (dropdown verbatim)
  reloaded         text,            -- already-sold reloads (dropdown verbatim)
  advantage_plus   boolean NOT NULL DEFAULT false,
  address          text,
  lat              double precision,
  lng              double precision,
  geo_source       text,            -- 'monday' | 'geocoded' | NULL
  zip              text,
  sale_amount      numeric(12,2) NOT NULL DEFAULT 0, -- blank cell = $0, never guessed
  schedule_start   date,            -- Schedule timeline "from" (often null in Queue)
  schedule_end     date,            -- Schedule timeline "to"
  prev_schedule_start date,         -- last different schedule (reschedule chip)
  prev_schedule_end   date,
  completion_date  date,
  delayed_until    date,
  status_label     text,
  office_location  text,
  reviews_status   text,
  referral_status  text,
  -- Classified at SYNC TIME from the admin-only notes digest; the client
  -- never re-classifies (the PM alert and the rep's card must agree).
  homeowner_status text NOT NULL DEFAULT 'neutral'
    CHECK (homeowner_status IN ('happy', 'neutral', 'at_risk')),
  homeowner_status_reason    text,
  homeowner_status_note_date date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS production_jobs_group_idx
  ON public.production_jobs (group_id);
CREATE INDEX IF NOT EXISTS production_jobs_reps_idx
  ON public.production_jobs USING gin (reps);

ALTER TABLE public.production_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "production_jobs read" ON public.production_jobs;
CREATE POLICY "production_jobs read"
  ON public.production_jobs FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'sales_rep'::app_role)
  );

GRANT SELECT ON public.production_jobs TO authenticated;
GRANT ALL ON public.production_jobs TO service_role;

DROP TRIGGER IF EXISTS production_jobs_touch_updated_at ON public.production_jobs;
CREATE TRIGGER production_jobs_touch_updated_at
  BEFORE UPDATE ON public.production_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 2) Raw notes digest — ADMIN/SERVICE ONLY. Production updates carry
--    internal chatter and homeowner disputes; reps read only the classified
--    summary on production_jobs. Never widen this SELECT to sales_rep.
CREATE TABLE IF NOT EXISTS public.production_job_notes (
  monday_item_id text PRIMARY KEY
    REFERENCES public.production_jobs (monday_item_id) ON DELETE CASCADE,
  -- [{body, created_at, creator}] — updates + replies flattened, newest
  -- first, 14-day window, ≤15 entries.
  notes_digest   jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.production_job_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "production_job_notes admin read" ON public.production_job_notes;
CREATE POLICY "production_job_notes admin read"
  ON public.production_job_notes FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
  );

GRANT SELECT ON public.production_job_notes TO authenticated;
GRANT ALL ON public.production_job_notes TO service_role;

DROP TRIGGER IF EXISTS production_job_notes_touch_updated_at ON public.production_job_notes;
CREATE TRIGGER production_job_notes_touch_updated_at
  BEFORE UPDATE ON public.production_job_notes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 3) Leadership homeowner-status corrections. Separate table so the sync's
--    upserts can never clobber a human call. Staleness rule lives in code:
--    an override applies only while no production note newer than
--    based_on_note_date exists (then the auto status wins again and the
--    leadership view flags "override stale").
CREATE TABLE IF NOT EXISTS public.production_job_overrides (
  monday_item_id    text PRIMARY KEY,
  homeowner_status  text NOT NULL
    CHECK (homeowner_status IN ('happy', 'neutral', 'at_risk')),
  note              text,
  based_on_note_date date,
  set_by            uuid NOT NULL REFERENCES public.profiles (id),
  set_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.production_job_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "production_job_overrides read" ON public.production_job_overrides;
CREATE POLICY "production_job_overrides read"
  ON public.production_job_overrides FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'sales_rep'::app_role)
  );

DROP POLICY IF EXISTS "production_job_overrides admin write" ON public.production_job_overrides;
CREATE POLICY "production_job_overrides admin write"
  ON public.production_job_overrides FOR INSERT TO authenticated
  WITH CHECK (
    (public.has_role(auth.uid(), 'owner'::app_role)
      OR public.has_role(auth.uid(), 'office_staff'::app_role))
    AND set_by = auth.uid()
  );

DROP POLICY IF EXISTS "production_job_overrides admin update" ON public.production_job_overrides;
CREATE POLICY "production_job_overrides admin update"
  ON public.production_job_overrides FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
  )
  WITH CHECK (set_by = auth.uid());

DROP POLICY IF EXISTS "production_job_overrides admin delete" ON public.production_job_overrides;
CREATE POLICY "production_job_overrides admin delete"
  ON public.production_job_overrides FOR DELETE TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.production_job_overrides TO authenticated;
GRANT ALL ON public.production_job_overrides TO service_role;

-- 4) Optional one-tap "I went" — the rep's own breadcrumb, NEVER compliance.
--    No admin SELECT in V1 on purpose: leadership views must not render it.
CREATE TABLE IF NOT EXISTS public.rep_job_visits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monday_item_id text NOT NULL,
  rep_id         uuid NOT NULL REFERENCES public.profiles (id),
  -- LA calendar date, sent by the client (laTodayISO) — never UTC current_date.
  visited_on     date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (monday_item_id, rep_id, visited_on)
);

ALTER TABLE public.rep_job_visits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rep_job_visits own read" ON public.rep_job_visits;
CREATE POLICY "rep_job_visits own read"
  ON public.rep_job_visits FOR SELECT TO authenticated
  USING (rep_id = auth.uid());

DROP POLICY IF EXISTS "rep_job_visits own insert" ON public.rep_job_visits;
CREATE POLICY "rep_job_visits own insert"
  ON public.rep_job_visits FOR INSERT TO authenticated
  WITH CHECK (rep_id = auth.uid());

DROP POLICY IF EXISTS "rep_job_visits own delete" ON public.rep_job_visits;
CREATE POLICY "rep_job_visits own delete"
  ON public.rep_job_visits FOR DELETE TO authenticated
  USING (rep_id = auth.uid());

GRANT SELECT, INSERT, DELETE ON public.rep_job_visits TO authenticated;
GRANT ALL ON public.rep_job_visits TO service_role;

-- 5) PM at-risk alert dedupe — one Monday notification per at-risk EPISODE
--    (keyed by the note date that flipped the status), never per day.
--    Service-only (RLS on, no policies — the weekly_goal_push_log pattern).
CREATE TABLE IF NOT EXISTS public.plan_pm_alert_log (
  monday_item_id   text NOT NULL,
  status_note_date date NOT NULL,
  alerted_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (monday_item_id, status_note_date)
);

ALTER TABLE public.plan_pm_alert_log ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.plan_pm_alert_log TO service_role;

-- 6) Geocode cache — Nominatim results for Production addresses whose Monday
--    Location column has no lat/lng. One lookup per normalized address,
--    ever. Service-only.
CREATE TABLE IF NOT EXISTS public.geocode_cache (
  address_norm text PRIMARY KEY,
  lat          double precision,
  lng          double precision,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.geocode_cache ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.geocode_cache TO service_role;
