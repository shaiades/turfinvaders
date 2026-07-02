
ALTER TABLE public.webhook_logs ADD COLUMN IF NOT EXISTS step text;
ALTER TABLE public.webhook_logs ADD COLUMN IF NOT EXISTS data jsonb;
ALTER TABLE public.webhook_logs ALTER COLUMN raw_payload DROP NOT NULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.webhook_logs;
ALTER TABLE public.webhook_logs REPLICA IDENTITY FULL;
