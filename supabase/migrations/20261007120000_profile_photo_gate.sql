-- Blocking profile-photo step (owner directive 2026-10-06: "the photo step has
-- to be obvious for every user" — Jose Miranda logged in and was never made to
-- add one). The gate itself is client-side (ProfilePhotoGate); the only schema
-- it needs is one optional escape-valve flag.
--
-- profile_photo_remind_later: when FALSE (default) the full-screen "Snap your
-- fighter photo" step is fully blocking — no skip — for every gated role until a
-- photo is on file. When an admin flips it TRUE, a small "Remind me later" link
-- appears, but only to a user who has already been shown the gate 3+ times (the
-- count is per-device, in localStorage). Default-off keeps the hard block the
-- out-of-the-box behavior the owner asked for.
--
-- APPLY BY HAND (this repo's migrations are not auto-applied):
--   supabase db query --linked --file supabase/migrations/20261007120000_profile_photo_gate.sql
-- Idempotent — safe to re-run.

ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS profile_photo_remind_later boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.system_settings.profile_photo_remind_later IS
  'When true, the blocking profile-photo gate offers a "Remind me later" link after 3 shows; when false (default) the gate is fully blocking (owner 2026-10-06).';
