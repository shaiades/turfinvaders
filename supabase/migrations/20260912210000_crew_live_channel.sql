-- Crew Map live positions (captain audit C-11, 2026-09-12).
--
-- First private Realtime channel in the project: field reps on Active Run
-- broadcast a throttled GPS beacon on topic 'crew-live'; the Crew Map
-- (captains + admin tier) subscribes and renders live avatars. Positions are
-- EPHEMERAL — nothing is persisted; RLS on realtime.messages only gates who
-- may join/send/receive on the websocket topic. Never insert into
-- realtime.messages directly (partitioned internal table).
--
-- Join semantics (supabase-js private channels): INSERT = may send,
-- SELECT = may receive; a user holding neither is refused the join.
-- Publishers here are the field tiers (canvasser/confirmer/captain);
-- watchers are leadership (owner/captain/office_staff). Captains hold both,
-- matching their player-coach reality.

DROP POLICY IF EXISTS "Field reps publish crew beacons" ON realtime.messages;
CREATE POLICY "Field reps publish crew beacons"
  ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    realtime.messages.extension = 'broadcast'
    AND realtime.topic() = 'crew-live'
    AND (
      public.has_role(auth.uid(), 'canvasser'::public.app_role)
      OR public.has_role(auth.uid(), 'confirmer'::public.app_role)
      OR public.has_role(auth.uid(), 'captain'::public.app_role)
    )
  );

DROP POLICY IF EXISTS "Leadership watches crew beacons" ON realtime.messages;
CREATE POLICY "Leadership watches crew beacons"
  ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND realtime.topic() = 'crew-live'
    AND (
      public.has_role(auth.uid(), 'owner'::public.app_role)
      OR public.has_role(auth.uid(), 'captain'::public.app_role)
      OR public.has_role(auth.uid(), 'office_staff'::public.app_role)
    )
  );
