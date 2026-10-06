-- ═══════════════════════════════════════════════════════════════════════════
-- ARCADE §6 — Bounties. Time-boxed category pushes that rally the field
-- ("Double sit points — next 2 hours"). v1 ships the field BANNER + the manager
-- composer + this config. The actual arcade-point multiplier is data-limited:
-- daily_logs sit counts aren't sub-day-timestamped, so a "4–8 PM 2× sits" can't
-- be scored precisely — a future refinement (full-day scopes or per-event
-- timing). Scales arcade points only, NEVER pay.
--
-- Idempotent. Apply via:
--   supabase db query --linked --file supabase/migrations/20261017120000_bounties.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.bounties (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  label text NOT NULL,
  category text NOT NULL CHECK (category IN ('sit', 'sale', 'doors')),
  multiplier numeric NOT NULL DEFAULT 2 CHECK (multiplier > 1),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bounties_window_idx ON public.bounties (ends_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bounties TO authenticated;
GRANT ALL ON public.bounties TO service_role;
ALTER TABLE public.bounties ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bounties read all auth" ON public.bounties;
CREATE POLICY "bounties read all auth" ON public.bounties
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "bounties write managers" ON public.bounties;
CREATE POLICY "bounties write managers" ON public.bounties
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'))
  WITH CHECK (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));
