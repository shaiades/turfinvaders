-- God Mode v3 (owner directives 2026-10-01):
-- 1) annual_goal on company_targets — the Path-to-$100M panel's editable
--    denominator (default the stated ambition, owner edits in-page).
-- 2) company_costs — two hand-entered numbers per office per month
--    (rough job-cost % and office payroll $) that unlock REAL per-office
--    contribution. Owner eyes and hands only. Until a month's row exists
--    the page shows "Margin: not shown" — never a derived pseudo-margin.
-- Idempotent — safe to run more than once.

ALTER TABLE public.company_targets
  ADD COLUMN IF NOT EXISTS annual_goal numeric(14,2) NOT NULL DEFAULT 100000000;

CREATE TABLE IF NOT EXISTS public.company_costs (
  month           date NOT NULL,           -- first of month (LA calendar)
  office          text NOT NULL,           -- 'San Diego' / 'Orange County'
  -- Rough job-cost share of collected revenue for the month (0.55 = 55%).
  cogs_pct        numeric(5,4),
  -- Office payroll + overhead $ for the month (closers, staff, rent...).
  office_payroll  numeric(12,2),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, office)
);

ALTER TABLE public.company_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company_costs owner all" ON public.company_costs;
CREATE POLICY "company_costs owner all"
  ON public.company_costs FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'owner'::app_role));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_costs TO authenticated;
GRANT ALL ON public.company_costs TO service_role;

DROP TRIGGER IF EXISTS company_costs_touch_updated_at ON public.company_costs;
CREATE TRIGGER company_costs_touch_updated_at
  BEFORE UPDATE ON public.company_costs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
