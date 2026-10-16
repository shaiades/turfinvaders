-- ═══════════════════════════════════════════════════════════════════════════
-- COACHING NOTES (conversion audit 2026-10-15, Phase 2 §4) — a simple
-- per-canvasser coaching log: captains and the office write, the canvasser
-- reads their own. Rides next to the coaching flag (src/lib/coaching.ts),
-- which is computed from production aggregates and needs no table.
--
-- RLS (adapted from purpose_leadership_notes, 20260924090000):
--   read   subject (their own notes), owner/office_staff (all), captain
--          (notes on their OWN van + anything they authored),
--   write  owner/office_staff anywhere; captain only about their own van
--          (strict same-team — a vanless captain writes nothing), always as
--          themselves,
--   edit   author fixes their own note; owner can delete anything.
--
-- author_user_id carries NO FK on purpose (canvasser_aliases.created_by
-- precedent): authors are auth-backed and merges archive those rows, and a
-- missing FK can't block a profile hard-delete. NOTE for merge_canvassers
-- v2 (20261027120000, Phase 1 PR): when both phases land, add
-- coaching_notes.canvasser_id/author_user_id repoints to the merge loop.
--
-- Idempotent — safe to re-paste.
-- Apply via: supabase db query --linked --file supabase/migrations/20261028130000_coaching_notes.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.coaching_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canvasser_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL,
  note_text text NOT NULL CHECK (char_length(note_text) BETWEEN 2 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coaching_notes_canvasser_idx
  ON public.coaching_notes (canvasser_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.coaching_notes TO authenticated;
GRANT ALL ON public.coaching_notes TO service_role;
ALTER TABLE public.coaching_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coaching_notes read" ON public.coaching_notes;
CREATE POLICY "coaching_notes read"
  ON public.coaching_notes FOR SELECT TO authenticated
  USING (
    canvasser_id = auth.uid()
    OR author_user_id = auth.uid()
    OR public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR (
      public.has_role(auth.uid(), 'captain'::app_role)
      AND public.my_team_id(auth.uid()) IS NOT NULL
      AND public.my_team_id(canvasser_id) = public.my_team_id(auth.uid())
    )
  );

DROP POLICY IF EXISTS "coaching_notes write" ON public.coaching_notes;
CREATE POLICY "coaching_notes write"
  ON public.coaching_notes FOR INSERT TO authenticated
  WITH CHECK (
    author_user_id = auth.uid()
    AND (
      public.has_role(auth.uid(), 'owner'::app_role)
      OR public.has_role(auth.uid(), 'office_staff'::app_role)
      OR (
        public.has_role(auth.uid(), 'captain'::app_role)
        AND public.my_team_id(auth.uid()) IS NOT NULL
        AND public.my_team_id(canvasser_id) = public.my_team_id(auth.uid())
      )
    )
  );

DROP POLICY IF EXISTS "coaching_notes edit own" ON public.coaching_notes;
CREATE POLICY "coaching_notes edit own"
  ON public.coaching_notes FOR UPDATE TO authenticated
  USING (author_user_id = auth.uid())
  WITH CHECK (author_user_id = auth.uid());

DROP POLICY IF EXISTS "coaching_notes delete" ON public.coaching_notes;
CREATE POLICY "coaching_notes delete"
  ON public.coaching_notes FOR DELETE TO authenticated
  USING (
    author_user_id = auth.uid()
    OR public.has_role(auth.uid(), 'owner'::app_role)
  );

DROP TRIGGER IF EXISTS coaching_notes_touch ON public.coaching_notes;
CREATE TRIGGER coaching_notes_touch BEFORE UPDATE ON public.coaching_notes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
