-- ═══════════════════════════════════════════════════════════════════════════
-- ARCADE §7 Street Feed + §6 Shoutout — one live feed of the field's big
-- moments (shoutouts, crownings, van lead-changes) for every field role. v1 is
-- "big moments" only; per-sit/sale streaming would need triggers on the prod
-- leads/daily_logs tables (a separate, careful pass — owner call).
--
-- Reads are open to any signed-in player (public praise). Inserts are leaders
-- only (owner / office_staff / captain) and must stamp their own uid — field
-- reps can't post arbitrary feed items. Realtime-published for live delivery.
--
-- Idempotent. Apply via:
--   supabase db query --linked --file supabase/migrations/20261015120000_arcade_feed.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.feed_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  kind text NOT NULL,            -- 'shoutout' | 'crowning' | 'van_lead' | 'bounty' | ...
  actor_name text,               -- who/what the moment is about (person / crew)
  color text,                    -- accent (van color, gold, …)
  body text NOT NULL,            -- the one-line feed text
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_events_created_idx ON public.feed_events (created_at DESC);

GRANT SELECT, INSERT ON public.feed_events TO authenticated;
GRANT ALL ON public.feed_events TO service_role;
ALTER TABLE public.feed_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "feed_events read all auth" ON public.feed_events;
CREATE POLICY "feed_events read all auth" ON public.feed_events
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "feed_events insert leaders" ON public.feed_events;
CREATE POLICY "feed_events insert leaders" ON public.feed_events
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND (
      public.has_role(auth.uid(), 'owner')
      OR public.has_role(auth.uid(), 'office_staff')
      OR public.has_role(auth.uid(), 'captain')
    )
  );

-- Live delivery to every field phone (ignored if already published).
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.feed_events;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
