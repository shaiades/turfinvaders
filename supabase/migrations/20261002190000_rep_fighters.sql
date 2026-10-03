-- Rep fighters (Close Kombat character-select, owner directive 2026-10-02).
-- Each sales rep's real Monday profile photo (the PRIVATE source) plus the AI
-- Street Fighter cartoon generated from it (portrait + full-body). Only an
-- APPROVED cartoon is ever shown to the team; the real photo is admin-only.
--
-- APPLY BY HAND in the Supabase dashboard (SQL editor) — this repo's migrations
-- are not auto-applied. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.rep_photos (
  monday_user_id        bigint PRIMARY KEY,
  name                  text NOT NULL,
  name_norm             text NOT NULL,            -- normalizeName(name): the UI join key
  title                 text,
  photo_url             text,                      -- real Monday photo (private source)
  source_hash           text,                      -- detect a photo change -> regenerate
  cartoon_portrait_url  text,
  cartoon_full_url      text,
  cartoon_status        text NOT NULL DEFAULT 'none'
                          CHECK (cartoon_status IN ('none','generating','pending_review','approved','failed')),
  cartoon_prompt        text,                      -- editable; drives re-rolls
  cartoon_meta          jsonb,                     -- model / seed / error detail
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rep_photos_name_norm_idx ON public.rep_photos (name_norm);
CREATE INDEX IF NOT EXISTS rep_photos_status_idx ON public.rep_photos (cartoon_status);

ALTER TABLE public.rep_photos ENABLE ROW LEVEL SECURITY;

-- Everyone signed in sees APPROVED fighters (the team board). photo_url on an
-- approved row is just Monday's own public URL, so exposing it is harmless.
DROP POLICY IF EXISTS rep_photos_read_approved ON public.rep_photos;
CREATE POLICY rep_photos_read_approved ON public.rep_photos
  FOR SELECT TO authenticated
  USING (cartoon_status = 'approved');

-- Admins (owner / office_staff) see every row — pending/failed included — so
-- the review gallery can show what's awaiting approval.
DROP POLICY IF EXISTS rep_photos_read_admin ON public.rep_photos;
CREATE POLICY rep_photos_read_admin ON public.rep_photos
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role IN ('owner', 'office_staff')
    )
  );

-- Writes happen ONLY through the service-role server fns (sync + generation +
-- review). No authenticated write policy on purpose — supabaseAdmin bypasses RLS.

-- Public bucket for the approved cartoon art (mirrors the contest-proofs bucket
-- creation convention, but public so getPublicUrl needs no signing).
INSERT INTO storage.buckets (id, name, public)
VALUES ('rep-cartoons', 'rep-cartoons', true)
ON CONFLICT (id) DO NOTHING;
