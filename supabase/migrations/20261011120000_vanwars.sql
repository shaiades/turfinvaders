-- ═══════════════════════════════════════════════════════════════════════════
-- VAN WARS (§3) — the weekly street race's two owner-managed tables:
--   vanwars_config  the tunable scoring (per-head ↔ total, sit/sale weights)
--   vanwars_wins    the Wall of Fame (weekly winners + monthly Turf Kings)
--
-- The app READS both but FAILS OPEN — a missing table / RLS denial falls back
-- to defaults (config) or an empty Wall, so Van Wars works before this lands.
-- Writes go through the service role (the Saturday 6 PM crowning cron, shipped
-- in a follow-up); the owner retunes the config with a direct SQL update.
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261011120000_vanwars.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Scoring config (a single owner-tuned row) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.vanwars_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),      -- singleton
  mode text NOT NULL DEFAULT 'per_head' CHECK (mode IN ('per_head','total')),
  sit_weight numeric NOT NULL DEFAULT 1 CHECK (sit_weight > 0),
  sale_weight numeric NOT NULL DEFAULT 2 CHECK (sale_weight > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Seed the default so the app reads live config immediately (defaults mirror
-- src/lib/vanwars.ts DEFAULT_VANWARS_CONFIG: per-head, sit 1, sale 2).
INSERT INTO public.vanwars_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

GRANT SELECT ON public.vanwars_config TO authenticated;
GRANT ALL ON public.vanwars_config TO service_role;
ALTER TABLE public.vanwars_config ENABLE ROW LEVEL SECURITY;

-- Any signed-in player reads the config (the field app needs it to rank); the
-- owner tunes it with a service-role SQL update (bypasses RLS). No client write
-- policy on purpose — there is no in-app editor.
DROP POLICY IF EXISTS "vanwars_config read all auth" ON public.vanwars_config;
CREATE POLICY "vanwars_config read all auth" ON public.vanwars_config
  FOR SELECT TO authenticated USING (true);

-- ── Wall of Fame (weekly winners + monthly Turf Kings) ──────────────────────
CREATE TABLE IF NOT EXISTS public.vanwars_wins (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  week_start date NOT NULL,                  -- Monday of the won week (month-anchor for a king)
  kind text NOT NULL DEFAULT 'week' CHECK (kind IN ('week','king')),
  team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  team_name text NOT NULL,                   -- display_name snapshot (vans get renamed)
  color text,                                -- van color snapshot
  war_score numeric,                         -- the winning war score
  period text,                               -- e.g. '2026-10' for a king row
  crowned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_start, kind)                  -- idempotent crowning: one winner per week / king-month
);
CREATE INDEX IF NOT EXISTS vanwars_wins_week_idx ON public.vanwars_wins (week_start DESC);

GRANT SELECT ON public.vanwars_wins TO authenticated;
GRANT ALL ON public.vanwars_wins TO service_role;
ALTER TABLE public.vanwars_wins ENABLE ROW LEVEL SECURITY;

-- Everyone in the field reads the Wall; only the crowning cron (service role) writes.
DROP POLICY IF EXISTS "vanwars_wins read all auth" ON public.vanwars_wins;
CREATE POLICY "vanwars_wins read all auth" ON public.vanwars_wins
  FOR SELECT TO authenticated USING (true);
