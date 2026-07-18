-- Monday.com live Sale Price ingestion support.
--
-- 1) leads.monday_item_id: external reference to the Monday.com item (pulseId)
--    so the live webhook can idempotently upsert one lead per Monday item —
--    price corrections update the same row instead of creating duplicates.
--    Unique index enforces one lead per Monday item (NULLs are distinct, so
--    app/CSV-created leads without a Monday id are unaffected).
--
-- 2) Drop the auth.users FKs on leads and daily_logs: the live webhook
--    auto-provisions placeholder profiles (no auth.users row) for unknown
--    agent names, and their sale leads AND daily logs must be insertable.
--    Follows the 20260702175542 precedent (dropped the same FK on
--    profiles/user_roles). Deliberately NOT re-pointed at profiles(id):
--    ON DELETE CASCADE there would make a profile-row deletion destroy
--    historical revenue, and RESTRICT would break existing deletion flows.
--
-- 3) fire_lead_event_on_confirm inserts into lead_events(team_id NOT NULL);
--    a confirmed lead for a team-less canvasser (every auto-provisioned Free
--    Agent) would abort the whole lead INSERT. Guard the hype event instead —
--    the paycheck engine reads leads, not lead_events, so skipping the ticker
--    event for team-less agents loses nothing that matters.

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS monday_item_id text;

CREATE UNIQUE INDEX IF NOT EXISTS leads_monday_item_id_key
  ON public.leads (monday_item_id);

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_canvasser_id_fkey;
ALTER TABLE public.daily_logs DROP CONSTRAINT IF EXISTS daily_logs_canvasser_id_fkey;

CREATE OR REPLACE FUNCTION public.fire_lead_event_on_confirm()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'confirmed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'confirmed')
     AND NEW.team_id IS NOT NULL THEN
    INSERT INTO public.lead_events (team_id, canvasser_id, count, occurred_at)
    VALUES (NEW.team_id, NEW.canvasser_id, 1, COALESCE(NEW.reviewed_at, now()));
  END IF;
  RETURN NEW;
END $$;
