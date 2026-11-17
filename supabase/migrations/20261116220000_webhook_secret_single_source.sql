-- ═══════════════════════════════════════════════════════════════════════════
-- WEBHOOK SECRET: SINGLE SOURCE OF TRUTH (owner mandate 2026-11-16: "make
-- sure this doesn't happen every week").
--
-- The Monday live-dispatch shared secret used to live in TWO hand-pasted env
-- vars — Vercel's MONDAY_WEBHOOK_SECRET (used by rotate-boards to build hook
-- URLs) and the edge function's copy (used to validate deliveries). Each had
-- to be pasted by hand and kept identical. A bad paste on the Vercel side
-- killed the weekly board rotation twice (11/9: ~725-char paste; 11/16: a
-- 191-char value pushed hook URLs past Monday's 255-char cap), each time
-- leaving the app watching the previous week's boards and losing live
-- results.
--
-- This column makes system_settings the one authoritative copy, next to
-- monday_api_token (same trust level, same owner-only RLS; the service role
-- reads it server-side). rotate-boards and monday-live-dispatch both read it
-- first and fall back to their env vars only when it is empty, so the value
-- is set ONCE, by SQL, and the env copies stop mattering.
--
-- The value itself is deliberately NOT set here — a secret never belongs in
-- a migration file. Ops sets it:
--   UPDATE public.system_settings SET monday_webhook_secret = '<48-hex>';
-- and re-registers the Monday webhooks so their URLs carry the new value.
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261116220000_webhook_secret_single_source.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS monday_webhook_secret text;

COMMENT ON COLUMN public.system_settings.monday_webhook_secret IS
  'Shared secret carried in Monday webhook delivery URLs (?secret=...) and '
  'validated by monday-live-dispatch. Single source of truth; the '
  'MONDAY_WEBHOOK_SECRET env vars on Vercel and the edge function are '
  'fallbacks only. Keep it 16-110 chars of [A-Za-z0-9_-] so hook URLs stay '
  'under Monday''s 255-char cap.';
