-- ═══════════════════════════════════════════════════════════════════════════
-- ARCADE SCORE v2 — the canvasser points engine (engagement audit 2026-11-03,
-- Tier 2). Street-Fighter scoring for the FIELD, cloned from the proven
-- Kombat pattern (jsonb rules singleton + append-only ledger + pure client
-- lib + in-app admin editor) but on its OWN tables: contest_* belongs to the
-- live sales-rep Kombat and is never touched here.
--
-- WHY: a knock earned 0 points and the only reward (sit = 1 pay point)
-- landed days later via Monday. Points are now granted SERVER-side the
-- moment the action lands, weighted for QUALITY (defaults: talk 1, lead set
-- 5, lead confirmed 10, sit 25, sale 50 — the funnel the business needs),
-- with three compulsion loops on top:
--   · COMBO    — consecutive conversations within a window earn escalating
--                bonus points (canvasser_combo_state tracks the chain).
--   · CRIT     — a rare random multiplier on a conversation (the slot
--                machine; generalizes maybe_mystery_drop, which this
--                migration retires while the flag is on).
--   · SUPER    — the first time a day's points cross the daily target, a
--                bonus lands and the feed shouts it.
-- Bounties finally honor their category ('sit' / 'sale' / 'doors' / new
-- 'leads') as write-time multipliers, recorded in meta.bounty.
--
-- DORMANT until the owner flips arcade_flags.score_v2 (feed_push precedent):
-- no trigger writes a row while it's off, and maybe_mystery_drop keeps
-- running until the flip so the prize layer never gaps.
--
-- GAME ONLY — pay reads daily_logs.demos_sits + sales and NOTHING here.
-- Totals are always computed from the ledger, never stored. Clients never
-- write the ledger (SECURITY DEFINER triggers + service role only).
-- Idempotent — safe to re-paste.
-- Apply via: supabase db query --linked --file supabase/migrations/20261103130000_canvasser_arcade.sql
-- Then flip when the client ships: UPDATE public.arcade_flags SET score_v2 = true;
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) The flag ──────────────────────────────────────────────────────────────
ALTER TABLE public.arcade_flags
  ADD COLUMN IF NOT EXISTS score_v2 boolean NOT NULL DEFAULT false;

-- ── 2) arcade_rules: single-row jsonb config (contest_rules clone) ───────────
-- Merged over DEFAULT_ARCADE_RULES in src/lib/canvasser-arcade.ts; a missing
-- key never zeroes a weight. The owner tunes the whole economy live from
-- ArcadeRulesAdmin — no deploys.
CREATE TABLE IF NOT EXISTS public.arcade_rules (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.arcade_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Signed-in read arcade rules" ON public.arcade_rules;
CREATE POLICY "Signed-in read arcade rules" ON public.arcade_rules
  FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "Admins write arcade rules" ON public.arcade_rules;
CREATE POLICY "Admins write arcade rules" ON public.arcade_rules
  FOR ALL USING (
    public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
  ) WITH CHECK (
    public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff')
  );
GRANT SELECT, INSERT, UPDATE ON public.arcade_rules TO authenticated;
GRANT ALL ON public.arcade_rules TO service_role;
INSERT INTO public.arcade_rules (id, rules) VALUES (true, '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

-- Numeric rule lookup with a code-mirrored default (never trusts a bad cast).
CREATE OR REPLACE FUNCTION public.arcade_rule_num(_path text[], _default numeric)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE _v numeric;
BEGIN
  BEGIN
    SELECT (rules #>> _path)::numeric INTO _v FROM public.arcade_rules WHERE id;
  EXCEPTION WHEN OTHERS THEN
    _v := NULL;
  END;
  RETURN COALESCE(_v, _default);
END $$;

-- ── 3) The ledger ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.canvasser_arcade_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canvasser_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day date NOT NULL,
  category text NOT NULL CHECK (category IN
    ('talk','lead_set','lead_confirmed','sit','sale','super','finale')),
  points numeric NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_id, canvasser_id, category)
);
CREATE INDEX IF NOT EXISTS arcade_ledger_canvasser_day_idx
  ON public.canvasser_arcade_ledger (canvasser_id, day);
CREATE INDEX IF NOT EXISTS arcade_ledger_day_idx
  ON public.canvasser_arcade_ledger (day);

