-- Kombat proof uploads: let role-play / testimonial videos through.
--
-- The contest-proofs bucket was created with no file_size_limit, so it fell
-- back to the project-wide Storage limit (Supabase's default is small, often
-- 50MB). Reps submit phone videos that blow past that, so the upload was dead
-- on arrival. Raise the bucket to 500MB and switch the client to resumable
-- (TUS) uploads (see src/integrations/supabase/resumable-upload.ts).
--
-- Keep this in sync with MAX_PROOF_MB in src/components/KombatMonth.tsx.
--
-- NOTE: a bucket's file_size_limit is still capped by the PROJECT-WIDE Storage
-- upload limit (Dashboard → Project Settings → Storage → "Upload file size
-- limit"). That must be raised to >= 500MB there too, or uploads over the
-- global ceiling still 413 regardless of this value.
UPDATE storage.buckets
SET file_size_limit = 500 * 1024 * 1024  -- 524288000 bytes
WHERE id = 'contest-proofs';
