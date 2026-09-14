-- RepCard historical import (2026) — schema only.
--
-- Two ISOLATED reference tables holding data pulled from Tidal Remodeling's
-- RepCard tenant (company 2343) for calendar-year 2026:
--   1) repcard_canvasser_results  — per-canvasser door-knock performance
--   2) repcard_territory_history  — assigned canvassing areas (turf polygons)
--
-- Design intent: these are READ-ONLY history. They are deliberately NOT wired
-- into daily_logs / daily_metrics / leads / turfs or anything the leaderboard
-- and payroll engine read, so imported RepCard numbers can never distort the
-- calibrated counting. No app code writes here; rows are loaded once from
-- scripts/repcard/repcard_2026_seed.sql via the service/admin connection.
--
-- rep_name is denormalized on purpose: most 2026 reps have left the roster, so
-- we store the RepCard identity (name / team / office / repcard_user_id) and let
-- the app resolve to a live profile by name when it wants to.

-- 1) Per-canvasser results ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.repcard_canvasser_results (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repcard_user_id      bigint,
  rep_name             text NOT NULL,
  office               text,
  team                 text,
  active               boolean NOT NULL DEFAULT true,  -- false = deactivated in RepCard
  period_start         date NOT NULL,
  period_end           date NOT NULL,
  doors_knocked        integer NOT NULL DEFAULT 0,
  verified_door_knock  integer NOT NULL DEFAULT 0,
  talked_to            integer NOT NULL DEFAULT 0,
  talk_ratio_pct       numeric,
  appts_set            integer NOT NULL DEFAULT 0,
  close_ratio_pct      numeric,
  avg_doors_per_day    numeric,
  avg_distance_mi      numeric,
  first_door_knock     text,
  last_door_knock      text,
  time_in_field_hours  numeric,
  door_knocked_days    integer NOT NULL DEFAULT 0,
  source               text NOT NULL DEFAULT 'repcard',
  imported_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS repcard_canvasser_results_name_idx
  ON public.repcard_canvasser_results (lower(rep_name));
CREATE INDEX IF NOT EXISTS repcard_canvasser_results_period_idx
  ON public.repcard_canvasser_results (period_start, period_end);

-- 2) Territory (area) history ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.repcard_territory_history (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repcard_area_id      bigint UNIQUE,
  repcard_user_id      bigint,
  rep_name             text,
  team                 text,
  office               text,
  assigned_by_name     text,
  assigned_at          timestamptz,
  color                text,
  polygon_coordinates  jsonb NOT NULL,  -- [{lat,lng},...] — same convention as public.turfs
  source               text NOT NULL DEFAULT 'repcard',
  imported_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS repcard_territory_history_user_idx
  ON public.repcard_territory_history (repcard_user_id);
CREATE INDEX IF NOT EXISTS repcard_territory_history_assigned_at_idx
  ON public.repcard_territory_history (assigned_at);

-- RLS: leadership reads only; no client writes (data loaded out-of-band) -------
ALTER TABLE public.repcard_canvasser_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repcard_territory_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "repcard_results_leadership_read"
  ON public.repcard_canvasser_results FOR SELECT
  USING (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
    OR public.has_role(auth.uid(), 'captain')
  );

CREATE POLICY "repcard_territory_leadership_read"
  ON public.repcard_territory_history FOR SELECT
  USING (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
    OR public.has_role(auth.uid(), 'captain')
  );
