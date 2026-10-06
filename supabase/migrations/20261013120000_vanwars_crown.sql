-- ═══════════════════════════════════════════════════════════════════════════
-- VAN WARS §3 tail — let a captain (or owner / office_staff) crown the week's
-- winner into the Wall of Fame from the app. The crown always records the
-- OBJECTIVE week leader and is idempotent on (week_start, kind), so who fires
-- it doesn't matter; the UI only exposes the button in the Saturday-6PM→Sunday
-- window. Service role (a future auto-cron) still writes freely.
--
-- Idempotent. Apply via:
--   supabase db query --linked --file supabase/migrations/20261013120000_vanwars_crown.sql
-- ═══════════════════════════════════════════════════════════════════════════

GRANT INSERT, UPDATE ON public.vanwars_wins TO authenticated;

DROP POLICY IF EXISTS "vanwars_wins crown insert" ON public.vanwars_wins;
CREATE POLICY "vanwars_wins crown insert" ON public.vanwars_wins
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'captain')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
  );

DROP POLICY IF EXISTS "vanwars_wins crown update" ON public.vanwars_wins;
CREATE POLICY "vanwars_wins crown update" ON public.vanwars_wins
  FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'captain')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'captain')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
  );
