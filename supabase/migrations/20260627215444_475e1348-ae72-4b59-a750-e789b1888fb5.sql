-- OFFICES
CREATE TABLE public.offices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  color text NOT NULL DEFAULT '#22d3ee',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.offices TO authenticated;
GRANT ALL ON public.offices TO service_role;
ALTER TABLE public.offices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read offices" ON public.offices
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Owners manage offices" ON public.offices
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));

CREATE TRIGGER offices_touch_updated_at
  BEFORE UPDATE ON public.offices
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- TEAMS: add office_id
ALTER TABLE public.teams
  ADD COLUMN office_id uuid REFERENCES public.offices(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS teams_office_id_idx ON public.teams(office_id);

-- LEAD EVENTS
CREATE TABLE public.lead_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  canvasser_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  count integer NOT NULL DEFAULT 1,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_events_team_idx ON public.lead_events(team_id, occurred_at DESC);
CREATE INDEX lead_events_occurred_idx ON public.lead_events(occurred_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_events TO authenticated;
GRANT ALL ON public.lead_events TO service_role;
ALTER TABLE public.lead_events ENABLE ROW LEVEL SECURITY;

-- Owners see/manage everything
CREATE POLICY "Owners full access lead_events" ON public.lead_events
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));

-- Members of a team always see their own team's events; everyone else gated by global visibility
CREATE POLICY "Team members read own + visibility read all" ON public.lead_events
  FOR SELECT TO authenticated
  USING (
    team_id = public.my_team_id(auth.uid())
    OR public.global_visibility_on()
  );

-- Canvasser can insert their own; captain can insert for their team
CREATE POLICY "Canvasser inserts own lead" ON public.lead_events
  FOR INSERT TO authenticated
  WITH CHECK (
    canvasser_id = auth.uid()
    AND team_id = public.my_team_id(auth.uid())
  );

CREATE POLICY "Captain inserts for own team" ON public.lead_events
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'captain')
    AND team_id = public.my_team_id(auth.uid())
  );

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.lead_events;
ALTER PUBLICATION supabase_realtime ADD TABLE public.offices;
ALTER PUBLICATION supabase_realtime ADD TABLE public.teams;