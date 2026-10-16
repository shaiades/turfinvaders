-- ═══════════════════════════════════════════════════════════════════════════
-- MONEY GAME (conversion audit 2026-10-15, Phase 4 §4 + §7) — two server-side
-- pieces the client can't be trusted to roll or watch for itself:
--
--   A. MYSTERY DROPS — a rare random reward on real CONVERSATIONS (the bump
--      trigger's talk types; never not_home, never remote drops, so it can't
--      be farmed by ghost-pinning a street). The dice roll server-side inside
--      an AFTER-INSERT trigger on field_pins: ~4% per conversation, max 2 a
--      day. A hit writes arcade_drops (+1 ARCADE point — the ladder sums it
--      like dojo points; pay never sees it) and a Street-Feed 'mystery'
--      shout. The client just celebrates what the server already decided.
--
--   B. MONEY PUSHES — the five Phase 4 §7 pushes, all SQL-triggered off the
--      tables where the money actually lands, sent through the new
--      notify-money edge function (deploy it with this migration):
--        lead_confirmed  Monday Lead Status → daily_metrics.leads_confirmed
--                        bump, AND leads.status → 'confirmed' (Desk path)
--        lead_sold       leads.is_sale lands confirmed with an amount
--        volume_near     month volume crosses within $10K of the next $100K
--        tier_near       week points hit 2 or 6 (one sit from $30/$35) —
--                        rate-locked ranks skip (no next tier)
--        passed_today    someone's Today lead count just passed yours
--      Gating: arcade_flags.feed_push must be ON, and each canvasser gets at
--      most feed_push_daily_cap money pushes per LA day (the owner's one cap
--      knob, applied PER PERSON here — personal nudges, unlike the global
--      broadcast cap notify-feed keeps). money_push_log dedupes each moment
--      exactly once (one passed_today per day, one tier_near per week+tier,
--      one volume_near per month+step).
--
-- GAME + MESSAGING ONLY — nothing here touches pay or production counters.
-- Idempotent — safe to re-paste.
-- Apply via: supabase db query --linked --file supabase/migrations/20261029120000_money_game.sql
-- Then deploy: supabase functions deploy notify-money --no-verify-jwt
-- ═══════════════════════════════════════════════════════════════════════════

-- ── A1) arcade_drops ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.arcade_drops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canvasser_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  points numeric NOT NULL DEFAULT 1,
  pin_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS arcade_drops_canvasser_idx
  ON public.arcade_drops (canvasser_id, created_at DESC);

GRANT SELECT ON public.arcade_drops TO authenticated;
GRANT ALL ON public.arcade_drops TO service_role;
ALTER TABLE public.arcade_drops ENABLE ROW LEVEL SECURITY;

-- Everyone may see drops (they're shouted on the feed anyway); only the
-- trigger below writes them.
DROP POLICY IF EXISTS "arcade_drops read" ON public.arcade_drops;
CREATE POLICY "arcade_drops read"
  ON public.arcade_drops FOR SELECT TO authenticated USING (true);

-- ── A2) The dice ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.maybe_mystery_drop()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _today date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  _name text;
BEGIN
  -- Conversations only (the bump trigger's talk list), never remote drops,
  -- never replayed history (an offline knock from yesterday still counts for
  -- stats — it just can't win a prize after the fact).
  IF NEW.pin_type NOT IN ('talked_to','renter','go_back','lead','not_interested','appt')
     OR COALESCE(NEW.is_remote_drop, false)
     OR NEW.log_date IS DISTINCT FROM _today THEN
    RETURN NEW;
  END IF;
  BEGIN
    -- Daily cap first (cheap), then the roll.
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
    NULL; -- a prize hiccup must never break the knock
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS field_pins_mystery_drop ON public.field_pins;
CREATE TRIGGER field_pins_mystery_drop
  AFTER INSERT ON public.field_pins
  FOR EACH ROW EXECUTE FUNCTION public.maybe_mystery_drop();

-- ── B1) money_push_log + the sender ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.money_push_log (
  user_id uuid NOT NULL,
  kind text NOT NULL,
  dedupe_key text NOT NULL,
  pushed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, dedupe_key)
);
CREATE INDEX IF NOT EXISTS money_push_log_day_idx ON public.money_push_log (user_id, pushed_at DESC);
ALTER TABLE public.money_push_log ENABLE ROW LEVEL SECURITY; -- definer/service only

