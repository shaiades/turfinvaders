-- ═══════════════════════════════════════════════════════════════════════════
-- CONFIRMER CALL LOGS — the phone room's tally ledger (owner mandate
-- 2026-10-19: "we will count their dials as knocks, and use the same vocab").
--
-- The confirmation department tele-markets. Dial Run (the confirmer's
-- no-map Active Run) writes one call_logs row per dial, and a trigger bumps
-- the SAME daily_logs counters the pin trigger bumps — dial = doors_knocked,
-- conversation = people_talked_to — so every existing board (leaderboard,
-- Fleet Dispatch, Mission, wrap, piggy) shows phone production with zero
-- changes and one shared vocabulary.
--
-- Deliberate choices, mirroring the field_pins pipeline:
--   • disposition reuses public.pin_type (vocabulary parity is structural):
--       knock = bare dial · not_home = no answer · talked_to · not_interested
--       go_back = callback · lead.  renter/appt are door-only — CHECKed out.
--   • A 'lead' call does NOT bump leads_called_in — the Monday card credit
--     is the single leads ledger (same doctrine as lead pins since
--     20260914260000; confirmer Rehash/Room credit already flows through the
--     webhook's confirmer-credit path).
--   • Same-day correction fence + column-limited UPDATE, exactly like the
--     pin fence (20260824150000): clients may flip disposition/note on
--     TODAY's calls only; ownership and dates stay server-owned.
--   • Mystery drops roll on phone conversations too (sibling of
--     maybe_mystery_drop, 20261029120000) — same arcade_drops table, same
--     shared 2/day cap, so the phone room plays the same money game.
--
-- GAME + PRODUCTION COUNTERS ONLY — nothing here touches pay (verified:
-- pay.ts / paychecks.ts / calc_weekly_paycheck never read doors_knocked).
-- Idempotent — safe to re-paste.
-- Apply via: supabase db query --linked --file supabase/migrations/20261101120000_confirmer_call_logs.sql
-- Then deploy: supabase functions deploy monday-live-dispatch --no-verify-jwt
--   (the webhook's Monday "Log Call" → dial credit needs both this table and
--    the new function build; apply the SQL FIRST or the credit 502s + retries)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0) Monday auto-dial kill switch ──────────────────────────────────────────
-- The webhook (monday-live-dispatch) also counts a Monday "Log Call" column
-- change as a dial for the confirmer who clicked it (owner 2026-10-19), so
-- the phone room never tallies twice. ON by default; flip false to stop
-- crediting without redeploying the function.
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS confirmer_dial_credit boolean NOT NULL DEFAULT true;

