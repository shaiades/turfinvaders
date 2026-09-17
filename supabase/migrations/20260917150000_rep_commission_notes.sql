-- Sales-rep self-tracked commission (owner request 2026-09-17): reps see
-- pure activity stats on Close Kombat today, nothing about money. Real
-- commission lives in Monday.com's Builder Accounts board — investigated and
-- rejected as a sync source: it holds a rep's entire history with no
-- per-paycheck grouping, and its numbers shift constantly as bids/finance
-- fees come in. Instead the rep enters their OWN approximate commission per
-- deal, toggles whether it's going out on the next paycheck, and later edits
-- in the exact payout once paid. This is an unofficial, rep-owned
-- scratchpad — never presented as an official payroll figure, and never
-- read by the pay engine.
--
-- One row per (deal, rep): monday_item_id ties back to a block_cards row the
-- same way Close Kombat's "My Deals" already identifies a rep's own cards.

CREATE TABLE IF NOT EXISTS public.rep_commission_notes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monday_item_id    text NOT NULL,
  rep_id            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  estimated_amount  numeric(12,2),
  actual_amount     numeric(12,2),
  next_payroll      boolean NOT NULL DEFAULT false,
  paid_at           date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (monday_item_id, rep_id)
);

CREATE INDEX IF NOT EXISTS rep_commission_notes_rep_idx ON public.rep_commission_notes (rep_id);

-- RLS: rep-only, both ways. This is the rep's own unofficial scratchpad, not
-- an office-audited figure — no owner/office_staff read bypass, unlike
-- commission_clawbacks. (If leadership ever needs visibility into these,
-- that's a deliberate follow-up policy change, not an oversight here.)
ALTER TABLE public.rep_commission_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reps manage own commission notes" ON public.rep_commission_notes;
CREATE POLICY "reps manage own commission notes"
  ON public.rep_commission_notes FOR ALL TO authenticated
  USING (rep_id = auth.uid())
  WITH CHECK (rep_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.rep_commission_notes TO authenticated;
GRANT ALL ON public.rep_commission_notes TO service_role;

DROP TRIGGER IF EXISTS rep_commission_notes_touch_updated_at ON public.rep_commission_notes;
CREATE TRIGGER rep_commission_notes_touch_updated_at
  BEFORE UPDATE ON public.rep_commission_notes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
