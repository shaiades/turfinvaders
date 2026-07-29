-- Close Kombat (owner directive 2026-07-29): track SALES REP results in
-- Monday.com's own language. Every Block-board card is mirrored here as a
-- SNAPSHOT — one row per card, raw column label text stored verbatim
-- (BO = "No Show"/"No Demo", RS = "Reset", PM = "PM", Sale = "Sold") — not
-- as counters. Snapshots make webhook redeliveries harmless (plain upsert,
-- no claim-first machinery), let rep reassignments and outcome flips
-- self-heal on any later event, and let an on-demand Monday API sync
-- backfill history and reconcile deletions. Unlike the canvasser path,
-- "(copy)" cards COUNT here — recycled/rescheduled appointments are real
-- appointments for the rep who runs them.
--
-- REQUIRES 20260730005000_sales_rep_role.sql to have been run (and
-- committed) first — the read policy references 'sales_rep'::app_role.
-- Idempotent — safe to run more than once.

-- 1) Snapshot table — one row per Monday Block-board card.
CREATE TABLE IF NOT EXISTS public.block_cards (
  monday_item_id  text PRIMARY KEY,
  board_id        text NOT NULL,
  office_location text NOT NULL DEFAULT 'San Diego',
  -- Appointment date: board-week Monday (from the board name) + weekday
  -- offset (from the card's group title). NULL = underivable; such rows
  -- never match a date-range query and are excluded from stats.
  card_date       date,
  group_title     text,
  lead_name       text,
  -- Display names from the "Reps" people column, in board order.
  reps            text[] NOT NULL DEFAULT '{}',
  -- Raw Monday label text, verbatim (empty cell -> NULL).
  iss             text,
  bo              text,
  ol              text,
  rs              text,
  pm              text,
  sale            text,
  sale_price      numeric(12,2),
  products        text,
  canvass_stats   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS block_cards_card_date_idx ON public.block_cards (card_date);
CREATE INDEX IF NOT EXISTS block_cards_board_id_idx  ON public.block_cards (board_id);
CREATE INDEX IF NOT EXISTS block_cards_office_idx    ON public.block_cards (office_location);

-- 2) RLS — rows carry customer lead names (same sensitivity as public.leads).
--    Read: owner, office_staff, and sales_rep ONLY (captains excluded —
--    owner decision 2026-07-29). No write policies: writes come only from
--    the service role (edge function + sync), which bypasses RLS.
ALTER TABLE public.block_cards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "block_cards rep stats read" ON public.block_cards;
CREATE POLICY "block_cards rep stats read"
  ON public.block_cards FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'sales_rep'::app_role)
  );

GRANT SELECT ON public.block_cards TO authenticated;
GRANT ALL ON public.block_cards TO service_role;

-- 3) updated_at maintenance (same trigger fn as the other tables).
DROP TRIGGER IF EXISTS block_cards_touch_updated_at ON public.block_cards;
CREATE TRIGGER block_cards_touch_updated_at
  BEFORE UPDATE ON public.block_cards
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 4) Realtime — Close Kombat live-invalidates on any card change.
ALTER TABLE public.block_cards REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'block_cards'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.block_cards';
  END IF;
END $$;
