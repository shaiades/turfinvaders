-- Objection Dojo attempts: give the bucket an explicit size limit.
--
-- Like contest-proofs, objection-attempts was created with no file_size_limit
-- and fell back to the project-wide Storage default. Set it to 50MB — the
-- Free-plan ceiling. Dojo recordings are capped at 90s and the recorder now
-- caps its bitrate (REC_VIDEO_BPS), so a full clip lands ~35MB, safely under.
-- Uploads go through resumable (TUS) like the proof form.
--
-- Keep this in sync with MAX_ATTEMPT_MB in src/components/ObjectionDojo.tsx.
--
-- NOTE: still capped by the PROJECT-WIDE Storage upload limit (Dashboard →
-- Project Settings → Storage → "Upload file size limit"), 50MB on Free.
UPDATE storage.buckets
SET file_size_limit = 50 * 1024 * 1024  -- 52428800 bytes
WHERE id = 'objection-attempts';
