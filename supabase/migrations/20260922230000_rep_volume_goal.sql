-- Sales-rep weekly VOLUME goal (owner, 2026-09-22): the Goals tab's target
-- becomes a dollar volume goal (official Sale-$, the Kombat board's own
-- ranking number), reverse-engineered through the rep's trailing-2-week
-- rates. Supersedes the 5-day-old sales-count goal (weekly_sales_goal,
-- 20260917150100) — a count can't be converted to dollars, only 2 reps ever
-- set one, and keeping both would leave two "goal" columns to confuse every
-- future reader, so the old column drops outright.
--
-- Nullable, no default: absence means "no goal set yet" — the tab renders an
-- explicit CTA state and never assumes $0.
--
-- Not pay-affecting: deliberately NOT added to guard_profile_pay_columns()
-- (20260718183328) — a rep self-edits it via the existing "Users update own
-- profile" RLS policy, same as the canvasser goal columns.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS weekly_volume_goal numeric(12,2);

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_weekly_volume_goal_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_weekly_volume_goal_check
  CHECK (weekly_volume_goal IS NULL OR weekly_volume_goal >= 0);

ALTER TABLE public.profiles DROP COLUMN IF EXISTS weekly_sales_goal;