GRANT SELECT ON public.canvasser_arcade_ledger TO authenticated;
GRANT ALL ON public.canvasser_arcade_ledger TO service_role;
ALTER TABLE public.canvasser_arcade_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "arcade ledger read all auth" ON public.canvasser_arcade_ledger;
CREATE POLICY "arcade ledger read all auth"
  ON public.canvasser_arcade_ledger FOR SELECT TO authenticated USING (true);
-- No write policies: the definer triggers below and service role only.

-- Live delivery (ArcadeMoments listens filtered to self).
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.canvasser_arcade_ledger;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 4) Combo state ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.canvasser_combo_state (
  canvasser_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  day date NOT NULL,
  count int NOT NULL DEFAULT 0,
  best int NOT NULL DEFAULT 0,
  last_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.canvasser_combo_state TO authenticated;
GRANT ALL ON public.canvasser_combo_state TO service_role;
ALTER TABLE public.canvasser_combo_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "combo state read all auth" ON public.canvasser_combo_state;
CREATE POLICY "combo state read all auth"
  ON public.canvasser_combo_state FOR SELECT TO authenticated USING (true);

-- ── 5) Bounty categories finally score (incl. the new 'leads') ───────────────
ALTER TABLE public.bounties DROP CONSTRAINT IF EXISTS bounties_category_check;
ALTER TABLE public.bounties
  ADD CONSTRAINT bounties_category_check CHECK (category IN ('sit','sale','doors','leads'));

-- Best live multiplier for one category right now; 1 when none.
CREATE OR REPLACE FUNCTION public.arcade_bounty_mult(_cat text)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(MAX(multiplier), 1)
  FROM public.bounties
  WHERE category = _cat AND starts_at <= now() AND ends_at > now();
$$;

-- ── 6) The grant helper (ledger insert + SUPER crossing) ─────────────────────
CREATE OR REPLACE FUNCTION public.arcade_award(
  _cid uuid, _day date, _cat text, _pts numeric,
  _skind text, _sid text, _meta jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _today date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  _target numeric;
  _bonus numeric;
  _before numeric;
  _name text;
BEGIN
  IF _cid IS NULL OR _pts <= 0 THEN RETURN; END IF;
  SELECT COALESCE(sum(points), 0) INTO _before
  FROM public.canvasser_arcade_ledger
  WHERE canvasser_id = _cid AND day = _day;

  INSERT INTO public.canvasser_arcade_ledger
    (canvasser_id, day, category, points, source_kind, source_id, meta)
  VALUES (_cid, _day, _cat, _pts, _skind, _sid, COALESCE(_meta, '{}'::jsonb))
  ON CONFLICT (source_kind, source_id, canvasser_id, category) DO NOTHING;
  IF NOT FOUND THEN RETURN; END IF;

  -- SUPER: first crossing of today's target unleashes the bonus (goal
  -- gradient; the HUD meter fills toward exactly this number). Today only —
  -- backdated Monday credits shouldn't fire a day-old super.
  IF _day = _today THEN
    _target := public.arcade_rule_num(ARRAY['super','daily_target'], 40);
    _bonus := public.arcade_rule_num(ARRAY['super','bonus'], 15);
    IF _target > 0 AND _bonus > 0 AND _before < _target AND _before + _pts >= _target THEN
      INSERT INTO public.canvasser_arcade_ledger
        (canvasser_id, day, category, points, source_kind, source_id, meta)
      VALUES (_cid, _day, 'super', _bonus, 'super', _day::text, '{}'::jsonb)
      ON CONFLICT (source_kind, source_id, canvasser_id, category) DO NOTHING;
      IF FOUND THEN
        SELECT display_name INTO _name FROM public.profiles WHERE id = _cid;
        INSERT INTO public.feed_events (kind, actor_name, body, created_by)
        VALUES ('super', COALESCE(_name, 'A player'),
          '⚡ ' || COALESCE(_name, 'A player') || ' UNLEASHED A SUPER — daily target smashed (+'
          || _bonus || ' pts)', NULL);
      END IF;
    END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.arcade_award(uuid, date, text, numeric, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arcade_award(uuid, date, text, numeric, text, text, jsonb)
  TO service_role;

-- ── 7) score_knock: conversations → talk pts + COMBO + CRIT ──────────────────
CREATE OR REPLACE FUNCTION public.arcade_score_knock()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _on boolean;
  _today date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  _talk numeric;
  _combo_window numeric;
  _combo_cap numeric;
  _count int;
  _bonus numeric;
  _mult numeric;
  _pts numeric;
  _crit_chance numeric;
  _crit_mult numeric;
  _crit_cap numeric;
  _crit boolean := false;
  _crits_today int;
  _meta jsonb;
  _name text;
