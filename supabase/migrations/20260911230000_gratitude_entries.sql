-- Gratitude Gate answers get an audience (owner call 2026-09-11): the
-- morning check-in surfaces on the Daily Wrap as "Today's Gratitude".
-- The gate itself stays localStorage-gated — this table is best-effort
-- capture, never a lock; inserts are fire-and-forget from the client.
CREATE TABLE IF NOT EXISTS public.gratitude_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  entry_date date NOT NULL,
  text text NOT NULL CHECK (char_length(text) BETWEEN 2 AND 280),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, entry_date)
);

ALTER TABLE public.gratitude_entries ENABLE ROW LEVEL SECURITY;

-- Write your own, once per day; everyone signed in can read the wall.
-- No update/delete: the morning answer is a ritual, not a document.
CREATE POLICY "gratitude_insert_self" ON public.gratitude_entries
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "gratitude_read_authenticated" ON public.gratitude_entries
  FOR SELECT TO authenticated
  USING (true);
