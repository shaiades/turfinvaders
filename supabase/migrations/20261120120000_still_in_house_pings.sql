-- ═══════════════════════════════════════════════════════════════════════════
-- STILL IN HOUSE PINGS — the rep's "can't make my next lead" button (owner
-- mandate 2026-11-20).
--
-- A rep who is still inside a house when their next appointment comes due
-- taps ONE button on My Leads. The tap only succeeds WITH a live GPS fix:
-- the row stores where they actually are (lat/lng + reverse-geocoded
-- address), so "I'm still in house" can't be juiced from the parking lot —
-- dispatch sees the real location next to the lead they're missing and
-- decides: cover the lead with another rep, or call the customer to push.
--
-- Deliberate choices:
--   • lat/lng are NOT NULL — no location, no excuse. The client enforces the
--     fresh-fix flow; the schema makes a location-less ping impossible.
--   • located_address is best-effort Nominatim (can be null in a dead zone);
--     the coordinates are the evidence, the address is the convenience.
--   • Re-pings are allowed (no unique fence): a second tap 30 minutes later
--     logs a NEW location fix — more evidence, never less.
--   • INSERT only for reps (own rows); no client UPDATE of location/ownership
--     ever. Admin tier may only flip the handled columns.
--   • Realtime publication so the Fleet Dispatch queue pops within a second.
--
-- Idempotent — safe to re-paste.
-- Apply via: supabase db query --linked --file supabase/migrations/20261120120000_still_in_house_pings.sql
-- (From the MAIN checkout — worktrees are not linked.)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) The table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.in_house_pings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Denormalized for the dispatch queue (block_cards reps are Monday names,
  -- not uuids — same display convention as the OOH queue).
  rep_name text,
  -- The lead they can't make (block_cards / Monday item).
  monday_item_id text NOT NULL,
  lead_name text,
  lead_address text,
  -- Where they ACTUALLY are. Required — this is the whole point.
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  accuracy_m double precision,
  located_address text,
  note text,
  ping_date date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Los_Angeles')::date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handled')),
  handled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS in_house_pings_date_status_idx
  ON public.in_house_pings (ping_date DESC, status);
CREATE INDEX IF NOT EXISTS in_house_pings_rep_date_idx
  ON public.in_house_pings (rep_id, ping_date DESC);

-- ── 2) RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE public.in_house_pings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Reps insert their pings" ON public.in_house_pings;
CREATE POLICY "Reps insert their pings"
  ON public.in_house_pings FOR INSERT TO authenticated
  WITH CHECK (rep_id = auth.uid());

DROP POLICY IF EXISTS "Reps read their pings" ON public.in_house_pings;
CREATE POLICY "Reps read their pings"
  ON public.in_house_pings FOR SELECT TO authenticated
  USING (rep_id = auth.uid());

-- Dispatch tier reads everything (same tiers as call_logs / field_pins).
DROP POLICY IF EXISTS "Admins view all pings" ON public.in_house_pings;
CREATE POLICY "Admins view all pings"
  ON public.in_house_pings FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'captain'::app_role)
  );

DROP POLICY IF EXISTS "Admins handle pings" ON public.in_house_pings;
CREATE POLICY "Admins handle pings"
  ON public.in_house_pings FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'captain'::app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'captain'::app_role)
  );

GRANT SELECT, INSERT ON public.in_house_pings TO authenticated;
-- Only the handled columns are client-writable — the location fix, ownership
-- and date are immutable evidence.
REVOKE UPDATE ON public.in_house_pings FROM authenticated;
GRANT UPDATE (status, handled_by, handled_at) ON public.in_house_pings TO authenticated;
GRANT ALL ON public.in_house_pings TO service_role;

-- ── 3) Realtime (guarded add, report_collections pattern) ────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'in_house_pings'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.in_house_pings';
  END IF;
END $$;

-- ── Smoke test (run by hand in the SQL editor; rolls itself back) ────────────
-- BEGIN;
--   -- SELECT id, display_name FROM profiles LIMIT 5;
--   INSERT INTO in_house_pings (rep_id, rep_name, monday_item_id, lead_name, lat, lng)
--   VALUES ('<uid>', 'Test Rep', '123456', 'Test Lead', 32.7157, -117.1611);
--   SELECT rep_name, lead_name, status FROM in_house_pings
--   WHERE ping_date = (now() AT TIME ZONE 'America/Los_Angeles')::date;
--   -- expect the row, status 'open'
-- ROLLBACK;