BEGIN
  SELECT score_v2 INTO _on FROM public.arcade_flags WHERE id = 1;
  IF _on IS NOT TRUE THEN RETURN NEW; END IF;
  -- Conversations only (the bump trigger's talk list), never remote drops,
  -- never replayed history — identical anti-farm guards to maybe_mystery_drop.
  IF NEW.pin_type NOT IN ('talked_to','renter','go_back','lead','not_interested','appt')
     OR COALESCE(NEW.is_remote_drop, false)
     OR NEW.log_date IS DISTINCT FROM _today THEN
    RETURN NEW;
  END IF;
  BEGIN
    _talk := public.arcade_rule_num(ARRAY['pts','talk'], 1);
    IF _talk <= 0 THEN RETURN NEW; END IF;
    _combo_window := public.arcade_rule_num(ARRAY['combo','window_min'], 20);
    _combo_cap := public.arcade_rule_num(ARRAY['combo','cap'], 3);

    -- COMBO: the chain lives server-side so it survives screen resets. A
    -- conversation within the window extends it; otherwise it restarts at 1.
    INSERT INTO public.canvasser_combo_state AS cs (canvasser_id, day, count, best, last_at)
    VALUES (NEW.canvasser_id, _today, 1, 1, now())
    ON CONFLICT (canvasser_id) DO UPDATE SET
      count = CASE
        WHEN cs.day = _today AND cs.last_at > now() - make_interval(mins => _combo_window::int)
          THEN cs.count + 1 ELSE 1 END,
      best = GREATEST(cs.best * (cs.day = _today)::int, CASE
        WHEN cs.day = _today AND cs.last_at > now() - make_interval(mins => _combo_window::int)
          THEN cs.count + 1 ELSE 1 END),
      day = _today,
      last_at = now()
    RETURNING cs.count INTO _count;

    _bonus := LEAST(GREATEST(_count - 1, 0), _combo_cap);
    _mult := public.arcade_bounty_mult('doors');
    _pts := (_talk + _bonus) * _mult;
    _meta := jsonb_build_object('combo', _count);
    IF _mult > 1 THEN _meta := _meta || jsonb_build_object('bounty', _mult); END IF;

    -- CRIT: the slot machine. Daily-capped, rolled server-side, shouted.
    _crit_chance := public.arcade_rule_num(ARRAY['crit','chance'], 0.08);
    _crit_mult := public.arcade_rule_num(ARRAY['crit','mult'], 5);
    _crit_cap := public.arcade_rule_num(ARRAY['crit','daily_cap'], 4);
    IF _crit_chance > 0 AND _crit_mult > 1 THEN
      SELECT count(*) INTO _crits_today FROM public.canvasser_arcade_ledger
      WHERE canvasser_id = NEW.canvasser_id AND day = _today
        AND (meta ->> 'crit')::boolean IS TRUE;
      IF _crits_today < _crit_cap AND random() < _crit_chance THEN
        _crit := true;
        _pts := _pts * _crit_mult;
        _meta := _meta || jsonb_build_object('crit', true);
      END IF;
    END IF;

    PERFORM public.arcade_award(
      NEW.canvasser_id, _today, 'talk', _pts, 'pin', NEW.id::text, _meta);

    IF _crit THEN
      SELECT display_name INTO _name FROM public.profiles WHERE id = NEW.canvasser_id;
      INSERT INTO public.feed_events (kind, actor_name, body, created_by)
      VALUES ('crit', COALESCE(_name, 'A player'),
        '💥 ' || COALESCE(_name, 'A player') || ' landed a CRITICAL HIT — +' || _pts || ' pts',
        NULL);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- scoring must never break the knock
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS field_pins_arcade_score ON public.field_pins;
CREATE TRIGGER field_pins_arcade_score
  AFTER INSERT ON public.field_pins
  FOR EACH ROW EXECUTE FUNCTION public.arcade_score_knock();

-- ── 8) Retire the mystery drop while v2 runs (crits replace it) ──────────────
-- Same function, one new gate: if score_v2 is on, the old +1 drop stays
-- silent so prizes don't double. Flipping the flag back off restores it.
CREATE OR REPLACE FUNCTION public.maybe_mystery_drop()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _today date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  _name text;
  _v2 boolean;
