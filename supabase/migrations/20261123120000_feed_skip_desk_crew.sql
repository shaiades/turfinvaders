-- ═══════════════════════════════════════════════════════════════════════════
-- Street Feed: skip Confirmation-desk moments (owner, 2026-11-23).
--
-- Since Dial Run went live the desk (Confirmation van) books real sits, and
-- the feed trigger was broadcasting "booked a sit ✅" for them to every
-- canvasser. Canvassers should only see canvasser results — same rule PR #445
-- applies to the leaderboard/standings via isDeskCrew (src/lib/vanwars.ts):
-- any team whose name matches /confirm/i is the desk, on either axis (the
-- canvasser's profile team, or the team the lead row is stamped with).
--
-- Same safety posture as 20261016120000_feed_triggers.sql: flag-gated AFTER
-- trigger, exception-swallowing, SECURITY DEFINER. This only re-CREATEs the
-- function body; the trigger itself is untouched.
--
-- Idempotent. Apply via:
--   supabase db query --linked --file supabase/migrations/20261123120000_feed_skip_desk_crew.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.arcade_feed_on_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _live boolean;
  _name text;
  _color text;
  _desk boolean;
  _kind text;
  _body text;
BEGIN
  -- Flag gate — one indexed read; off = no-op (the default).
  SELECT feed_live INTO _live FROM public.arcade_flags WHERE id = 1;
  IF _live IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  -- Which transition is this? A brand-new sale, or a lead reaching confirmed.
  IF NEW.is_sale = true AND NEW.sale_cancelled_at IS NULL
     AND (TG_OP = 'INSERT' OR COALESCE(OLD.is_sale, false) = false) THEN
    _kind := 'sale';
  ELSIF NEW.status = 'confirmed'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'confirmed') THEN
    _kind := 'sit';
  ELSE
    RETURN NULL;  -- not a feed-worthy change
  END IF;

  SELECT p.display_name,
         lt.color,
         (COALESCE(pt.name, '') ~* 'confirm' OR COALESCE(lt.name, '') ~* 'confirm')
    INTO _name, _color, _desk
  FROM public.profiles p
  LEFT JOIN public.teams pt ON pt.id = p.team_id
  LEFT JOIN public.teams lt ON lt.id = NEW.team_id
  WHERE p.id = NEW.canvasser_id;

  IF _name IS NULL OR btrim(_name) = '' THEN
    RETURN NULL;
  END IF;

  -- Desk crew (Confirmation van): office results, never a feed moment.
  IF _desk THEN
    RETURN NULL;
  END IF;

  -- Skip lead-source channel profiles (Job Walk / Rehash … ) — office credit,
  -- not a field rep. Keep this list in sync with src/lib/lead-sources.ts.
  IF lower(btrim(_name)) IN (
    'self gen', 'job walk', 'reload', 'upsell',
    'rehash / cynthia king', 'referral', 'ryan appointinator'
  ) THEN
    RETURN NULL;
  END IF;

  IF _kind = 'sale' THEN
    _body := _name || ' CLOSED a deal 💰';
  ELSE
    _body := _name || ' booked a sit ✅';
  END IF;

  INSERT INTO public.feed_events (kind, actor_name, color, body, created_by)
  VALUES (_kind, _name, _color, _body, NULL);

  RETURN NULL;
EXCEPTION
  WHEN OTHERS THEN
    -- The feed is garnish — a failure here must never touch the lead write.
    RETURN NULL;
END;
$$;
