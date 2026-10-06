-- ═══════════════════════════════════════════════════════════════════════════
-- CANVASSER BADGES + LIFETIME XP (§1 "also fix") — finish the Fighter card so a
-- badge, once earned, STAYS earned (a trophy, not a this-week state), and the
-- arcade level counts LIFETIME production instead of resetting every month.
--
--   canvasser_badges     one row per (player, badge) the player has ever earned.
--                        `seen=false` means the one-time unlock animation has
--                        not played yet; the Fighter card plays it, then flips
--                        `seen=true` so it never replays (persisted, not
--                        localStorage, so it's once-per-player not once-per-device).
--   arcade_lifetime_xp() the caller's all-time logged funnel sums (leads / sits /
--                        sales) for the cosmetic XP curve. SECURITY DEFINER +
--                        self-scoped so a veteran with >1000 daily_logs rows is
--                        summed server-side (PostgREST's row cap can't truncate
--                        it) and no pay figure is ever read.
--
-- GAMIFICATION ONLY — nothing here touches calc_*_paycheck or any pay column.
-- The app FAILS OPEN on both: a missing table / RPC falls back to the live
-- per-scope evaluation, so the Fighter card still renders before this lands.
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261013120000_canvasser_badges.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Earned-badge trophies (player-owned) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.canvasser_badges (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  badge_id text NOT NULL CHECK (badge_id IN (
    'first_blood','hat_trick','sniper','boss_slayer','streak','van_mvp'
  )),
  earned_at timestamptz NOT NULL DEFAULT now(),
  -- false until the first-time unlock animation has played on any device.
  seen boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, badge_id)
);

GRANT SELECT, INSERT, UPDATE ON public.canvasser_badges TO authenticated;
GRANT ALL ON public.canvasser_badges TO service_role;
ALTER TABLE public.canvasser_badges ENABLE ROW LEVEL SECURITY;

-- A player reads, earns and marks-seen ONLY their own badges. Cosmetic, so a
-- client write is fine (the arcade already trusts client-shaped aggregates);
-- the CHECK constraint fences badge_id to the known set regardless. No DELETE
-- policy on purpose — an earned trophy is permanent.
DROP POLICY IF EXISTS "canvasser_badges own read" ON public.canvasser_badges;
CREATE POLICY "canvasser_badges own read" ON public.canvasser_badges
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "canvasser_badges own insert" ON public.canvasser_badges;
CREATE POLICY "canvasser_badges own insert" ON public.canvasser_badges
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "canvasser_badges own update" ON public.canvasser_badges;
CREATE POLICY "canvasser_badges own update" ON public.canvasser_badges
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ── Lifetime XP sums (self-scoped, cosmetic) ────────────────────────────────
-- Returns the caller's all-time logged funnel. Definer + a hard-wired
-- auth.uid() filter means a player can only ever read their OWN sums, and the
-- aggregate runs server-side so a long tenure isn't truncated by the REST cap.
CREATE OR REPLACE FUNCTION public.arcade_lifetime_xp()
RETURNS TABLE (appts bigint, sits bigint, solds bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(SUM(leads_called_in), 0)::bigint AS appts,
    COALESCE(SUM(demos_sits), 0)::bigint       AS sits,
    COALESCE(SUM(sales), 0)::bigint            AS solds
  FROM public.daily_logs
  WHERE canvasser_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.arcade_lifetime_xp() TO authenticated;