BEGIN
  SELECT score_v2 INTO _v2 FROM public.arcade_flags WHERE id = 1;
  IF _v2 IS TRUE THEN RETURN NEW; END IF;
  IF NEW.pin_type NOT IN ('talked_to','renter','go_back','lead','not_interested','appt')
     OR COALESCE(NEW.is_remote_drop, false)
     OR NEW.log_date IS DISTINCT FROM _today THEN
    RETURN NEW;
  END IF;
  BEGIN
    IF (SELECT count(*) FROM public.arcade_drops
        WHERE canvasser_id = NEW.canvasser_id
          AND (created_at AT TIME ZONE 'America/Los_Angeles')::date = _today) >= 2 THEN
      RETURN NEW;
    END IF;
    IF random() >= 0.04 THEN RETURN NEW; END IF;

    INSERT INTO public.arcade_drops (canvasser_id, points, pin_id)
    VALUES (NEW.canvasser_id, 1, NEW.id);

    SELECT display_name INTO _name FROM public.profiles WHERE id = NEW.canvasser_id;
    INSERT INTO public.feed_events (kind, actor_name, body, created_by)
    VALUES (
      'mystery',
      COALESCE(_name, 'A player'),
      '🎁 ' || COALESCE(_name, 'A player') || ' hit a MYSTERY DROP — +1 arcade pt',
      NULL
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END $$;

-- ── 9) score_lead_set: the lead hits the board ───────────────────────────────
-- daily_logs.leads_called_in only ever increments via applyLeadCredit (once
-- per Monday card), so a count-level source_id is naturally idempotent.
CREATE OR REPLACE FUNCTION public.arcade_score_lead_set()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _on boolean;
  _delta int;
  _pts numeric;
  _mult numeric;
  _meta jsonb := '{}'::jsonb;
BEGIN
  SELECT score_v2 INTO _on FROM public.arcade_flags WHERE id = 1;
  IF _on IS NOT TRUE THEN RETURN NEW; END IF;
  IF NEW.canvasser_id IS NULL THEN RETURN NEW; END IF;
  _delta := COALESCE(NEW.leads_called_in, 0)
    - COALESCE(CASE WHEN TG_OP = 'UPDATE' THEN OLD.leads_called_in ELSE 0 END, 0);
  IF _delta <= 0 THEN RETURN NEW; END IF;
  BEGIN
    IF public.is_pseudo_source_name(
         (SELECT display_name FROM public.profiles WHERE id = NEW.canvasser_id)) THEN
      RETURN NEW;
    END IF;
    _pts := public.arcade_rule_num(ARRAY['pts','lead_set'], 5) * _delta;
    _mult := public.arcade_bounty_mult('leads');
    IF _mult > 1 THEN
      _pts := _pts * _mult;
      _meta := jsonb_build_object('bounty', _mult);
    END IF;
    PERFORM public.arcade_award(
      NEW.canvasser_id, NEW.log_date, 'lead_set', _pts,
      'log_leads', NEW.id::text || ':' || NEW.leads_called_in, _meta);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS daily_logs_arcade_lead_set ON public.daily_logs;
CREATE TRIGGER daily_logs_arcade_lead_set
  AFTER INSERT OR UPDATE OF leads_called_in ON public.daily_logs
  FOR EACH ROW EXECUTE FUNCTION public.arcade_score_lead_set();

-- ── 10) score_lead_confirmed: the office locks it in ─────────────────────────
CREATE OR REPLACE FUNCTION public.arcade_score_lead_confirmed()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _on boolean;
  _delta int;
  _pts numeric;
  _mult numeric;
  _meta jsonb := '{}'::jsonb;
