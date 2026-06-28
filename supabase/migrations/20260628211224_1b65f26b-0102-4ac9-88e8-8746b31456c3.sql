
-- ============ TERRITORIES ============
CREATE TABLE public.territories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  color text NOT NULL DEFAULT '#39FF14',
  team_id uuid REFERENCES public.teams(id) ON DELETE CASCADE,
  canvasser_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  polygon jsonb NOT NULL, -- array of {lat:number, lng:number}
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (team_id IS NOT NULL OR canvasser_id IS NOT NULL)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.territories TO authenticated;
GRANT ALL ON public.territories TO service_role;
ALTER TABLE public.territories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage all territories"
  ON public.territories FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));

CREATE POLICY "Captains manage their van territories"
  ON public.territories FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'captain')
    AND (team_id = public.my_team_id(auth.uid())
         OR canvasser_id IN (SELECT id FROM public.profiles WHERE team_id = public.my_team_id(auth.uid())))
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'captain')
    AND (team_id = public.my_team_id(auth.uid())
         OR canvasser_id IN (SELECT id FROM public.profiles WHERE team_id = public.my_team_id(auth.uid())))
  );

CREATE POLICY "View own + global territories"
  ON public.territories FOR SELECT TO authenticated
  USING (
    canvasser_id = auth.uid()
    OR team_id = public.my_team_id(auth.uid())
    OR public.global_visibility_on()
    OR public.has_role(auth.uid(), 'office_staff')
  );

CREATE TRIGGER territories_touch BEFORE UPDATE ON public.territories
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============ FIELD PINS ============
CREATE TYPE public.pin_type AS ENUM ('not_home','talked_to','lead');

CREATE TABLE public.field_pins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canvasser_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  pin_type public.pin_type NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  log_date date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX field_pins_canvasser_date_idx ON public.field_pins (canvasser_id, log_date DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.field_pins TO authenticated;
GRANT ALL ON public.field_pins TO service_role;
ALTER TABLE public.field_pins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Canvassers manage their pins"
  ON public.field_pins FOR ALL TO authenticated
  USING (canvasser_id = auth.uid())
  WITH CHECK (canvasser_id = auth.uid());

CREATE POLICY "Owners and office staff view all pins"
  ON public.field_pins FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

CREATE POLICY "Captains view their canvassers pins"
  ON public.field_pins FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'captain')
    AND canvasser_id IN (SELECT id FROM public.profiles WHERE team_id = public.my_team_id(auth.uid()))
  );

-- Trigger: when a pin is added, bump the daily log counters
CREATE OR REPLACE FUNCTION public.bump_daily_log_from_pin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _team uuid;
BEGIN
  SELECT team_id INTO _team FROM public.profiles WHERE id = NEW.canvasser_id;

  INSERT INTO public.daily_logs (canvasser_id, team_id, log_date, people_talked_to, leads_called_in)
  VALUES (
    NEW.canvasser_id,
    _team,
    NEW.log_date,
    CASE WHEN NEW.pin_type = 'talked_to' THEN 1 ELSE 0 END,
    CASE WHEN NEW.pin_type = 'lead' THEN 1 ELSE 0 END
  )
  ON CONFLICT (canvasser_id, log_date) DO UPDATE
    SET people_talked_to = public.daily_logs.people_talked_to + EXCLUDED.people_talked_to,
        leads_called_in = public.daily_logs.leads_called_in + EXCLUDED.leads_called_in,
        updated_at = now();
  RETURN NEW;
END $$;

CREATE TRIGGER field_pins_bump_log
  AFTER INSERT ON public.field_pins
  FOR EACH ROW EXECUTE FUNCTION public.bump_daily_log_from_pin();

-- Make sure daily_logs has the unique constraint the upsert needs
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'daily_logs_canvasser_date_uk'
  ) THEN
    ALTER TABLE public.daily_logs
      ADD CONSTRAINT daily_logs_canvasser_date_uk UNIQUE (canvasser_id, log_date);
  END IF;
END $$;

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.field_pins;
ALTER PUBLICATION supabase_realtime ADD TABLE public.territories;
