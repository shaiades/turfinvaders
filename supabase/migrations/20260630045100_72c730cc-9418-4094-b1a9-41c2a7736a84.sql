
CREATE TABLE public.webhook_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  source text,
  raw_payload jsonb
);

GRANT SELECT ON public.webhook_logs TO authenticated;
GRANT ALL ON public.webhook_logs TO service_role;

ALTER TABLE public.webhook_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can view webhook logs"
ON public.webhook_logs
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'owner'));

CREATE INDEX webhook_logs_created_at_idx ON public.webhook_logs (created_at DESC);
