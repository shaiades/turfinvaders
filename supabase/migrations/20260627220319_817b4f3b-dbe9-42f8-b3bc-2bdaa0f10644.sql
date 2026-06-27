
-- Daily logs
CREATE TABLE IF NOT EXISTS public.daily_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canvasser_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  log_date date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  doors_knocked int NOT NULL DEFAULT 0,
  people_talked_to int NOT NULL DEFAULT 0,
  renters int NOT NULL DEFAULT 0,
  leads_called_in int NOT NULL DEFAULT 0,
  next_days int NOT NULL DEFAULT 0,
  future_leads int NOT NULL DEFAULT 0,
  demos_sits int NOT NULL DEFAULT 0,
  sales int NOT NULL DEFAULT 0,
  one_legs int NOT NULL DEFAULT 0,
  no_shows int NOT NULL DEFAULT 0,
  no_demo int NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canvasser_id, log_date)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.daily_logs TO authenticated;
GRANT ALL ON public.daily_logs TO service_role;
ALTER TABLE public.daily_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "daily_logs self insert" ON public.daily_logs FOR INSERT TO authenticated
  WITH CHECK (canvasser_id = auth.uid());
CREATE POLICY "daily_logs self update" ON public.daily_logs FOR UPDATE TO authenticated
  USING (canvasser_id = auth.uid()) WITH CHECK (canvasser_id = auth.uid());
CREATE POLICY "daily_logs read scoped" ON public.daily_logs FOR SELECT TO authenticated
  USING (
    canvasser_id = auth.uid()
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
    OR (public.has_role(auth.uid(), 'captain')
        AND team_id IN (SELECT id FROM public.teams WHERE captain_id = auth.uid()))
    OR public.global_visibility_on()
  );
CREATE TRIGGER daily_logs_touch BEFORE UPDATE ON public.daily_logs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Leads
DO $$ BEGIN
  CREATE TYPE public.lead_status AS ENUM ('pending','confirmed','denied');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canvasser_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  status public.lead_status NOT NULL DEFAULT 'pending',
  customer_name text,
  address text,
  notes text,
  sale_amount numeric(12,2),
  is_sale boolean NOT NULL DEFAULT false,
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  deny_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leads TO authenticated;
GRANT ALL ON public.leads TO service_role;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "leads self insert" ON public.leads FOR INSERT TO authenticated
  WITH CHECK (canvasser_id = auth.uid());
CREATE POLICY "leads read scoped" ON public.leads FOR SELECT TO authenticated
  USING (
    canvasser_id = auth.uid()
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
    OR (public.has_role(auth.uid(), 'captain')
        AND team_id IN (SELECT id FROM public.teams WHERE captain_id = auth.uid()))
    OR public.global_visibility_on()
  );
CREATE POLICY "leads review update" ON public.leads FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
    OR (canvasser_id = auth.uid() AND status = 'pending')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
    OR (canvasser_id = auth.uid() AND status = 'pending')
  );
CREATE TRIGGER leads_touch BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.fire_lead_event_on_confirm()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'confirmed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'confirmed') THEN
    INSERT INTO public.lead_events (team_id, canvasser_id, count, occurred_at)
    VALUES (NEW.team_id, NEW.canvasser_id, 1, COALESCE(NEW.reviewed_at, now()));
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.fire_lead_event_on_confirm() FROM PUBLIC, authenticated, anon;

CREATE TRIGGER leads_fire_event AFTER INSERT OR UPDATE OF status ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.fire_lead_event_on_confirm();

ALTER PUBLICATION supabase_realtime ADD TABLE public.leads;
ALTER PUBLICATION supabase_realtime ADD TABLE public.daily_logs;
