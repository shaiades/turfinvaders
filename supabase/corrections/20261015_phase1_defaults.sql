-- Phase 1 §6 defaults (conversion audit 2026-10-15) — owner runs this; the
-- app never flips prod flags itself.
--
--   objections_quickpick_enabled  ON: tagging the objection after "Not
--                                 Interested" is one tap (feeds the coaching
--                                 data Phase 2 builds on).
--   feed_live / feed_push         ON: the Street Feed announces leads live
--                                 and pushes the big moments (shoutouts,
--                                 crownings, sales, van leads), capped by
--                                 feed_push_daily_cap — left at its existing
--                                 value (default 5/day) on purpose.
--
-- Idempotent. Run: supabase db query --linked --file supabase/corrections/20261015_phase1_defaults.sql

UPDATE public.company_settings
SET objections_quickpick_enabled = true
WHERE id = true;

UPDATE public.arcade_flags
SET feed_live = true,
    feed_push = true
WHERE id = 1;

SELECT
  (SELECT objections_quickpick_enabled FROM public.company_settings WHERE id = true) AS quickpick,
  feed_live, feed_push, feed_push_daily_cap
FROM public.arcade_flags WHERE id = 1;
