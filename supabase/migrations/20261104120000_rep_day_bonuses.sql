-- Double Up / Triple Up daily sales-rep bonuses (owner, 2026-11-03).
--
-- A rep who sells 2+ jobs in one LA day whose combined split-share volume
-- reaches $20,000 earns a $500 Double Up; 3+ jobs reaching $30,000 earn a
-- $1,000 Triple Up INSTEAD (best tier only, never both). Shared cards count
-- as a job for each rep but only the rep's volumeSplit share counts toward
-- the threshold; reloads and upsells count as jobs; below the dollar
-- threshold nothing pays.
--
-- One row per rep per qualifying day, materialized by the recompute pass in
-- src/lib/rep-bonus.server.ts (the contest_ledger reconcile pattern):
--   • pending  — counts now, follows the boards; a cancellation that breaks
--                the threshold flips the row to 'cancelled' (jobs snapshot
--                kept so payroll sees it was removed, not silently gone).
--   • locked   — the month's cancel window (contest_rules lock.cancel_window_days,
--                same knob as Kombat) has passed; never touched again.
-- The jobs jsonb embeds the day's job breakdown so payroll roles (hr,
-- bookkeeper) never need to read block_cards, which RLS denies them.

CREATE TABLE IF NOT EXISTS public.rep_day_bonuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bonus_date date NOT NULL,
  rep_name text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('double','triple')),
  amount numeric NOT NULL,
  job_count integer NOT NULL,
  volume numeric NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','locked','cancelled')),
  locked_at timestamptz,
  -- [{monday_item_id, customer, card_total, share}]
  jobs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bonus_date, rep_name)
);
CREATE INDEX IF NOT EXISTS rep_day_bonuses_date_idx ON public.rep_day_bonuses (bonus_date);
CREATE INDEX IF NOT EXISTS rep_day_bonuses_rep_idx ON public.rep_day_bonuses (rep_name, bonus_date);
CREATE INDEX IF NOT EXISTS rep_day_bonuses_status_idx ON public.rep_day_bonuses (status);

ALTER TABLE public.rep_day_bonuses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Payroll and kombat roles read rep day bonuses" ON public.rep_day_bonuses;
CREATE POLICY "Payroll and kombat roles read rep day bonuses" ON public.rep_day_bonuses
  FOR SELECT USING (
    public.has_role(auth.uid(), 'owner') OR
    public.has_role(auth.uid(), 'office_staff') OR
    public.has_role(auth.uid(), 'hr') OR
    public.has_role(auth.uid(), 'bookkeeper') OR
    public.has_role(auth.uid(), 'sales_rep')
  );
-- No client writes: the recompute pass (service role) owns every row.
GRANT SELECT ON public.rep_day_bonuses TO authenticated;
GRANT ALL ON public.rep_day_bonuses TO service_role;

DROP TRIGGER IF EXISTS rep_day_bonuses_touch ON public.rep_day_bonuses;
CREATE TRIGGER rep_day_bonuses_touch
  BEFORE UPDATE ON public.rep_day_bonuses
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
