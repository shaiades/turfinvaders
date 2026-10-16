-- ═══════════════════════════════════════════════════════════════════════════
-- MESSAGE FROM SHAI (conversion audit 2026-10-15, Phase 5) — private coach
-- videos, person to person:
--
--   coach_messages    one row PER RECIPIENT (a crew send expands to a row per
--                     active member, team_id kept as the crew flag) so seen /
--                     reaction / reply are per person. Recipients read only
--                     their own; senders see what they sent; the office sees
--                     all. Writes go ONLY through send_coach_message().
--   send_coach_message(_recipient, _team, _text, _video_path)
--                     owner/office send to anyone or any crew; a captain only
--                     to their OWN van (strict same-team, the day-off rule).
--                     Expands crew sends, and pushes each recipient through
--                     the notify-money single-user sender ("🎥 Message from
--                     <sender>") — a personal message is never capped, but
--                     each row pushes at most once by construction.
--   storage           the Phase 2 coach-videos bucket grows three policies:
--                     captains upload under messages/<their uid>/…, recipients
--                     + senders read a video their message row references, and
--                     recipients upload voice replies under replies/<uid>/….
--
-- Videos cap at 60s client-side (~23MB at the Dojo bitrate — under the 50MB
-- bucket/Free-tier ceiling). Nothing here touches pay or production.
--
-- Idempotent — safe to re-paste.
-- Apply via: supabase db query --linked --file supabase/migrations/20261030120000_coach_messages.sql
-- Requires: 20261028120000 (coach-videos bucket) + 20261029120000
-- (notify-money deployed). No new edge function.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.coach_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL,                 -- acting coach; no FK (house pattern)
  recipient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Set when this row came from a crew send (provenance + grouping).
  team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  text text CHECK (text IS NULL OR char_length(text) <= 500),
  video_path text,                         -- coach-videos object
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz,
  reaction text CHECK (reaction IS NULL OR char_length(reaction) <= 16),
  reply_video_path text,                   -- recipient's voice reply
  replied_at timestamptz,
  CONSTRAINT coach_messages_has_content CHECK (text IS NOT NULL OR video_path IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS coach_messages_recipient_idx
  ON public.coach_messages (recipient_id, seen_at, created_at DESC);
CREATE INDEX IF NOT EXISTS coach_messages_sender_idx
  ON public.coach_messages (sender_id, created_at DESC);

-- Recipients may only touch the seen/reaction/reply columns.
GRANT SELECT ON public.coach_messages TO authenticated;
GRANT UPDATE (seen_at, reaction, reply_video_path, replied_at)
  ON public.coach_messages TO authenticated;
GRANT ALL ON public.coach_messages TO service_role;
ALTER TABLE public.coach_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coach_messages read" ON public.coach_messages;
CREATE POLICY "coach_messages read"
  ON public.coach_messages FOR SELECT TO authenticated
  USING (
    recipient_id = auth.uid()
    OR sender_id = auth.uid()
    OR public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
  );

DROP POLICY IF EXISTS "coach_messages recipient update" ON public.coach_messages;
CREATE POLICY "coach_messages recipient update"
  ON public.coach_messages FOR UPDATE TO authenticated
  USING (recipient_id = auth.uid())
  WITH CHECK (recipient_id = auth.uid());

-- No INSERT/DELETE policies on purpose: sends go through the RPC below.

-- ── send_coach_message ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.send_coach_message(
  _recipient uuid DEFAULT NULL,
  _team uuid DEFAULT NULL,
  _text text DEFAULT NULL,
  _video_path text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _caller uuid := auth.uid();
  _is_admin boolean;
  _is_captain boolean;
  _sender_name text;
  _targets uuid[];
  _t uuid;
  _sent int := 0;
  _secret text;
  _row_id uuid;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _recipient IS NULL AND _team IS NULL THEN
    RAISE EXCEPTION 'Pick a player or a crew';
  END IF;
  IF COALESCE(btrim(_text), '') = '' AND _video_path IS NULL THEN
    RAISE EXCEPTION 'Say something or record something';
  END IF;

  _is_admin := public.has_role(_caller, 'owner'::app_role)
    OR public.has_role(_caller, 'office_staff'::app_role);
  _is_captain := public.has_role(_caller, 'captain'::app_role);
  IF NOT (_is_admin OR _is_captain) THEN
    RAISE EXCEPTION 'Only the Owner, Admins, or Captains send coach messages';
  END IF;
  IF NOT _is_admin THEN
    -- Captain lane: own van only (strict — a vanless captain sends nothing).
    IF public.my_team_id(_caller) IS NULL THEN
      RAISE EXCEPTION 'Captains message their own van only';
    END IF;
    IF _team IS NOT NULL AND _team IS DISTINCT FROM public.my_team_id(_caller) THEN
      RAISE EXCEPTION 'Captains message their own van only';
    END IF;
    IF _recipient IS NOT NULL
       AND public.my_team_id(_recipient) IS DISTINCT FROM public.my_team_id(_caller) THEN
      RAISE EXCEPTION 'Captains message their own van only';
    END IF;
  END IF;

  IF _team IS NOT NULL THEN
    -- A crew send is one row per ACTIVE member (seen/reaction are personal).
    SELECT array_agg(p.id) INTO _targets
    FROM public.profiles p
    WHERE p.team_id = _team
      AND COALESCE(p.is_active, true)
      AND NOT COALESCE(p.non_person, false)
      AND p.id <> _caller;
  ELSE
    _targets := ARRAY[_recipient];
  END IF;
  IF _targets IS NULL OR array_length(_targets, 1) = 0 THEN
    RAISE EXCEPTION 'Nobody to send to';
  END IF;

  SELECT display_name INTO _sender_name FROM public.profiles WHERE id = _caller;
  SELECT decrypted_secret INTO _secret
  FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;

  FOREACH _t IN ARRAY _targets LOOP
    INSERT INTO public.coach_messages (sender_id, recipient_id, team_id, text, video_path)
    VALUES (_caller, _t, _team, NULLIF(btrim(_text), ''), _video_path)
    RETURNING id INTO _row_id;
    _sent := _sent + 1;
    -- Personal push, best-effort (the notify-money single-user sender).
    BEGIN
      IF _secret IS NOT NULL THEN
        PERFORM net.http_post(
          url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/notify-money',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-notify-secret', _secret
          ),
          body := jsonb_build_object(
            'user_id', _t,
            'title', '🎥 Message from ' || COALESCE(split_part(_sender_name, ' ', 1), 'your coach'),
            'body', CASE WHEN _video_path IS NOT NULL
                         THEN 'A video is waiting for you — open the app.'
                         ELSE COALESCE(left(_text, 120), 'Open the app.') END,
            'url', '/dashboard?tab=dispatch',
            'tag', 'coach-msg-' || _row_id
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;

  RETURN jsonb_build_object('sent', _sent);
END $$;
REVOKE ALL ON FUNCTION public.send_coach_message(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_coach_message(uuid, uuid, text, text)
  TO authenticated, service_role;

-- ── Storage: coach-videos grows message lanes ────────────────────────────────
-- Captains record messages under messages/<their uid>/… (owner/office keep
-- their Phase 2 write-anywhere policy).
DROP POLICY IF EXISTS "Coach videos captain message write" ON storage.objects;
CREATE POLICY "Coach videos captain message write"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'coach-videos'
    AND public.has_role(auth.uid(), 'captain'::app_role)
    AND name LIKE 'messages/' || auth.uid()::text || '/%'
  );

-- A message's video is readable by its recipient and its sender.
DROP POLICY IF EXISTS "Coach videos message read" ON storage.objects;
CREATE POLICY "Coach videos message read"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'coach-videos'
    AND EXISTS (
      SELECT 1 FROM public.coach_messages m
      WHERE (m.video_path = name OR m.reply_video_path = name)
        AND (m.recipient_id = auth.uid() OR m.sender_id = auth.uid())
    )
  );

-- Recipients record voice replies under replies/<their uid>/….
DROP POLICY IF EXISTS "Coach videos reply write" ON storage.objects;
CREATE POLICY "Coach videos reply write"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'coach-videos'
    AND name LIKE 'replies/' || auth.uid()::text || '/%'
  );
