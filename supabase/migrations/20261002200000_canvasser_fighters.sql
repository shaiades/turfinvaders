-- Canvasser fighters (Close Kombat character-select — extend to the field crew,
-- owner directive 2026-10-02). Reps auto-pull a Monday profile photo; canvassers
-- have none, so the SOURCE is a selfie they (self-serve) or an admin upload.
-- Gemini turns it into the same Street Fighter cartoon (portrait + full-body).
-- AUTO-APPROVED on generation — no review gate (owner: "no need to wait for my
-- approval, if we don't like them we can change them later"). The generated art
-- reuses the existing PUBLIC `rep-cartoons` bucket (canvasser/ subfolder); the
-- raw selfie lives in a PRIVATE bucket and is never shown to the team.
--
-- APPLY BY HAND in the Supabase dashboard (SQL editor) — this repo's migrations
-- are not auto-applied. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.canvasser_photos (
  profile_id            uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  name_norm             text NOT NULL,            -- normalizeName(name): the UI join key
  photo_path            text,                     -- source selfie path in the private canvasser-photos bucket
  source_hash           text,                     -- detect a photo change -> regenerate
  cartoon_portrait_url  text,
  cartoon_full_url      text,
  cartoon_status        text NOT NULL DEFAULT 'none'
                          CHECK (cartoon_status IN ('none','generating','pending_review','approved','failed')),
  cartoon_prompt        text,                     -- editable; drives re-rolls
  cartoon_meta          jsonb,                    -- model / seed / error detail
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS canvasser_photos_name_norm_idx ON public.canvasser_photos (name_norm);
CREATE INDEX IF NOT EXISTS canvasser_photos_status_idx ON public.canvasser_photos (cartoon_status);

ALTER TABLE public.canvasser_photos ENABLE ROW LEVEL SECURITY;

-- Everyone signed in sees APPROVED fighters (the team board) — same contract as
-- rep_photos.
DROP POLICY IF EXISTS canvasser_photos_read_approved ON public.canvasser_photos;
CREATE POLICY canvasser_photos_read_approved ON public.canvasser_photos
  FOR SELECT TO authenticated
  USING (cartoon_status = 'approved');

-- You always see your OWN row, whatever its status — the self-serve uploader
-- shows your generating / failed / pending state before it goes live.
DROP POLICY IF EXISTS canvasser_photos_read_self ON public.canvasser_photos;
CREATE POLICY canvasser_photos_read_self ON public.canvasser_photos
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

-- Admins (owner / office_staff) see every row for the manage gallery.
DROP POLICY IF EXISTS canvasser_photos_read_admin ON public.canvasser_photos;
CREATE POLICY canvasser_photos_read_admin ON public.canvasser_photos
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role IN ('owner', 'office_staff')
    )
  );

-- Writes happen ONLY through the service-role server fns (upload + generation).
-- No authenticated write policy on purpose — supabaseAdmin bypasses RLS.

-- PRIVATE bucket for the raw source selfies (real faces — never public).
INSERT INTO storage.buckets (id, name, public)
VALUES ('canvasser-photos', 'canvasser-photos', false)
ON CONFLICT (id) DO NOTHING;

-- The generated cartoon art reuses the existing PUBLIC `rep-cartoons` bucket
-- (created by 20261002190000_rep_fighters.sql) under a canvasser/ subfolder, so
-- getPublicUrl needs no signing. This block is a safety net if that migration
-- hasn't run yet.
INSERT INTO storage.buckets (id, name, public)
VALUES ('rep-cartoons', 'rep-cartoons', true)
ON CONFLICT (id) DO NOTHING;
