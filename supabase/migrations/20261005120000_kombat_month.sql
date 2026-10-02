-- Kombat Month (owner directive 2026-10-02): a points contest for all sales
-- reps (SD + OC), Oct 1–31 2026. Every point is one contest_ledger row that
-- traces to a Monday item or an approved proof — totals are ALWAYS computed
-- from the ledger, never stored. Scoring weights, caps, tiers, the cancel
-- window and the budget cap live in contest_rules so the owner tunes them
-- without a deploy. Money/activity rows are derived server-side (service
-- role) by the recompute pass in src/lib/kombat-month.server.ts; proof rows
-- are written by the admin review server fn. Clients never write the ledger.
-- Idempotent — safe to run more than once.

-- ── 1. report_sales: the three Sales-Report columns the contest scores on.
-- Captured by title ("source" / "marketing home" / "advantage+") in the
-- Sales-Report pass, same as every other report column. Raw label text,
-- never normalized at capture (never guess column meanings).
ALTER TABLE public.report_sales
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS marketing_home text,
  ADD COLUMN IF NOT EXISTS advantage_plus text;

-- ── 2. Reloads subitems mirror. The report boards' "Reloads" subitem rows
-- (Result = Sold / PM / Waiting, Date Went, Rep) are the reload-pitch
-- evidence. board_id is the PARENT report board — the reconcile deletes a
-- board's stale subitem rows the same way report_sales does.
CREATE TABLE IF NOT EXISTS public.report_sale_reloads (
  subitem_id text PRIMARY KEY,
  parent_item_id text NOT NULL,
  board_id text NOT NULL,
  board_name text NOT NULL,
  report_month date NOT NULL,
  name text,
  result text,
  date_went date,
  due_date date,
  reps text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_sale_reloads_month_idx ON public.report_sale_reloads (report_month);
CREATE INDEX IF NOT EXISTS report_sale_reloads_parent_idx ON public.report_sale_reloads (parent_item_id);
CREATE INDEX IF NOT EXISTS report_sale_reloads_board_idx ON public.report_sale_reloads (board_id);

ALTER TABLE public.report_sale_reloads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Kombat roles read reload subitems" ON public.report_sale_reloads;
CREATE POLICY "Kombat roles read reload subitems" ON public.report_sale_reloads
  FOR SELECT USING (
    public.has_role(auth.uid(), 'owner') OR
    public.has_role(auth.uid(), 'office_staff') OR
    public.has_role(auth.uid(), 'sales_rep')
  );
-- No write policies: the Sales-Report sync (service role) is the only writer.
GRANT SELECT ON public.report_sale_reloads TO authenticated;
GRANT ALL ON public.report_sale_reloads TO service_role;

DROP TRIGGER IF EXISTS report_sale_reloads_touch ON public.report_sale_reloads;
CREATE TRIGGER report_sale_reloads_touch
  BEFORE UPDATE ON public.report_sale_reloads
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 3. block_cards: the Block boards' free-text Source and Agent columns.
-- "self gen" there is the only signal that a rep generated their own lead
-- (self-gen-pitched detection; rule proposed in PR, tunable via rules).
ALTER TABLE public.block_cards
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS agent text;

-- ── 4. contest_rules: single-row config, same key shape as company_settings.
-- The jsonb is merged over the code defaults (DEFAULT_KOMBAT_RULES in
-- src/lib/kombat-month.ts) so a missing key never zeroes a weight.
CREATE TABLE IF NOT EXISTS public.contest_rules (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.contest_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Signed-in read contest rules" ON public.contest_rules;
CREATE POLICY "Signed-in read contest rules" ON public.contest_rules
  FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "Admins write contest rules" ON public.contest_rules;
CREATE POLICY "Admins write contest rules" ON public.contest_rules
  FOR ALL USING (
    public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
  ) WITH CHECK (
    public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
  );
GRANT SELECT, INSERT, UPDATE ON public.contest_rules TO authenticated;
GRANT ALL ON public.contest_rules TO service_role;
INSERT INTO public.contest_rules (id, rules) VALUES (true, '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

-- ── 5. contest_proofs: the upload queue. Born pending by the rep (photo or
-- video in the contest-proofs bucket + a note), reviewed by the Admin tier
-- (owner + office_staff — "Manager"). Approval happens in the admin server
-- fn, which computes capped points and writes the ledger row atomically;
-- clients can only INSERT pending rows, exactly like objection_attempts.
CREATE TABLE IF NOT EXISTS public.contest_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN
    ('testimonial','google_review','referral_sit','before_after','role_play','gym_checkin')),
  storage_path text,
  note text NOT NULL,
  link_url text,
  customer_name text,
  sat_on date,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  points_awarded numeric,
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  deny_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contest_proofs_status_idx ON public.contest_proofs (status);
CREATE INDEX IF NOT EXISTS contest_proofs_rep_idx ON public.contest_proofs (rep_id, created_at);

ALTER TABLE public.contest_proofs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Reps submit own pending proofs" ON public.contest_proofs;
CREATE POLICY "Reps submit own pending proofs" ON public.contest_proofs
  FOR INSERT WITH CHECK (
    rep_id = auth.uid() AND status = 'pending'
    AND reviewed_by IS NULL AND reviewed_at IS NULL AND deny_reason IS NULL
    AND points_awarded IS NULL
  );
DROP POLICY IF EXISTS "Read own or admin proofs" ON public.contest_proofs;
CREATE POLICY "Read own or admin proofs" ON public.contest_proofs
  FOR SELECT USING (
    rep_id = auth.uid() OR
    public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
  );
-- Approved proofs are cap evidence and anchor locked ledger rows — nobody
-- deletes them from the client (review 2026-10-02: deleting one reset the
-- cap count while its locked points stood).
DROP POLICY IF EXISTS "Delete own pending or admin" ON public.contest_proofs;
CREATE POLICY "Delete own pending or admin" ON public.contest_proofs
  FOR DELETE USING (
    (rep_id = auth.uid() AND status = 'pending') OR
    (
      status <> 'approved' AND
      (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'))
    )
  );
-- No client UPDATE: review goes through the admin server fn (service role).
GRANT SELECT, INSERT, DELETE ON public.contest_proofs TO authenticated;
GRANT ALL ON public.contest_proofs TO service_role;

-- ── 6. contest_ledger: one row per point grant. Natural key
-- (source_kind, source_id, rep_name, category) — the recompute pass upserts
-- against it. status: pending (counts NOW, revisable all month — owner
-- 2026-10-02: points count right away) → locked once the cancel window
-- after MONTH END passes (the final count; never changes again) or
-- cancelled (source died; kept for the "−X pts" feed, excluded from sums).
CREATE TABLE IF NOT EXISTS public.contest_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month date NOT NULL,
  rep_name text NOT NULL,
  category text NOT NULL,
  points numeric NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','locked','cancelled')),
  source_kind text NOT NULL CHECK (source_kind IN
    ('report_sale','sit','reload_pitch','self_gen_pitch','proof')),
  source_id text NOT NULL,
  occurred_on date,
  locked_at timestamptz,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_id, rep_name, category)
);
CREATE INDEX IF NOT EXISTS contest_ledger_month_idx ON public.contest_ledger (month);
CREATE INDEX IF NOT EXISTS contest_ledger_rep_idx ON public.contest_ledger (rep_name, month);
CREATE INDEX IF NOT EXISTS contest_ledger_status_idx ON public.contest_ledger (status);

ALTER TABLE public.contest_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Kombat roles read contest ledger" ON public.contest_ledger;
CREATE POLICY "Kombat roles read contest ledger" ON public.contest_ledger
  FOR SELECT USING (
    public.has_role(auth.uid(), 'owner') OR
    public.has_role(auth.uid(), 'office_staff') OR
    public.has_role(auth.uid(), 'sales_rep')
  );
-- No client writes: the recompute pass and proof review (service role) own it.
GRANT SELECT ON public.contest_ledger TO authenticated;
GRANT ALL ON public.contest_ledger TO service_role;

DROP TRIGGER IF EXISTS contest_ledger_touch ON public.contest_ledger;
CREATE TRIGGER contest_ledger_touch
  BEFORE UPDATE ON public.contest_ledger
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 7. contest_bounties: time-boxed category multipliers ("Self Gen Week:
-- ×2, Oct 13–19"). Applied at recompute/approval time; the banner reads the
-- active rows client-side.
CREATE TABLE IF NOT EXISTS public.contest_bounties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  categories text[] NOT NULL DEFAULT '{}',
  multiplier numeric NOT NULL DEFAULT 2,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.contest_bounties ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Signed-in read bounties" ON public.contest_bounties;
CREATE POLICY "Signed-in read bounties" ON public.contest_bounties
  FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "Admins write bounties" ON public.contest_bounties;
CREATE POLICY "Admins write bounties" ON public.contest_bounties
  FOR ALL USING (
    public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
  ) WITH CHECK (
    public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contest_bounties TO authenticated;
GRANT ALL ON public.contest_bounties TO service_role;

-- ── 8. Storage: contest-proofs bucket, private, folder-per-user — the
-- objection-attempts pattern verbatim.
INSERT INTO storage.buckets (id, name, public)
VALUES ('contest-proofs', 'contest-proofs', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Reps upload own contest proofs" ON storage.objects;
CREATE POLICY "Reps upload own contest proofs" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'contest-proofs'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
DROP POLICY IF EXISTS "Read own contest proofs" ON storage.objects;
CREATE POLICY "Read own contest proofs" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'contest-proofs'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text OR
      public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
    )
  );
DROP POLICY IF EXISTS "Delete own contest proofs" ON storage.objects;
CREATE POLICY "Delete own contest proofs" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'contest-proofs'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text OR
      public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
    )
  );

-- ── 9. Realtime: the feed watches ledger inserts/updates; the Desk badge
-- and bounty banners ride the same channel pattern.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.contest_ledger;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.contest_proofs;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.contest_bounties;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.contest_rules;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE public.contest_ledger REPLICA IDENTITY FULL;
ALTER TABLE public.contest_proofs REPLICA IDENTITY FULL;
