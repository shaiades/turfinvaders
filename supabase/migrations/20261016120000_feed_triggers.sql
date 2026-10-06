-- ═══════════════════════════════════════════════════════════════════════════
-- ARCADE §7 — granular Street Feed. Stream confirmed leads ("sits") and sales
-- from the leads table into feed_events, so the feed carries live per-event
-- moments (not just shoutouts/crownings).
--
-- SAFETY (this touches the production ingestion table):
--   · DORMANT behind arcade_flags.feed_live (default FALSE) — the trigger is a
--     single cheap flag-read + RETURN until the owner flips it on and watches.
--   · AFTER trigger — it runs after the leads write, never blocking it.
--   · EXCEPTION-SAFE — any error inside is swallowed (RETURN NULL), so a bad
--     feed insert can NEVER roll back or break the lead write.
--   · SECURITY DEFINER — the system-written feed rows bypass the leaders-only
--     RLS insert policy (created_by is left NULL for system events).
--
-- To activate (owner, when ready to watch): UPDATE public.arcade_flags SET feed_live = true;
-- Idempotent. Apply via:
--   supabase db query --linked --file supabase/migrations/20261016120000_feed_triggers.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.arcade_flags
  ADD COLUMN IF NOT EXISTS feed_live boolean NOT NULL DEFAULT false;

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

  SELECT p.display_name, t.color
    INTO _name, _color
  FROM public.profiles p
  LEFT JOIN public.teams t ON t.id = NEW.team_id
  WHERE p.id = NEW.canvasser_id;

  IF _name IS NULL OR btrim(_name) = '' THEN
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

DROP TRIGGER IF EXISTS arcade_feed_lead_trg ON public.leads;
CREATE TRIGGER arcade_feed_lead_trg
  AFTER INSERT OR UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.arcade_feed_on_lead();
