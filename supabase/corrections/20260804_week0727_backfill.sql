-- Week of 2026-07-27 backfill (authored 2026-08-04, from the OC/SD audit).
-- Restores the four sales the "(copy)" skip dropped from payroll and squares
-- daily_logs (the payroll + Weekly Results source) with the Monday boards.
-- Every UPDATE is guarded by the row's current values — re-running this
-- script changes nothing. daily_metrics day-tiles are deliberately left
-- alone. Run in the xogit (xogitpqeuwalerxygvjw) SQL editor.

BEGIN;

-- ── A. The four lost sales → leads (payroll commissions) ───────────────────
INSERT INTO public.leads
  (canvasser_id, team_id, status, is_sale, customer_name, sale_amount,
   created_at, reviewed_at, notes, monday_item_id)
VALUES
  ('caa4d1fa-d90c-4794-bcb4-b4e233f6c9e5', '4db19771-2ab7-4281-933e-c5b371888e39',
   'confirmed', true, 'Bill & Mrs Joan Grove', 25683,
   '2026-07-31T20:00:00Z', '2026-07-31T20:00:00Z',
   'Monday live sale (backfill 2026-08-04)', '12688841096'),
  ('7292ab33-7fe6-4e8f-868b-4c2ad669cc4c', '4db19771-2ab7-4281-933e-c5b371888e39',
   'confirmed', true, 'Linda Fitzle & Mr.', 41000,
   '2026-08-01T20:00:00Z', '2026-08-01T20:00:00Z',
   'Monday live sale (backfill 2026-08-04)', '12704211279'),
  ('729cbd46-171e-46d4-8962-0a74f5753743', 'b8e9fff3-23f7-4a41-a01b-8b86b1a5109f',
   'confirmed', true, 'Richard & Karen Scott', 6986,
   '2026-08-01T20:00:00Z', '2026-08-01T20:00:00Z',
   'Monday live sale (backfill 2026-08-04)', '12703026173'),
  ('8e92332f-5e1a-45a8-84e5-f88d1eb2bc2e', NULL,
   'confirmed', true, 'Laurent Longfellow', 36000,
   '2026-08-01T20:00:00Z', '2026-08-01T20:00:00Z',
   'Monday live sale (backfill 2026-08-04)', '12707764251')
ON CONFLICT (monday_item_id) DO NOTHING;

-- ── B. daily_logs corrections ── Orange County ─────────────────────────────
-- Logan temple Fri 7/31: Grove ran as a Sale (was stuck as Sit) + the Faye
-- Dunn Friday rep-reset that shares a pulse with Wednesday's card.
UPDATE public.daily_logs SET sales = 1, future_leads = 1
WHERE id = '8a76a796-7e44-4415-9fa8-f0afd5bced52'
  AND demos_sits = 2 AND sales = 0 AND future_leads = 0;

-- Eduardo Sat 8/1: Linda Fitzle $41,000 sale (entered Mon 8/3, never counted).
UPDATE public.daily_logs SET demos_sits = 1, sales = 1, leads_called_in = 2
WHERE id = 'e031c0f0-061e-4347-b54f-1277bf4ef7de'
  AND demos_sits = 0 AND sales = 0 AND leads_called_in = 1;

-- Eduardo Fri 7/31: race double-recorded one sit.
UPDATE public.daily_logs SET demos_sits = 1
WHERE id = 'c92d8304-fc61-4796-a388-453ba294119e' AND demos_sits = 2;

-- Eduardo Tue 7/28: Blanca Henderson CTC (recorded then reverted 1s later).
UPDATE public.daily_logs SET ctc = 1
WHERE id = '2fd91e17-eb05-4c4e-ad7a-b395fc7c373f' AND ctc = 0;

-- Ernie Fri 7/31 OC: Kyle & Niaz Fox sit (entered Mon 8/3, never counted).
UPDATE public.daily_logs SET demos_sits = 2, leads_called_in = 1
WHERE id = 'ebe5c232-516f-4942-afdd-447b4e7431be'
  AND demos_sits = 1 AND leads_called_in = 0;

-- Ernie Wed 7/29 OC: Maggie Shao blowout race-counted twice.
UPDATE public.daily_logs SET no_demo = 1
WHERE id = '6f6d43f2-0b1c-42e1-89a0-7facca4e3525' AND no_demo = 2;

-- John Porzio Thu 7/30: Fred Holstein sit (copy-only card, never counted).
UPDATE public.daily_logs SET demos_sits = 1, leads_called_in = 1
WHERE id = '158b6af0-d557-48e4-abd2-9e6d3bb93a2a'
  AND demos_sits = 0 AND leads_called_in = 0;