CREATE OR REPLACE FUNCTION public.money_push(
  _user uuid, _kind text, _dedupe text, _title text, _body text, _url text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _on boolean;
  _cap int;
  _today date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  _sent_today int;
  _secret text;
BEGIN
  IF _user IS NULL THEN RETURN; END IF;
  SELECT feed_push, feed_push_daily_cap INTO _on, _cap FROM public.arcade_flags WHERE id = 1;
  IF _on IS NOT TRUE THEN RETURN; END IF;

  -- Per-person daily cap (the owner's one knob, applied per canvasser for
  -- these personal nudges).
  SELECT count(*) INTO _sent_today FROM public.money_push_log
  WHERE user_id = _user AND (pushed_at AT TIME ZONE 'America/Los_Angeles')::date = _today;
  IF _sent_today >= COALESCE(_cap, 5) THEN RETURN; END IF;

  -- Exactly-once claim for this moment.
  INSERT INTO public.money_push_log (user_id, kind, dedupe_key)
  VALUES (_user, _kind, _dedupe)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN; END IF;

  BEGIN
    SELECT decrypted_secret INTO _secret
    FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
    IF _secret IS NULL THEN RETURN; END IF;
    PERFORM net.http_post(
      url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/notify-money',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-notify-secret', _secret
      ),
      body := jsonb_build_object(
        'user_id', _user, 'title', _title, 'body', _body,
        'url', _url, 'tag', _kind || '-' || _dedupe
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- push delivery is best-effort, the claim row stands
  END;
END $$;
REVOKE ALL ON FUNCTION public.money_push(uuid, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.money_push(uuid, text, text, text, text, text) TO service_role;

-- ── B2) leads: confirmed / sold / volume-near ────────────────────────────────
CREATE OR REPLACE FUNCTION public.money_push_on_lead()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _month_start date := date_trunc('month', (now() AT TIME ZONE 'America/Los_Angeles'))::date;
  _vol numeric;
  _to_next numeric;
  _step int;
  _sold boolean;
  _confirmed boolean;
BEGIN
  IF NEW.canvasser_id IS NULL THEN RETURN NEW; END IF;
  IF public.is_pseudo_source_name(
       (SELECT display_name FROM public.profiles WHERE id = NEW.canvasser_id)) THEN
    RETURN NEW; -- channel credit, not a person
  END IF;

  _sold := NEW.status = 'confirmed' AND COALESCE(NEW.is_sale, false)
    AND COALESCE(NEW.sale_amount, 0) > 0
    AND (TG_OP = 'INSERT'
         OR OLD.status IS DISTINCT FROM 'confirmed'
         OR COALESCE(OLD.is_sale, false) IS DISTINCT FROM true
         OR COALESCE(OLD.sale_amount, 0) <= 0);
  _confirmed := NOT _sold AND NEW.status = 'confirmed'
    AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'confirmed');

  IF _sold THEN
    PERFORM public.money_push(
      NEW.canvasser_id, 'lead_sold', COALESCE(NEW.monday_item_id, NEW.id::text),
      '💰 YOUR lead just SOLD',
      '$' || to_char(COALESCE(NEW.sale_amount, 0), 'FM999,999,999') ||
        ' on the board — commission is coming.',
      '/leaderboard'
    );
    -- Volume chase: inside $10K of the next $100K chest? Same month axis as
    -- calc_monthly_paycheck (confirmed, non-cancelled, LA month on
    -- COALESCE(reviewed_at, created_at)).
    SELECT COALESCE(sum(sale_amount), 0) INTO _vol
    FROM public.leads
    WHERE canvasser_id = NEW.canvasser_id
      AND status = 'confirmed' AND sale_cancelled_at IS NULL
      AND (COALESCE(reviewed_at, created_at) AT TIME ZONE 'America/Los_Angeles')::date
          >= _month_start
      AND (COALESCE(reviewed_at, created_at) AT TIME ZONE 'America/Los_Angeles')::date
          < (_month_start + interval '1 month')::date;
    IF _vol > 0 THEN
      _to_next := 100000 - (_vol::numeric % 100000);
      _step := FLOOR(_vol / 100000)::int + 1;
      IF _to_next <= 10000 AND _to_next > 0 THEN
        PERFORM public.money_push(
          NEW.canvasser_id, 'volume_near',
          to_char(_month_start, 'YYYY-MM') || '-' || _step,
          '💸 ' || '$' || to_char(ceil(_to_next / 1000), 'FM999') || 'K from $1,500',
          'One big roof puts the next $1,500 bonus in your pocket this month.',
          '/leaderboard'
        );
      END IF;
    END IF;
  ELSIF _confirmed THEN
    PERFORM public.money_push(
      NEW.canvasser_id, 'lead_confirmed', NEW.id::text,
      '✅ Lead confirmed',
      'The office locked it in — it counts. Next door.',
      '/field'
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS leads_money_push ON public.leads;
CREATE TRIGGER leads_money_push
  AFTER INSERT OR UPDATE OF status, is_sale, sale_amount ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.money_push_on_lead();

-- ── B3) daily_metrics: the Monday "Confirmed" status path ───────────────────
-- (A Monday Lead Status flip never touches `leads` — it lands as a
-- daily_metrics.leads_confirmed bump via claim_lead_status_transition.)
CREATE OR REPLACE FUNCTION public.money_push_on_metrics()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.canvasser_id IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(NEW.leads_confirmed, 0) >
     COALESCE(CASE WHEN TG_OP = 'UPDATE' THEN OLD.leads_confirmed ELSE 0 END, 0) THEN
    PERFORM public.money_push(
      NEW.canvasser_id, 'lead_confirmed',
      NEW.metric_date::text || '-' || NEW.leads_confirmed,
      '✅ Lead confirmed',
      'The office locked it in — it counts. Next door.',
      '/field'
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS daily_metrics_money_push ON public.daily_metrics;
CREATE TRIGGER daily_metrics_money_push
  AFTER INSERT OR UPDATE OF leads_confirmed ON public.daily_metrics
  FOR EACH ROW EXECUTE FUNCTION public.money_push_on_metrics();

-- ── B4) daily_logs: tier-near + passed-on-Today ──────────────────────────────
CREATE OR REPLACE FUNCTION public.money_push_on_log()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _today date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  _week_start date := date_trunc('week', (now() AT TIME ZONE 'America/Los_Angeles'))::date;
  _old_sits int := COALESCE(CASE WHEN TG_OP = 'UPDATE' THEN OLD.demos_sits ELSE 0 END, 0);
  _old_leads int := COALESCE(CASE WHEN TG_OP = 'UPDATE' THEN OLD.leads_called_in ELSE 0 END, 0);
  _pts int;
  _rank text;
  _lock text;
  _n int;
  _name text;
  _rival record;
BEGIN
  IF NEW.canvasser_id IS NULL THEN RETURN NEW; END IF;

  -- One sit from the next hourly tier (points 2 → $30/hr, 6 → $35/hr; a sit
  -- is exactly one point). Rate-locked ranks have no next tier.
  IF COALESCE(NEW.demos_sits, 0) > _old_sits THEN
    SELECT current_rank, pay_lock_status INTO _rank, _lock
    FROM public.profiles WHERE id = NEW.canvasser_id;
    IF NOT (_rank IN ('Jr. Diamond', 'Sr. Diamond', 'Captain')
            AND COALESCE(_lock, '') <> 'reverted') THEN
      SELECT COALESCE(sum(demos_sits + sales), 0) INTO _pts
      FROM public.daily_logs
      WHERE canvasser_id = NEW.canvasser_id
        AND log_date >= _week_start AND log_date < _week_start + 7;
      IF _pts = 2 THEN
        PERFORM public.money_push(
          NEW.canvasser_id, 'tier_near', _week_start::text || '-30',
          '⚡ ONE sit from $30/hr',
          'One more sit this week bumps every clocked hour to $30.',
          '/field');
      ELSIF _pts = 6 THEN
        PERFORM public.money_push(
          NEW.canvasser_id, 'tier_near', _week_start::text || '-35',
          '⚡ ONE sit from $35/hr',
          'One more sit this week bumps every clocked hour to $35 — and 2% commission.',
          '/field');
      END IF;
    END IF;
  END IF;

  -- Passed on Today: your rival just matched-and-passed your lead count.
  -- Everyone sitting exactly one lead behind the new total (and on the
  -- board) hears about it — once per day each.
  IF COALESCE(NEW.leads_called_in, 0) > _old_leads AND NEW.log_date = _today THEN
    SELECT COALESCE(sum(leads_called_in), 0) INTO _n
    FROM public.daily_logs
    WHERE canvasser_id = NEW.canvasser_id AND log_date = _today;
    IF _n >= 2 THEN
      SELECT display_name INTO _name FROM public.profiles WHERE id = NEW.canvasser_id;
      FOR _rival IN
        SELECT canvasser_id
        FROM public.daily_logs
        WHERE log_date = _today AND canvasser_id <> NEW.canvasser_id
        GROUP BY canvasser_id
        HAVING COALESCE(sum(leads_called_in), 0) = _n - 1
        LIMIT 12
      LOOP
        PERFORM public.money_push(
          _rival.canvasser_id, 'passed_today', _today::text,
          '😤 You just got passed on Today',
          COALESCE(_name, 'Someone') || ' hit ' || _n || ' leads. Take it back.',
          '/leaderboard');
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS daily_logs_money_push ON public.daily_logs;
CREATE TRIGGER daily_logs_money_push
  AFTER INSERT OR UPDATE OF demos_sits, leads_called_in ON public.daily_logs
  FOR EACH ROW EXECUTE FUNCTION public.money_push_on_log();
