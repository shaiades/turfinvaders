ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS weekly_income_goal numeric NOT NULL DEFAULT 2000,
  ADD COLUMN IF NOT EXISTS avg_commission numeric NOT NULL DEFAULT 200;