-- ── 1) The table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_logs (
  -- Client-generated ids allowed (pin-queue precedent: idempotent replay).
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canvasser_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  disposition public.pin_type NOT NULL
    CHECK (disposition IN ('knock','not_home','talked_to','not_interested','go_back','lead')),
  log_date date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Los_Angeles')::date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_logs_canvasser_date_idx
  ON public.call_logs (canvasser_id, log_date DESC);

-- ── 2) The bump trigger ──────────────────────────────────────────────────────
-- A deliberate COPY of bump_daily_log_from_pin (20260914260000) minus the
-- is_remote_drop branches (every call is valid) and the renter bucket (CHECKed
-- out above). Kept separate on purpose: the pin function is payroll-adjacent
-- and battle-hardened — never generalize the two into one.
CREATE OR REPLACE FUNCTION public.bump_daily_log_from_call()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _team uuid;
  _office text;
  _canvasser uuid;
  _log_date date;
  _old_doors int := 0; _old_talked int := 0; _old_ni int := 0; _old_nh int := 0;
  _new_doors int := 0; _new_talked int := 0; _new_ni int := 0; _new_nh int := 0;
  _d_doors int; _d_talked int; _d_ni int; _d_nh int;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    _old_doors  := 1; -- every call IS a dial, and a dial IS a knock
    _old_talked := CASE WHEN OLD.disposition IN ('talked_to','go_back','lead','not_interested') THEN 1 ELSE 0 END;
    _old_ni     := CASE WHEN OLD.disposition = 'not_interested' THEN 1 ELSE 0 END;
    _old_nh     := CASE WHEN OLD.disposition = 'not_home' THEN 1 ELSE 0 END;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    _new_doors  := 1;
    _new_talked := CASE WHEN NEW.disposition IN ('talked_to','go_back','lead','not_interested') THEN 1 ELSE 0 END;
    _new_ni     := CASE WHEN NEW.disposition = 'not_interested' THEN 1 ELSE 0 END;
    _new_nh     := CASE WHEN NEW.disposition = 'not_home' THEN 1 ELSE 0 END;
  END IF;

  _d_doors  := _new_doors  - _old_doors;
  _d_talked := _new_talked - _old_talked;
  _d_ni     := _new_ni     - _old_ni;
  _d_nh     := _new_nh     - _old_nh;

  -- UPDATE OF fires even when SET writes the same value — no-op deltas exit here.
  IF _d_doors = 0 AND _d_talked = 0 AND _d_ni = 0 AND _d_nh = 0 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    _canvasser := OLD.canvasser_id; _log_date := OLD.log_date;
  ELSE
    _canvasser := NEW.canvasser_id; _log_date := NEW.log_date;
  END IF;

  -- Same office derivation as the pin trigger: the caller's CURRENT home
  -- office. Corrections are same-day (RLS fence below), so office churn
  -- between bump and correction is negligible — accepted asymmetry.
  SELECT team_id, COALESCE(office_location, 'San Diego')
    INTO _team, _office
  FROM public.profiles WHERE id = _canvasser;

  IF _d_doors > 0 OR _d_talked > 0 OR _d_ni > 0 OR _d_nh > 0 THEN
    -- At least one bucket increments (insert, or a mixed-sign disposition
    -- switch): upsert — creates the day row when missing, exactly like the
    -- pin path. Negative components clamp via GREATEST.
    INSERT INTO public.daily_logs (
      canvasser_id, team_id, log_date, office_location,
      doors_knocked, people_talked_to, not_interested, not_home
    )
    VALUES (
      _canvasser, _team, _log_date, COALESCE(_office, 'San Diego'),
      GREATEST(_d_doors, 0), GREATEST(_d_talked, 0), GREATEST(_d_ni, 0),
      GREATEST(_d_nh, 0)
    )
    ON CONFLICT (canvasser_id, log_date, office_location) DO UPDATE
      SET doors_knocked    = GREATEST(0, public.daily_logs.doors_knocked    + _d_doors),
          people_talked_to = GREATEST(0, public.daily_logs.people_talked_to + _d_talked),
          not_interested   = GREATEST(0, public.daily_logs.not_interested   + _d_ni),
          not_home         = GREATEST(0, public.daily_logs.not_home         + _d_nh),
          updated_at       = now();
  ELSE
    -- Pure decrement (delete / undo): only touch an existing row — never
    -- conjure a zero row for a day that has no log. Missing row = no-op.
    UPDATE public.daily_logs
      SET doors_knocked    = GREATEST(0, doors_knocked    + _d_doors),
          people_talked_to = GREATEST(0, people_talked_to + _d_talked),
          not_interested   = GREATEST(0, not_interested   + _d_ni),
          not_home         = GREATEST(0, not_home         + _d_nh),
          updated_at       = now()
    WHERE canvasser_id = _canvasser
      AND log_date = _log_date
      AND office_location = COALESCE(_office, 'San Diego');
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $function$;

DROP TRIGGER IF EXISTS call_logs_bump_log ON public.call_logs;
CREATE TRIGGER call_logs_bump_log
  AFTER INSERT OR DELETE OR UPDATE OF disposition
  ON public.call_logs
  FOR EACH ROW EXECUTE FUNCTION public.bump_daily_log_from_call();

