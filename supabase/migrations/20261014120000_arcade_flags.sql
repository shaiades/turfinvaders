-- ═══════════════════════════════════════════════════════════════════════════
-- ARCADE §7 — client-readable feature flags. SEPARATE from system_settings
-- (which holds the Monday token and is service-role only) precisely because
-- these flags are safe for any signed-in field user to read.
--
-- coach_private (default TRUE, owner spec): keep the Doughnut Zone + Suspension
-- lists on the captain/manager views only — off the public canvasser Daily Wrap
-- and the EOD recap. Owner flips it back with a service-role update:
--   UPDATE public.arcade_flags SET coach_private = false;
--
-- Idempotent. Apply via:
--   supabase db query --linked --file supabase/migrations/20261014120000_arcade_flags.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.arcade_flags (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),      -- singleton
  coach_private boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.arcade_flags (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

GRANT SELECT ON public.arcade_flags TO authenticated;
GRANT ALL ON public.arcade_flags TO service_role;
ALTER TABLE public.arcade_flags ENABLE ROW LEVEL SECURITY;

-- Any signed-in player reads the flags (no secrets); the owner flips them with a
-- service-role update. No client write policy by design.
DROP POLICY IF EXISTS "arcade_flags read all auth" ON public.arcade_flags;
CREATE POLICY "arcade_flags read all auth" ON public.arcade_flags
  FOR SELECT TO authenticated USING (true);
