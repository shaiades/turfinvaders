-- Kombat rep aliases (owner directive 2026-10-05): a durable mapping from a
-- player's chosen handle to their real board name, so a rep can keep a
-- stylized display_name ("CurtofWest", "MudaBaka") AND still bind to their
-- points on the contest board.
--
-- The whole of Close Kombat resolves "which board rows are mine" with
-- buildRepMatcher(profiles.display_name, boardNames) (src/lib/rep-identity.ts)
-- — a conservative string ladder that only binds a first+last name. A
-- single-token handle matches NOTHING, so a rep like "CurtofWest" shows
-- "Points to win: 0" and a missing fighter card even though "Curtis
-- Westergard" is sitting on the board with points. Historically the only fix
-- was to overwrite the handle with the real name; this table lets the handle
-- stand and adds an authoritative alias tier to the matcher instead.
--
-- Resolution is keyed by the LIVE display_name (joined at read time), never a
-- stored copy — so renaming a profile can't strand its alias, and View-As
-- (which swaps display_name, not the owner's user id) resolves exactly the
-- same way a real sign-in would. One alias per profile (PK), and a board name
-- can be claimed by at most one profile (unique index) so an alias can never
-- paint one rep's money onto two.
--
-- Idempotent — safe to run more than once.

CREATE TABLE IF NOT EXISTS public.kombat_rep_aliases (
  profile_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  board_name text NOT NULL,
  note text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A board identity belongs to exactly one person — normalized so trivial
-- case/space differences can't sneak a second claim past the guard.
CREATE UNIQUE INDEX IF NOT EXISTS kombat_rep_aliases_board_norm_idx
  ON public.kombat_rep_aliases (lower(btrim(board_name)));

ALTER TABLE public.kombat_rep_aliases ENABLE ROW LEVEL SECURITY;

-- Every signed-in client resolves its own identity from this map, and the
-- names it holds (handle ↔ board name) are no more sensitive than the roster
-- and the public leaderboard already show. Same policy shape as contest_rules.
DROP POLICY IF EXISTS "Signed-in read rep aliases" ON public.kombat_rep_aliases;
CREATE POLICY "Signed-in read rep aliases" ON public.kombat_rep_aliases
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- Admin tier (owner + office_staff — "Manager") curates aliases from the
-- Kombat tab tools, exactly like bounties and rules.
DROP POLICY IF EXISTS "Admins write rep aliases" ON public.kombat_rep_aliases;
CREATE POLICY "Admins write rep aliases" ON public.kombat_rep_aliases
  FOR ALL USING (
    public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
  ) WITH CHECK (
    public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.kombat_rep_aliases TO authenticated;
GRANT ALL ON public.kombat_rep_aliases TO service_role;

DROP TRIGGER IF EXISTS kombat_rep_aliases_touch ON public.kombat_rep_aliases;
CREATE TRIGGER kombat_rep_aliases_touch
  BEFORE UPDATE ON public.kombat_rep_aliases
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Realtime: an alias added mid-session re-binds the affected rep's standing
-- on the next invalidate, the same channel pattern the ledger rides.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.kombat_rep_aliases;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
