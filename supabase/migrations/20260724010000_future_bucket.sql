-- Live Dispatch funnel: "Future" bucket for the Incoming Leads board's
-- Lead Status column. Previously "Future" statuses were lumped into pending;
-- the webhook now tracks them in their own counter. Idempotent — safe to run
-- more than once.
ALTER TABLE public.daily_metrics
  ADD COLUMN IF NOT EXISTS future integer NOT NULL DEFAULT 0;
