-- Profiles → supabase_realtime publication (2026-09-10, follow-up to PR #156
-- "Move Players"). The dispatch board has subscribed to profiles/teams since
-- PR #140 ("profiles/teams keep one manager's van moves live on another's
-- open board"), but public.profiles was never added to the publication, so a
-- van move only refreshed the mover's own screen (mutation invalidation) —
-- every other open board stayed stale until reload. teams has been published
-- since 20260627215444; this adds the missing half. No app code change:
-- useRealtimeInvalidate is already wired and debounced (1s).
--
-- Realtime delivery respects RLS SELECT policies; profiles are already
-- broadly readable (the roster query runs for every leaderboard viewer), so
-- publishing adds no new exposure.

-- Guarded — same pattern as close_kombat_block_cards / turf_area_assignment.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'profiles'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles';
  END IF;
END $$;
