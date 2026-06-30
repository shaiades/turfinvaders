
CREATE TABLE public.daily_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_date date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Los_Angeles')::date,
  canvasser_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  leads_called_in int NOT NULL DEFAULT 0,
  leads_confirmed int NOT NULL DEFAULT 0,
  sits_ran_today int NOT NULL DEFAULT 0,
  office_location text NOT NULL DEFAULT 'San Diego',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canvasser_id, metric_date)
);

CREATE INDEX idx_daily_metrics_date ON public.daily_metrics(metric_date);
CREATE INDEX idx_daily_metrics_office ON public.daily_metrics(office_location);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.daily_metrics TO authenticated;
GRANT ALL ON public.daily_metrics TO service_role;

ALTER TABLE public.daily_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "View daily metrics" ON public.daily_metrics
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner') OR
    public.has_role(auth.uid(), 'captain') OR
    public.has_role(auth.uid(), 'office_staff') OR
    canvasser_id = auth.uid() OR
    public.global_visibility_on()
  );

CREATE POLICY "Insert daily metrics" ON public.daily_metrics
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'owner') OR
    public.has_role(auth.uid(), 'captain') OR
    public.has_role(auth.uid(), 'office_staff') OR
    canvasser_id = auth.uid()
  );

CREATE POLICY "Update daily metrics" ON public.daily_metrics
  FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner') OR
    public.has_role(auth.uid(), 'captain') OR
    public.has_role(auth.uid(), 'office_staff') OR
    canvasser_id = auth.uid()
  );

CREATE POLICY "Delete daily metrics" ON public.daily_metrics
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'owner'));

CREATE TRIGGER trg_daily_metrics_updated_at
  BEFORE UPDATE ON public.daily_metrics
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER PUBLICATION supabase_realtime ADD TABLE public.daily_metrics;
ALTER TABLE public.daily_metrics REPLICA IDENTITY FULL;
