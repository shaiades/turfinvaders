-- ═══════════════════════════════════════════════════════════════════════════
-- PUSH NOTIFICATIONS FOR THE OBJECTION DOJO (owner request 2026-09-13).
-- Closes the silent review loop from 20260815010000: today a submission sits
-- unseen until a reviewer happens to open the Confirmation Desk, and the
-- submitter never learns the outcome. One trigger now covers both directions,
-- POSTing (via pg_net, async) to the notify-dojo edge function:
--  · INSERT at 'pending'              → kind 'submission' → push owners+Managers
--  · UPDATE pending → approved|denied → kind 'outcome'    → push the submitter
--
-- SAFETY CONTRACT — every pushy branch is exception-wrapped so a notification
-- failure can NEVER fail a submission or a review write. The transition guard
-- keeps re-saves, deny_reason touch-ups, and hand-edits of already-reviewed
-- rows silent (and AFTER … UPDATE OF status skips non-status updates before
-- the function even runs).
--
-- Also hardens the INSERT policy: it never constrained status, so a crafted
-- PostgREST insert could self-publish at 'approved'. Now pending-only.
--
-- Reuses the 'notify_secret' vault secret from 20260824120000 — nothing new
-- to provision. Idempotent; APPLY BY HAND (supabase db query --linked --file).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.notify_objection_attempt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _secret text;
  _kind text;
BEGIN
  -- Branch selection first; everything else stays quiet — same-status
  -- re-saves, edits to an already-denied row, approved → anything.
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    _kind := 'submission';
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'pending'
        AND NEW.status IN ('approved', 'denied') THEN
    _kind := 'outcome';
  ELSE
    RETURN NEW;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO _secret
    FROM vault.decrypted_secrets WHERE name = 'notify_secret' LIMIT 1;
    IF _secret IS NULL OR _secret = '' THEN RETURN NEW; END IF;

    -- Ids only; the edge function resolves names and objection titles.
    PERFORM net.http_post(
      url := 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/notify-dojo',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-notify-secret', _secret
      ),
      body := jsonb_build_object(
        'kind', _kind,
        'attempt_id', NEW.id,
        'objection_id', NEW.objection_id,
        'canvasser_id', NEW.canvasser_id,
        'status', NEW.status,
        'deny_reason', NEW.deny_reason
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- a notification must NEVER break a submission or a review
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS objection_attempts_notify ON public.objection_attempts;
CREATE TRIGGER objection_attempts_notify
  AFTER INSERT OR UPDATE OF status ON public.objection_attempts
  FOR EACH ROW EXECUTE FUNCTION public.notify_objection_attempt();

-- ── RLS hardening ───────────────────────────────────────────────────────────
-- Submissions may only be born pending and unreviewed; the client insert
-- (ObjectionDojo.tsx) sends none of these columns, so it passes unchanged.
-- Reviewer UPDATEs are governed by their own policy and are untouched.
ALTER POLICY "Players submit own attempts" ON public.objection_attempts
  WITH CHECK (
    canvasser_id = auth.uid()
    AND status = 'pending'
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND deny_reason IS NULL
  );