-- ── 3) Mystery drops on phone conversations ──────────────────────────────────
-- Sibling of maybe_mystery_drop (20261029120000): ~4% per conversation, and
-- the 2/day cap is SHARED across knocks and dials (one arcade_drops count),
-- so holding both channels can't double a player's prize ceiling.
CREATE OR REPLACE FUNCTION public.maybe_mystery_drop_call()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _today date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  _name text;
BEGIN
  -- Conversations only, never replayed history (a backdated row still counts
  -- for stats — it just can't win a prize after the fact).
  IF NEW.disposition NOT IN ('talked_to','go_back','lead','not_interested')
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
    NULL; -- a prize hiccup must never break the call
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS call_logs_mystery_drop ON public.call_logs;
CREATE TRIGGER call_logs_mystery_drop
  AFTER INSERT ON public.call_logs
  FOR EACH ROW EXECUTE FUNCTION public.maybe_mystery_drop_call();

-- ── 4) RLS — the pin correction fence, verbatim (20260824150000) ─────────────
ALTER TABLE public.call_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Confirmers read their calls" ON public.call_logs;
CREATE POLICY "Confirmers read their calls"
  ON public.call_logs FOR SELECT TO authenticated
  USING (canvasser_id = auth.uid());

DROP POLICY IF EXISTS "Confirmers insert their calls" ON public.call_logs;
CREATE POLICY "Confirmers insert their calls"
  ON public.call_logs FOR INSERT TO authenticated
  WITH CHECK (canvasser_id = auth.uid());

DROP POLICY IF EXISTS "Confirmers correct today's calls" ON public.call_logs;
CREATE POLICY "Confirmers correct today's calls"
  ON public.call_logs FOR UPDATE TO authenticated
  USING (
    canvasser_id = auth.uid()
    AND log_date = (now() AT TIME ZONE 'America/Los_Angeles')::date
  )
  WITH CHECK (
    canvasser_id = auth.uid()
    AND log_date = (now() AT TIME ZONE 'America/Los_Angeles')::date
  );

DROP POLICY IF EXISTS "Confirmers delete today's calls" ON public.call_logs;
CREATE POLICY "Confirmers delete today's calls"
  ON public.call_logs FOR DELETE TO authenticated
  USING (
    canvasser_id = auth.uid()
    AND log_date = (now() AT TIME ZONE 'America/Los_Angeles')::date
  );

-- Managers read everyone's calls (same read tiers as field_pins).
DROP POLICY IF EXISTS "Admins view all calls" ON public.call_logs;
CREATE POLICY "Admins view all calls"
  ON public.call_logs FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR public.has_role(auth.uid(), 'captain'::app_role)
  );

GRANT SELECT, INSERT, DELETE ON public.call_logs TO authenticated;
-- Clients may only change the call result (and a future note) — never the
-- ownership or date.
REVOKE UPDATE ON public.call_logs FROM authenticated;
GRANT UPDATE (disposition, note) ON public.call_logs TO authenticated;
GRANT ALL ON public.call_logs TO service_role;

-- ── Smoke test (run by hand in the SQL editor; rolls itself back) ────────────
-- BEGIN;
--   -- pick any canvasser-tier uid:
--   -- SELECT id, display_name FROM profiles LIMIT 5;
--   INSERT INTO call_logs (id, canvasser_id, disposition)
--   VALUES ('00000000-0000-4000-8000-00000000c411', '<uid>', 'knock');
--   SELECT doors_knocked, people_talked_to FROM daily_logs
--   WHERE canvasser_id = '<uid>' AND log_date = (now() AT TIME ZONE 'America/Los_Angeles')::date;
--   -- expect +1 doors, +0 talked
--   UPDATE call_logs SET disposition = 'talked_to'
--   WHERE id = '00000000-0000-4000-8000-00000000c411';
--   -- expect +1 doors, +1 talked
--   DELETE FROM call_logs WHERE id = '00000000-0000-4000-8000-00000000c411';
--   -- expect both back to baseline
-- ROLLBACK;
