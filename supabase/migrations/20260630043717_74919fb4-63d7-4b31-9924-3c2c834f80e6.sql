
-- Add leads_submitted column for Monday.com intraday tracking
ALTER TABLE public.daily_metrics
  ADD COLUMN IF NOT EXISTS leads_submitted integer NOT NULL DEFAULT 0;

-- Ensure unique constraint on (canvasser_id, metric_date)
CREATE UNIQUE INDEX IF NOT EXISTS daily_metrics_canvasser_date_uniq
  ON public.daily_metrics (canvasser_id, metric_date);

-- Enable Realtime on daily_metrics
ALTER TABLE public.daily_metrics REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'daily_metrics'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.daily_metrics';
  END IF;
END $$;
