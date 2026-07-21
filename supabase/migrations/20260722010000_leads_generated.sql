-- Leads Generated (owner directive 2026-07-21): "Submitted" means leads
-- GENERATED — new items created on the static Monday "Incoming Leads" board
-- (board 4155518549) — not appointment results. Results (PM/BO/RS/Sale/
-- Confirmed/Killed) keep flowing from the weekly Block boards.
-- daily_metrics.leads_submitted keeps its legacy outcome-derived meaning
-- (daily-wrap, captain dashboard, and the legacy webhook route read it);
-- the new counter is a separate column.

-- 1) New counter
ALTER TABLE public.daily_metrics
  ADD COLUMN IF NOT EXISTS leads_generated integer NOT NULL DEFAULT 0;

-- 2) Board pointer (static board — unlike the weekly-rotating Block boards)
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS incoming_leads_board_id text;
UPDATE public.system_settings
SET incoming_leads_board_id = '4155518549'
WHERE id = TRUE AND incoming_leads_board_id IS NULL;

-- 3) Atomic increment — Monday delivers create events in bursts (batched item
--    fetches release simultaneously), so a client-side read-modify-write races
--    and drops counts. Single-statement upsert cannot.
CREATE OR REPLACE FUNCTION public.increment_leads_generated(
  _canvasser_id uuid,
  _metric_date date,
  _office text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.daily_metrics (canvasser_id, metric_date, office_location, leads_generated)
  VALUES (_canvasser_id, _metric_date, COALESCE(_office, 'San Diego'), 1)
  ON CONFLICT (canvasser_id, metric_date)
  DO UPDATE SET leads_generated = public.daily_metrics.leads_generated + 1;
$$;

REVOKE ALL ON FUNCTION public.increment_leads_generated(uuid, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_leads_generated(uuid, date, text) TO service_role;

-- 4) Marker-lookup indexes — the webhook idempotency checks filter
--    webhook_logs by step + a jsonb field; only created_at was indexed.
CREATE INDEX IF NOT EXISTS webhook_logs_step_trigger_uuid_idx
  ON public.webhook_logs (step, (data->>'triggerUuid'));
CREATE INDEX IF NOT EXISTS webhook_logs_step_pulse_id_idx
  ON public.webhook_logs (step, (data->>'pulseId'));