BEGIN
  SELECT score_v2 INTO _on FROM public.arcade_flags WHERE id = 1;
  IF _on IS NOT TRUE THEN RETURN NEW; END IF;
  IF NEW.canvasser_id IS NULL THEN RETURN NEW; END IF;
  _delta := COALESCE(NEW.leads_confirmed, 0)
    - COALESCE(CASE WHEN TG_OP = 'UPDATE' THEN OLD.leads_confirmed ELSE 0 END, 0);
  IF _delta <= 0 THEN RETURN NEW; END IF;
  BEGIN
    IF public.is_pseudo_source_name(
         (SELECT display_name FROM public.profiles WHERE id = NEW.canvasser_id)) THEN
      RETURN NEW;
    END IF;
    _pts := public.arcade_rule_num(ARRAY['pts','lead_confirmed'], 10) * _delta;
    _mult := public.arcade_bounty_mult('leads');
    IF _mult > 1 THEN
      _pts := _pts * _mult;
      _meta := jsonb_build_object('bounty', _mult);
    END IF;
    PERFORM public.arcade_award(
      NEW.canvasser_id, NEW.metric_date, 'lead_confirmed', _pts,
      'metrics_confirm', NEW.id::text || ':' || NEW.leads_confirmed, _meta);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS daily_metrics_arcade_confirm ON public.daily_metrics;
CREATE TRIGGER daily_metrics_arcade_confirm
  AFTER INSERT OR UPDATE OF leads_confirmed ON public.daily_metrics
  FOR EACH ROW EXECUTE FUNCTION public.arcade_score_lead_confirmed();

-- ── 11) score_outcome: SIT (the K.O.) and SALE (flawless victory) ────────────
-- Count-level source ids bound Desk-Log self-typing to the same exposure the
-- pay engine already accepts (one grant per count level per log row).
CREATE OR REPLACE FUNCTION public.arcade_score_outcome()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _on boolean;
  _sit_delta int;
  _sale_delta int;
  _pts numeric;
  _mult numeric;
  _meta jsonb;
BEGIN
  SELECT score_v2 INTO _on FROM public.arcade_flags WHERE id = 1;
  IF _on IS NOT TRUE THEN RETURN NEW; END IF;
  IF NEW.canvasser_id IS NULL THEN RETURN NEW; END IF;
  _sit_delta := COALESCE(NEW.demos_sits, 0)
    - COALESCE(CASE WHEN TG_OP = 'UPDATE' THEN OLD.demos_sits ELSE 0 END, 0);
  _sale_delta := COALESCE(NEW.sales, 0)
    - COALESCE(CASE WHEN TG_OP = 'UPDATE' THEN OLD.sales ELSE 0 END, 0);
  IF _sit_delta <= 0 AND _sale_delta <= 0 THEN RETURN NEW; END IF;
  BEGIN
    IF public.is_pseudo_source_name(
         (SELECT display_name FROM public.profiles WHERE id = NEW.canvasser_id)) THEN
      RETURN NEW;
    END IF;
    IF _sit_delta > 0 THEN
      _pts := public.arcade_rule_num(ARRAY['pts','sit'], 25) * _sit_delta;
      _mult := public.arcade_bounty_mult('sit');
      _meta := CASE WHEN _mult > 1 THEN jsonb_build_object('bounty', _mult) ELSE '{}'::jsonb END;
      PERFORM public.arcade_award(
        NEW.canvasser_id, NEW.log_date, 'sit', _pts * _mult,
        'log_sits', NEW.id::text || ':' || NEW.demos_sits, _meta);
    END IF;
    IF _sale_delta > 0 THEN
      _pts := public.arcade_rule_num(ARRAY['pts','sale'], 50) * _sale_delta;
      _mult := public.arcade_bounty_mult('sale');
      _meta := CASE WHEN _mult > 1 THEN jsonb_build_object('bounty', _mult) ELSE '{}'::jsonb END;
      PERFORM public.arcade_award(
        NEW.canvasser_id, NEW.log_date, 'sale', _pts * _mult,
        'log_sales', NEW.id::text || ':' || NEW.sales, _meta);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS daily_logs_arcade_outcome ON public.daily_logs;
CREATE TRIGGER daily_logs_arcade_outcome
  AFTER INSERT OR UPDATE OF demos_sits, sales ON public.daily_logs
  FOR EACH ROW EXECUTE FUNCTION public.arcade_score_outcome();
