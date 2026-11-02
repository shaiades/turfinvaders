-- November Kombat (owner directive 2026-11-01): cash-back contest.
--
--   • Weekly Activity Tests become POINTS (ledger category
--     activity.weekly_test, source_kind 'activity_test') instead of an
--     all-or-nothing eligibility cliff — October's gate formally
--     disqualified every rep (best was 4/5 weeks).
--   • New proof category 'canvasser_recruit': a rep recruits a canvasser;
--     the admin approves the proof once the recruit has 2 confirmed leads.
--
-- Prize math (points unlock a cash-back RATE on the rep's own net written
-- volume) lives in contest_rules.rules + src/lib/kombat-month.ts — no
-- schema change needed for it.
--
-- APPLY BY HAND via `supabase db query --linked -f <this file>` from the
-- MAIN checkout (never `db push` — remote migration history is empty).
-- Idempotent: safe to run more than once.

ALTER TABLE public.contest_ledger
  DROP CONSTRAINT IF EXISTS contest_ledger_source_kind_check;
ALTER TABLE public.contest_ledger
  ADD CONSTRAINT contest_ledger_source_kind_check CHECK (source_kind IN
    ('report_sale','sit','reload_pitch','self_gen_pitch','proof','activity_test'));

ALTER TABLE public.contest_proofs
  DROP CONSTRAINT IF EXISTS contest_proofs_category_check;
ALTER TABLE public.contest_proofs
  ADD CONSTRAINT contest_proofs_category_check CHECK (category IN
    ('testimonial','google_review','referral_sit','before_after','role_play',
     'gym_checkin','canvasser_recruit'));
