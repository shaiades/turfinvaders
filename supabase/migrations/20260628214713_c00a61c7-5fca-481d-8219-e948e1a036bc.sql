
CREATE TABLE public.hype_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('sale','level_up','custom')),
  canvasser_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  canvasser_name text,
  message text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.hype_events TO authenticated;
GRANT ALL ON public.hype_events TO service_role;

ALTER TABLE public.hype_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hype_events read all authed" ON public.hype_events
  FOR SELECT TO authenticated USING (true);

-- Allow a signed-in canvasser to post their own level-up event (client-side detect).
CREATE POLICY "hype_events self level up" ON public.hype_events
  FOR INSERT TO authenticated
  WITH CHECK (canvasser_id = auth.uid() AND kind = 'level_up');

CREATE INDEX hype_events_created_idx ON public.hype_events (created_at DESC);

ALTER PUBLICATION supabase_realtime ADD TABLE public.hype_events;

-- Track current rank on profiles so we can detect level-ups.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS current_rank text;
