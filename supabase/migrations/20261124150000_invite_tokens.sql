-- ═══════════════════════════════════════════════════════════════════════════
-- DURABLE INVITE TOKENS (owner ask 2026-11-23: "adding people… one step").
--
-- The old invite link was a Supabase recovery link minted when the ADMIN
-- generated it — good for ~1 hour, so links died before the new hire opened
-- them. This table makes the link the admin shares a long-lived pointer:
-- /auth/welcome?it=<token>. Only when the invitee taps ENTER does the server
-- exchange it for a fresh recovery OTP (redeemInvite), so the 1-hour window
-- starts at the moment it's actually used.
--
--   · 128-bit random token (no_show_escalations precedent, 20261123120000).
--   · 14-day life; re-inviting supersedes earlier active rows.
--   · RLS enabled with NO policies: service-role only (the server fns in
--     src/lib/invites.functions.ts are the only readers/writers).
--
-- Idempotent; applied via: supabase db query --linked --file <this file>
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.invite_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '14 days',
  used_at timestamptz,
  superseded_at timestamptz
);

CREATE INDEX IF NOT EXISTS invite_tokens_user_idx ON public.invite_tokens(user_id);

ALTER TABLE public.invite_tokens ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: anon/authenticated can touch nothing; the server
-- functions use the service role.
GRANT ALL ON public.invite_tokens TO service_role;
