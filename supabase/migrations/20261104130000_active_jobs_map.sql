-- ═══════════════════════════════════════════════════════════════════════════
-- ACTIVE JOBS ON THE CANVASSER MAP (owner ask 2026-11-04).
-- Canvassers can truthfully say "We're working on a home a few streets over
-- this week," and captains run the "10 doors around every active job"
-- standard. Jobs come from the existing production_jobs mirror of the Monday
-- Production board (4300880129) — owner confirmed 2026-11-04: ACTIVE means
-- Status = "In Progress", both offices.
--
-- PRIVACY (hard rules, owner 2026-11-04): the client must NEVER receive a
-- customer name, phone, or house number for an active job. Canvassers must
-- not be able to tell whose house it is.
--  · public.active_jobs_map is a DEFINER view (customer_homes doctrine):
--    canvassers cannot read production_jobs by design, and must not — the
--    view exposes STREET NAME (house number stripped), city, the project
--    list, office, and coordinates ROUNDED to 3 decimals (~100 m grid snap),
--    never the address, name, phone, reps, or exact location.
--  · active_job_ring_doors counts this week's door pins inside each job's
--    0.5-mile ring for the captain standard — captains/admins only, and it
--    returns counts, never pin or job detail.
--
-- Idempotent. Apply via:
--   supabase db query --linked --file supabase/migrations/20261104130000_active_jobs_map.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- 1 ▸ The map's read model. status_label (not group_id) is the gate — the
--     owner picked the Status column's "In Progress" label as the ACTIVE
--     definition, and the sync stores that label verbatim. Rounding to
--     3 decimals snaps the pin onto a ~111 m × ~93 m grid: close enough to
--     anchor a half-mile ring, far enough that the pin is "this street",
--     not "this house". Street = first address segment minus any leading
--     house-number token ("8953 Gold Coast Dr, San Diego, …" → "Gold Coast
--     Dr"). NO address/name/phone column may ever be added here.
DROP VIEW IF EXISTS public.active_jobs_map;
CREATE VIEW public.active_jobs_map AS
  SELECT
    pj.monday_item_id,
    nullif(
      trim(regexp_replace(split_part(pj.address, ',', 1), '^\s*[0-9][^[:space:]]*\s+', '')),
      ''
    ) AS street,
    nullif(trim(split_part(pj.address, ',', 2)), '') AS city,
    round(pj.lat::numeric, 3)::double precision AS lat,
    round(pj.lng::numeric, 3)::double precision AS lng,
    pj.projects,
    pj.office_location
  FROM public.production_jobs pj
  WHERE pj.lat IS NOT NULL
    AND pj.lng IS NOT NULL
    AND lower(coalesce(pj.status_label, '')) = 'in progress';

REVOKE ALL ON public.active_jobs_map FROM anon, public;
GRANT SELECT ON public.active_jobs_map TO authenticated;
GRANT SELECT ON public.active_jobs_map TO service_role;

-- 2 ▸ Doors knocked inside each ring this week (captain standard). DEFINER
--     so it can read every canvasser's field_pins; the WHERE role gate keeps
--     the counts to captains/admins — everyone else gets zero rows, never an
--     error (soft gate, has_role doctrine). Non-remote pins only, matching
--     the bump_daily_log_from_pin doors_knocked rule. Distance is planar
--     meters against the ROUNDED ring center — the count matches the circle
--     canvassers see, and the exact location never enters the math. The
--     bounding box keeps the join off a full cross product (no PostGIS in
--     this schema; 0.0075°/0.0095° ≈ 835 m at 33°N, a hair over the radius).
CREATE OR REPLACE FUNCTION public.active_job_ring_doors(_week_start date)
RETURNS TABLE (monday_item_id text, doors bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    j.monday_item_id,
    count(p.id) AS doors
  FROM public.active_jobs_map j
  LEFT JOIN public.field_pins p
    ON p.log_date >= _week_start
   AND NOT p.is_remote_drop
   AND p.lat BETWEEN j.lat - 0.0075 AND j.lat + 0.0075
   AND p.lng BETWEEN j.lng - 0.0095 AND j.lng + 0.0095
   AND power((p.lat - j.lat) * 111320.0, 2)
     + power((p.lng - j.lng) * 111320.0 * cos(radians(j.lat)), 2)
     <= power(804.67, 2)  -- 0.5 mile
  WHERE public.has_role(auth.uid(), 'owner'::app_role)
     OR public.has_role(auth.uid(), 'office_staff'::app_role)
     OR public.has_role(auth.uid(), 'captain'::app_role)
  GROUP BY j.monday_item_id;
$$;

REVOKE ALL ON FUNCTION public.active_job_ring_doors(date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.active_job_ring_doors(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.active_job_ring_doors(date) TO service_role;
