-- House notes (rep ask via owner, 2026-09-15: "be able to put notes at the
-- house"). Keyed by coordinates, not OSM ids — OSM ids are a client cache
-- detail and twin-merge can shift which bubble represents a home; the note
-- belongs to the SPOT, matched by the same 14 m radius that ties pins to
-- houses. Team knowledge: every signed-in rep reads every note (gate codes,
-- "dog in yard", "come back at 6" help whoever works the turf next).
-- Stat-dead by construction: its own table, NO trigger — a note never bumps
-- daily_logs or any counter.
CREATE TABLE IF NOT EXISTS public.house_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Viewport reads: the map's 📝 badges and the house sheet both fetch by
-- bounding box.
CREATE INDEX IF NOT EXISTS house_notes_lat_lng_idx ON public.house_notes (lat, lng);

ALTER TABLE public.house_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "house_notes_read_authenticated" ON public.house_notes
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "house_notes_insert_self" ON public.house_notes
  FOR INSERT TO authenticated
  WITH CHECK (author_id = auth.uid());

-- Authors clean up their own; owner/office can moderate anything. No UPDATE
-- policy on purpose (gratitude precedent): delete and re-add is the edit.
CREATE POLICY "house_notes_delete_own_or_office" ON public.house_notes
  FOR DELETE TO authenticated
  USING (
    author_id = auth.uid()
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'office_staff')
  );
