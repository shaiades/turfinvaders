-- Suspension list opt-out: the Live Dispatch donut banner drives real
-- suspensions, so pseudo-agents (lead sources auto-provisioned by the
-- webhook) must be excludable. Owners manage the flag from Manage Players.
-- Idempotent.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS suspension_tracked boolean NOT NULL DEFAULT true;

UPDATE public.profiles SET suspension_tracked = false
WHERE display_name IN (
  'referral', 'Referral', 'Self Gen', 'Job Walk',
  'Rehash / Cynthia King', 'Ryan appointinator'
);
