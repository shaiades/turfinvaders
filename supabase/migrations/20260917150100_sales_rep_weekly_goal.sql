-- Sales-rep weekly SALES-COUNT goal (owner request 2026-09-17): a rep sets a
-- target number of sales for the week, not a dollar figure — real commission
-- visibility is handled separately (rep_commission_notes,
-- 20260917150000) and never mixed into this back-solve. Mirrors the shape of
-- the canvasser goal columns (weekly_income_goal etc., pre-existing on
-- profiles) but as a plain integer count.
--
-- Nullable, no default: absence means "no goal set yet" — the Goals tab must
-- render an explicit empty/CTA state and never assume 0 (0 reads as "goal is
-- zero sales", a different claim).
--
-- Not pay-affecting: deliberately NOT added to guard_profile_pay_columns()
-- (20260718183328) — a rep may freely self-edit this column the same way the
-- existing "Users update own profile" RLS policy already allows for the
-- canvasser goal columns it mirrors.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS weekly_sales_goal integer;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_weekly_sales_goal_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_weekly_sales_goal_check
  CHECK (weekly_sales_goal IS NULL OR weekly_sales_goal >= 0);
