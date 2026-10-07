-- Van aliases (owner, 2026-07-31): Monday's Van column carries names that do
-- not always equal the van's name in Fleet. "Jorge" is the Miguel van — 21
-- cards named it between 2026-07-29 and 2026-07-31 (19 of them Ernie Ruiz's,
-- one from Miguel Munoz himself, the van's own captain) and every one of them
-- logged Van_Unknown and silently skipped the sync, leaving those reps on
-- whatever van they happened to be on.
--
-- Rather than hardcode the string in the webhook, vans carry an alias list the
-- owner can extend. Matching is case-insensitive on name OR any alias.

ALTER TABLE public.teams
  ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.teams.aliases IS
  'Alternate names this van answers to in Monday''s Van column. Matched case-insensitively alongside teams.name by the monday-live-dispatch webhook.';

-- Jorge → the Miguel van.
UPDATE public.teams
SET aliases = array_append(aliases, 'Jorge')
WHERE name = 'Miguel'
  AND NOT EXISTS (
    SELECT 1 FROM unnest(aliases) a WHERE lower(a) = 'jorge'
  );

-- One-time correction: reps whose cards named Jorge never got synced, so their
-- profile van is whatever a later stray card left behind (Ernie Ruiz was
-- dragged onto Logan even though every one of his production rows says
-- Miguel). Put them where their cards say they belong. Derived from the
-- Van_Unknown trail rather than a hardcoded name list.
UPDATE public.profiles p
SET team_id = (SELECT id FROM public.teams WHERE name = 'Miguel' LIMIT 1)
WHERE p.display_name IN (
  SELECT DISTINCT wl.data->>'canvasser'
  FROM public.webhook_logs wl
  WHERE wl.step = 'Van_Unknown'
    AND lower(wl.data->>'vanName') = 'jorge'
    AND wl.data->>'canvasser' IS NOT NULL
)
AND p.team_id IS DISTINCT FROM (SELECT id FROM public.teams WHERE name = 'Miguel' LIMIT 1);