-- Levon Wed 7/29: Linda Ledger sale race-counted twice.
UPDATE public.daily_logs SET demos_sits = 1, sales = 1
WHERE id = '117f4b1f-c45d-4704-b8b9-ec4616f5187e'
  AND demos_sits = 2 AND sales = 2;

-- Levon Tue 7/28: Teri Whited blowout (recorded then reverted 30s later).
UPDATE public.daily_logs SET no_demo = 1
WHERE id = 'd90ff3a0-c19f-4249-af07-50c56172d0ef' AND no_demo = 0;

-- Stephen Wed 7/29: Ian & heather rep-reset pair shares one pulse.
UPDATE public.daily_logs SET future_leads = 2
WHERE id = '7de2f93e-f38e-47f5-bd88-1954efe3dc34' AND future_leads = 1;

-- ── daily_logs corrections ── San Diego ────────────────────────────────────
-- Jorge N Tue 7/28: Lisa & Rick Ono CTC (recorded, later lost).
UPDATE public.daily_logs SET ctc = 1
WHERE id = '2a27add1-e303-42ef-9df2-82d9574f3bc2' AND ctc = 0;

-- Nate Thu 7/30: Julio Munoz CTC (recorded then reverted 7s later).
UPDATE public.daily_logs SET ctc = 1
WHERE id = '4540b7b6-f260-450e-aff1-96cf3d8ef95a' AND ctc = 0;

-- Nate Fri 7/31: Arline Iannone blowout race-counted twice.
UPDATE public.daily_logs SET no_demo = 2
WHERE id = 'e2965c6d-72d1-4283-a1ac-439d5e8365ce' AND no_demo = 3;

-- Brianna Wed 7/29: Glenn Wingert sit (recorded then reverted 1s later).
UPDATE public.daily_logs SET demos_sits = 2
WHERE id = '4202eca2-3341-4107-80e4-47624ba673b3' AND demos_sits = 1;

-- Eric Fri 7/31: Killinger blowout (recorded then reverted 21s later).
UPDATE public.daily_logs SET no_demo = 1
WHERE id = '1c3a7b98-c65a-45c6-82d8-88c40e591fe5' AND no_demo = 0;

-- Ethan Wed 7/29: Grey + Sykora resets consumed by Thursday rep-reset pairs.
UPDATE public.daily_logs SET future_leads = 2
WHERE id = '998ce2b8-c31f-4116-ac76-d9bb48c38c9d' AND future_leads = 0;

-- Eric Wed 7/29: Catania reset consumed by Thursday's sale on the same pulse.
UPDATE public.daily_logs SET future_leads = 1
WHERE id = 'ebe0fbb6-b070-475f-86bf-5d176ac140c0' AND future_leads = 0;

-- Ernie Sat 8/1 SD: Hagmann revert burned one of the two Saturday resets.
UPDATE public.daily_logs SET future_leads = 2
WHERE id = 'bb15a658-1fdb-4049-8ce3-5cb0abb5e257' AND future_leads = 1;

-- Marcel Thu 7/30: Angie & Victor Hawkins is a Reset, not a third blowout.
UPDATE public.daily_logs SET future_leads = 1, no_demo = 0
WHERE id = '34f11c77-32c9-409e-8c8a-9707d10ba4b4'
  AND future_leads = 0 AND no_demo = 1;

-- Miguel Sat 8/1: Richard & Karen Scott $6,986 sale (entered Mon 8/3).
UPDATE public.daily_logs SET demos_sits = 1, sales = 1, leads_called_in = 3
WHERE id = '531ba462-4918-4573-aaa4-01fc3752ff92'
  AND demos_sits = 0 AND sales = 0 AND leads_called_in = 2;

-- Jaxon Sat 8/1: Laurent Longfellow $36,000 self-gen sale — no row existed.
INSERT INTO public.daily_logs
  (canvasser_id, team_id, log_date, office_location,
   demos_sits, sales, leads_called_in)
VALUES
  ('8e92332f-5e1a-45a8-84e5-f88d1eb2bc2e', NULL, '2026-08-01', 'San Diego',
   1, 1, 1)
ON CONFLICT (canvasser_id, log_date, office_location) DO NOTHING;

COMMIT;

-- Eyeball check: the four restored sales.
SELECT customer_name, sale_amount, status, monday_item_id
FROM public.leads
WHERE monday_item_id IN ('12688841096','12704211279','12703026173','12707764251')
ORDER BY sale_amount DESC;
