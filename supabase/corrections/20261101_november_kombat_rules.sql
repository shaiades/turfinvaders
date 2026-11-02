-- November Kombat go-live config (owner approved 2026-11-01). Run AFTER:
--   1. PR with the cash-back engine is merged (Lovable deploys the app), and
--   2. supabase/migrations/20261101130000_november_kombat.sql is applied.
-- Run from the MAIN checkout: supabase db query --linked -f <this file>
-- Then hit "Recompute ledger" in the Kombat admin (or wait for the cron).
--
-- Model: points unlock a cash-back RATE on the rep's own net written
-- November volume (pct is a percent; floor backstops the check). Team
-- unlock $2.5M → every rate ×1.25. No dinners this month.
--
-- ⚠ October note: flipping contest.month means the recompute stops
-- touching October rows, so they freeze as they stand (they never
-- auto-lock). October payouts are being settled by hand anyway
-- (eligibility waiver pending); after Nov 3 you MAY hard-lock the October
-- book with the commented statement at the bottom.

UPDATE public.contest_rules SET rules = '{
  "contest": { "month": "2026-11-01", "label": "November Kombat" },
  "card": {
    "sit": 3,
    "reload": 15,
    "selfgen_sale": 20,
    "referral_sale": 30,
    "referral_miss": 15
  },
  "activity": { "reload_pitch": 0, "weekly_test": 5 },
  "proofs": { "weights": { "referral_sit": 10, "canvasser_recruit": 25 } },
  "eligibility": { "require_weekly_test": false },
  "prizes": {
    "tiers": [
      { "key": "bronze", "label": "Bronze", "points": 325, "cash": 0, "pct": 0.5, "floor": 500 },
      { "key": "silver", "label": "Silver", "points": 425, "cash": 0, "pct": 1, "floor": 1250 },
      { "key": "gold", "label": "Gold", "points": 525, "cash": 0, "pct": 2, "floor": 2500 },
      { "key": "king", "label": "Kombat King", "points": 650, "cash": 0, "pct": 3, "floor": 4000 }
    ],
    "unlock_threshold": 2500000,
    "unlock_multiplier": 1.25,
    "budget_cap": 30000,
    "dinner_cost_per_head": 0
  }
}'::jsonb,
updated_at = now()
WHERE id = true;

-- Bonus stage weeks (pre-announced on the launch poster). Idempotent by
-- label + window.
INSERT INTO public.contest_bounties (label, categories, multiplier, starts_on, ends_on, active)
SELECT v.label, v.categories, v.multiplier, v.starts_on::date, v.ends_on::date, true
FROM (VALUES
  ('Reload Week',    ARRAY['card.reload'],                                        2.0, '2026-11-02', '2026-11-08'),
  ('Referral Week',  ARRAY['card.referral_sale','card.referral_miss','proof.referral_sit'], 2.0, '2026-11-09', '2026-11-15'),
  ('Sit Week',       ARRAY['card.sit'],                                           2.0, '2026-11-16', '2026-11-22')
) AS v(label, categories, multiplier, starts_on, ends_on)
WHERE NOT EXISTS (
  SELECT 1 FROM public.contest_bounties b
  WHERE b.label = v.label AND b.starts_on = v.starts_on::date
);
-- Week 4 (Nov 23–29) is the Black Friday Blitz: instant cash on blitz
-- days, paid outside the points engine — no bounty row.

-- AFTER Nov 3 only (October cancel window closed), to hard-lock October:
-- UPDATE public.contest_ledger SET status = 'locked', locked_at = now()
--   WHERE month = '2026-10-01' AND status = 'pending';
