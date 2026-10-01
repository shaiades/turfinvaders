-- God Mode pace target (owner directive 2026-10-01): the editable monthly
-- collected-$ target the Vault hero paces against. Single-row table, owner
-- eyes AND owner hands only — office staff neither read nor write it.
-- Idempotent — safe to run more than once.

CREATE TABLE IF NOT EXISTS public.company_targets (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Company-wide monthly collected-dollar target (the pace denominator).
  monthly_collected_target numeric(14,2) NOT NULL DEFAULT 2000000,
  -- Optional per-office split; NULL = no per-office pace line.
  sd_target numeric(14,2),
  oc_target numeric(14,2),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.company_targets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company_targets owner read" ON public.company_targets;
CREATE POLICY "company_targets owner read"
  ON public.company_targets FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role));

DROP POLICY IF EXISTS "company_targets owner write" ON public.company_targets;
CREATE POLICY "company_targets owner write"
  ON public.company_targets FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'owner'::app_role));

DROP POLICY IF EXISTS "company_targets owner insert" ON public.company_targets;
CREATE POLICY "company_targets owner insert"
  ON public.company_targets FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'owner'::app_role));

GRANT SELECT, INSERT, UPDATE ON public.company_targets TO authenticated;
GRANT ALL ON public.company_targets TO service_role;

DROP TRIGGER IF EXISTS company_targets_touch_updated_at ON public.company_targets;
CREATE TRIGGER company_targets_touch_updated_at
  BEFORE UPDATE ON public.company_targets
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Seed the single row (default $2M/mo; the owner edits it in God Mode).
INSERT INTO public.company_targets (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;
