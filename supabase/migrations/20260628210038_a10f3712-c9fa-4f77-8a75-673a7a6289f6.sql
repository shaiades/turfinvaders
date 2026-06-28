ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS monthly_goal numeric NOT NULL DEFAULT 10000;