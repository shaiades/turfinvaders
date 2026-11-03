-- ═══════════════════════════════════════════════════════════════════════════
-- CONFIRM + SOLD CELEBRATION BRIDGE (canvassing engagement audit 2026-11-03,
-- Tier 1 §1.2 + §1.6) — two gaps in the payoff loop, both server-side:
--
--   A. THE MONDAY CONFIRM PATH NEVER CELEBRATED. LeadConfirmedCelebration
--      listens to lead_events INSERTs, but fire_lead_event_on_confirm only
--      fires on leads.status → 'confirmed' (the Desk path). A Monday
--      "Lead Status → Confirmed" flip never touches `leads` — it lands as a
--      daily_metrics.leads_confirmed bump (claim_lead_status_transition), so
--      field reps never saw the confetti for the MAIN confirm path. New
--      trigger mirrors money_push_on_metrics (20261029120000 §B3): a
--      leads_confirmed increment inserts one lead_events row for the delta.
--
--   B. CANVASSERS HAD NO SALE MOMENT. SaleVictoryFx is Close Kombat (sales
--      reps) only; the lead_sold push existed but no in-app FX. lead_events
--      grows a `kind` ('confirmed' | 'sold') + `amount`, and a new trigger on
--      `leads` fires kind='sold' when a sale lands confirmed with an amount
--      (same transition test as money_push_on_lead's _sold). The client
--      branches on kind: sold = the big gold K.O.
--
--   Consumers that COUNT lead_events as confirmed leads (useTodayLeads)
--   filter kind='confirmed' client-side so sold rows don't double-count.
--
--   Known accepted gap (same as fire_lead_event_on_confirm): a team-less
--   canvasser gets no event — lead_events.team_id is NOT NULL. We fall back
--   to the profile's team before giving up.
--
--   Possible double confetti, accepted: a lead confirmed on the Desk AND
--   later flipped in Monday fires both paths (the money pushes already
--   accept the same overlap, §B2/§B3); the client's 5-minute fence plus the
--   rarity of the overlap bounds it.
--
-- GAME + MESSAGING ONLY — nothing here touches pay or production counters.
-- Idempotent — safe to re-paste.
-- Apply via: supabase db query --linked --file supabase/migrations/20261103120000_confirm_sold_fx.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) lead_events: kind + amount ────────────────────────────────────────────
ALTER TABLE public.lead_events
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'confirmed',
  ADD COLUMN IF NOT EXISTS amount numeric;

DO $$ BEGIN
  ALTER TABLE public.lead_events
    ADD CONSTRAINT lead_events_kind_check CHECK (kind IN ('confirmed', 'sold'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2) Monday confirm path → lead_events ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fire_lead_event_on_metrics_confirm()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _delta int;
  _team uuid;
BEGIN
  IF NEW.canvasser_id IS NULL THEN RETURN NEW; END IF;
  _delta := COALESCE(NEW.leads_confirmed, 0)
    - COALESCE(CASE WHEN TG_OP = 'UPDATE' THEN OLD.leads_confirmed ELSE 0 END, 0);
  IF _delta <= 0 THEN RETURN NEW; END IF;
  BEGIN
    IF public.is_pseudo_source_name(
         (SELECT display_name FROM public.profiles WHERE id = NEW.canvasser_id)) THEN
      RETURN NEW; -- channel credit, not a person
    END IF;
    _team := COALESCE(
      NEW.team_id,
      (SELECT team_id FROM public.profiles WHERE id = NEW.canvasser_id));
    IF _team IS NULL THEN RETURN NEW; END IF; -- benched player, accepted gap

    INSERT INTO public.lead_events (team_id, canvasser_id, count, occurred_at, kind)
    VALUES (_team, NEW.canvasser_id, _delta, now(), 'confirmed');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- a hype hiccup must never break the Monday webhook's write
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS daily_metrics_fire_lead_event ON public.daily_metrics;
CREATE TRIGGER daily_metrics_fire_lead_event
  AFTER INSERT OR UPDATE OF leads_confirmed ON public.daily_metrics
  FOR EACH ROW EXECUTE FUNCTION public.fire_lead_event_on_metrics_confirm();

-- ── 3) Sold → lead_events(kind='sold') ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fire_lead_event_on_sold()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _team uuid;
BEGIN
  IF NEW.canvasser_id IS NULL THEN RETURN NEW; END IF;
  -- Same "the sale just landed" transition as money_push_on_lead's _sold.
  IF NOT (NEW.status = 'confirmed' AND COALESCE(NEW.is_sale, false)
          AND COALESCE(NEW.sale_amount, 0) > 0
          AND (TG_OP = 'INSERT'
               OR OLD.status IS DISTINCT FROM 'confirmed'
               OR COALESCE(OLD.is_sale, false) IS DISTINCT FROM true
               OR COALESCE(OLD.sale_amount, 0) <= 0)) THEN
    RETURN NEW;
  END IF;
  BEGIN
    IF public.is_pseudo_source_name(
         (SELECT display_name FROM public.profiles WHERE id = NEW.canvasser_id)) THEN
      RETURN NEW;
    END IF;
    _team := COALESCE(
      NEW.team_id,
      (SELECT team_id FROM public.profiles WHERE id = NEW.canvasser_id));
    IF _team IS NULL THEN RETURN NEW; END IF;

    INSERT INTO public.lead_events (team_id, canvasser_id, count, occurred_at, kind, amount)
    VALUES (_team, NEW.canvasser_id, 1, now(), 'sold', NEW.sale_amount);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- never break the sale-price write
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS leads_fire_sold_event ON public.leads;
CREATE TRIGGER leads_fire_sold_event
  AFTER INSERT OR UPDATE OF status, is_sale, sale_amount ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.fire_lead_event_on_sold();
