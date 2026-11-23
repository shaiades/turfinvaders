-- ═══════════════════════════════════════════════════════════════════════════
-- NO-SHOW ESCALATION — text the confirmation desk, one-tap "I called them"
-- (owner, 2026-11-23: "Every no show — can we also text Cynthia and Jeni in
-- the confirmation department so that they can call them... and then maybe
-- they can push a button or something that lets us all know they called.
-- that would send to Tyler and myself?")
--
-- Flow:
--   1. A Block card's BO column (status4) flips to "No Show". The
--      monday-live-dispatch webhook already receives that event; it claims
--      one no_show_escalations row PER ACTIVE CONFIRMER (token = opaque
--      128-bit hex), writes each confirmer's tokened callback link + phone
--      into per-confirmer columns on the card, then flips the card's
--      "Confirmer Alert" status to "Send".
--   2. Monday's existing Twilio SMS integration (the SAME channel that
--      already texts customers on "No show text" / color4) carries the
--      actual texts: one automation per confirmer, "When Confirmer Alert
--      changes to Send, send SMS to {confirmer phone column}", message
--      referencing {pulse.name}/{pulse.phone_1}/{pulse.location}/
--      {pulse.date9} and the confirmer's own link column. No new SMS
--      provider, no new secrets.
--   3. The link opens /called/<token> — a public, mobile-first page with a
--      single "I called them" button. Pressing it POSTs to /api/callback,
--      which stamps called_at (first press wins; repeats are idempotent),
--      inserts a webhook_logs 'Owner_Page' row — the 20261117220000 pg_net
--      trigger pushes that to every owner-role device (Shai, Tyler, Jorge)
--      — and flips Confirmer Alert to "Called" on the card.
--
-- Confirmers are DATA, not code: no_show_confirmers seeds Cynthia + Jeni
-- with the numbers the owner gave (619-719-0335 / 760-803-1174). Setting
-- active=false is the kill switch (no redeploy); the *_column_title fields
-- name the per-confirmer Monday columns BY TITLE, so weekly board clones
-- keep working without id pinning.
--
-- RLS: owner/office_staff may read (future in-app visibility); all writes
-- go through the service role (edge function + Vercel route). Anonymous
-- traffic only ever sees a row through /api/callback, token-gated.
--
-- Idempotent — safe to re-paste.
-- Apply via: supabase db query --linked --file supabase/migrations/20261123120000_no_show_escalations.sql
-- Then deploy: supabase functions deploy monday-live-dispatch --no-verify-jwt
-- Monday-side setup (template board + both active Block boards) is listed in
-- the PR; without the columns/automations the rows still record and the
-- webhook logs NoShow_Escalation_Board_Missing_Columns.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1) Who gets texted ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.no_show_confirmers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  -- E.164 (+1XXXXXXXXXX): written into the card's phone column, which the
  -- Twilio automation uses as the SMS receiver.
  phone text NOT NULL,
  -- Monday column TITLES (matched trimmed/lowercased), not ids: ids are
  -- stable across weekly clones but titles survive a template rebuild too,
  -- and the webhook already resolves every other column by title.
  link_column_title text NOT NULL,
  phone_column_title text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.no_show_confirmers (name, phone, link_column_title, phone_column_title)
VALUES
  ('Cynthia', '+16197190335', 'cynthia link', 'cynthia phone'),
  ('Jeni',    '+17608031174', 'jeni link',    'jeni phone')
ON CONFLICT (name) DO NOTHING;

-- ── 2) One row per (no-show card × confirmer) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.no_show_escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monday_item_id text NOT NULL,
  board_id text,
  office_location text,
  -- Customer snapshot at escalation time (the card can keep moving).
  lead_name text,
  customer_phone text,
  address text,
  appt_time text,
  card_date date,
  confirmer_id uuid NOT NULL REFERENCES public.no_show_confirmers(id) ON DELETE CASCADE,
  confirmer_name text NOT NULL,
  -- Opaque capability token carried in the SMS link. 128 bits of hex —
  -- unguessable, no signature needed (the row IS the validity check).
  token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Stamped after the link/phone columns + "Send" flip landed on Monday;
  -- NULL rows are retried by the webhook's redelivery loop (self-heal).
  monday_synced_at timestamptz,
  -- The button. First press wins; later presses read it back (idempotent).
  called_at timestamptz,
  -- Owner_Page insert landed (Tyler + Shai paged).
  notified_at timestamptz,
  UNIQUE (monday_item_id, confirmer_id)
);

CREATE INDEX IF NOT EXISTS no_show_escalations_item_idx
  ON public.no_show_escalations (monday_item_id);
CREATE INDEX IF NOT EXISTS no_show_escalations_created_idx
  ON public.no_show_escalations (created_at DESC);

-- ── 3) RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.no_show_confirmers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.no_show_escalations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read confirmers" ON public.no_show_confirmers;
CREATE POLICY "Admins read confirmers" ON public.no_show_confirmers
  FOR SELECT USING (
    public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
  );

DROP POLICY IF EXISTS "Admins read escalations" ON public.no_show_escalations;
CREATE POLICY "Admins read escalations" ON public.no_show_escalations
  FOR SELECT USING (
    public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
  );
-- No INSERT/UPDATE/DELETE policies: only the service role writes.
