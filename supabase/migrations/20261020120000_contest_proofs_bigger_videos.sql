-- Kombat proof uploads: let role-play / testimonial videos through.
--
-- The contest-proofs bucket was created with no file_size_limit, so it fell
-- back to the project-wide Storage limit. Set it explicitly to 50MB — the
-- Free-plan ceiling — and switch the client to resumable (TUS) uploads for
-- reliability (see src/integrations/supabase/resumable-upload.ts).
--
-- Keep this in sync with MAX_PROOF_MB in src/components/KombatMonth.tsx.
--
-- NOTE: a bucket's file_size_limit is still capped by the PROJECT-WIDE Storage
-- upload limit (Dashboard → Project Settings → Storage → "Upload file size
-- limit"), which on the Free plan is 50MB and cannot be raised without a plan
-- upgrade. Reps with larger phone videos trim them to fit.
UPDATE storage.buckets
SET file_size_limit = 50 * 1024 * 1024  -- 52428800 bytes
WHERE id = 'contest-proofs';
