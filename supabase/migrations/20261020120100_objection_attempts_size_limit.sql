-- Objection Dojo attempts: give the bucket an explicit size limit.
--
-- Like contest-proofs, objection-attempts was created with no file_size_limit
-- and fell back to the small project-wide Storage default. Dojo recordings are
-- capped at 90s (MAX_SECONDS), so they're modest, but a high-bitrate device
-- could still brush the default ceiling. Set 200MB — far above any 90s clip —
-- now that the recorder uploads via resumable (TUS) like the proof form.
--
-- Keep this in sync with MAX_ATTEMPT_MB in src/components/ObjectionDojo.tsx.
--
-- NOTE: still capped by the PROJECT-WIDE Storage upload limit (Dashboard →
-- Project Settings → Storage → "Upload file size limit").
UPDATE storage.buckets
SET file_size_limit = 200 * 1024 * 1024  -- 209715200 bytes
WHERE id = 'objection-attempts';
