-- Objection Dojo (owner request 2026-08-14): canvassers record themselves
-- handling common objections; a Manager (office_staff) or Owner approves
-- before an attempt goes live for everyone to watch. Approvals mirror the
-- Confirmation Desk pattern: pending → approved | denied.
--
-- APPLY BY HAND in the Supabase dashboard (SQL editor) — this repo's
-- migrations are not auto-applied.

-- ============ Tables ============

CREATE TABLE public.objections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  prompt text,
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.objection_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  objection_id uuid NOT NULL REFERENCES public.objections(id) ON DELETE CASCADE,
  canvasser_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- storage.objects.name in the objection-attempts bucket:
  -- <canvasser_id>/<attempt uuid>.<webm|mp4>
  storage_path text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  deny_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX objection_attempts_objection_status_idx
  ON public.objection_attempts (objection_id, status);
CREATE INDEX objection_attempts_canvasser_idx
  ON public.objection_attempts (canvasser_id);

ALTER TABLE public.objections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.objection_attempts ENABLE ROW LEVEL SECURITY;

-- ============ objections policies ============
-- Everyone signed-in sees active objections; Owners + Managers manage them.

CREATE POLICY "Objections visible to all players" ON public.objections
  FOR SELECT TO authenticated
  USING (active OR public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

CREATE POLICY "Owners and Managers manage objections" ON public.objections
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'))
  WITH CHECK (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

-- ============ objection_attempts policies ============

-- Submit: canvassers file their own attempts (any role may practice).
CREATE POLICY "Players submit own attempts" ON public.objection_attempts
  FOR INSERT TO authenticated
  WITH CHECK (canvasser_id = auth.uid());

-- Read: own attempts always; approved attempts for everyone signed-in;
-- Owners + Managers see the whole queue.
CREATE POLICY "Players see own attempts" ON public.objection_attempts
  FOR SELECT TO authenticated
  USING (canvasser_id = auth.uid());
CREATE POLICY "Approved attempts visible to all players" ON public.objection_attempts
  FOR SELECT TO authenticated
  USING (status = 'approved');
CREATE POLICY "Owners and Managers see all attempts" ON public.objection_attempts
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

-- Review: Owners + Managers approve/deny.
CREATE POLICY "Owners and Managers review attempts" ON public.objection_attempts
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'))
  WITH CHECK (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

-- Withdraw: a player may delete their own not-yet-approved attempt;
-- Owners + Managers may delete anything.
CREATE POLICY "Players withdraw own pending attempts" ON public.objection_attempts
  FOR DELETE TO authenticated
  USING (canvasser_id = auth.uid() AND status <> 'approved');
CREATE POLICY "Owners and Managers delete attempts" ON public.objection_attempts
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

-- ============ Storage ============

INSERT INTO storage.buckets (id, name, public)
VALUES ('objection-attempts', 'objection-attempts', false);

-- Upload: only into your own <auth.uid()>/ folder.
CREATE POLICY "Players upload own attempt videos" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'objection-attempts'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Playback (signed URLs require SELECT): your own files, files whose attempt
-- row is approved, and everything for Owners + Managers.
CREATE POLICY "Players read own attempt videos" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'objection-attempts'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
CREATE POLICY "Approved attempt videos readable by all players" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'objection-attempts'
    AND EXISTS (
      SELECT 1 FROM public.objection_attempts a
      WHERE a.storage_path = storage.objects.name AND a.status = 'approved'
    )
  );
CREATE POLICY "Owners and Managers read all attempt videos" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'objection-attempts'
    AND (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'))
  );

-- Cleanup: owner of the file or Owners + Managers may delete.
CREATE POLICY "Players delete own attempt videos" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'objection-attempts'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
CREATE POLICY "Owners and Managers delete attempt videos" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'objection-attempts'
    AND (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'))
  );

-- ============ Seed objections (from the owner's reference design) ============

INSERT INTO public.objections (title, prompt, sort) VALUES
  ('"I''m Not Interested"',        'Use the pivot technique to turn this objection into curiosity.', 1),
  ('"I Don''t Have Money"',        'Address the budget concern while building value.',               2),
  ('"I Need to Talk to My Spouse"','Handle the third-party objection with confidence.',              3),
  ('"I''m Too Busy"',              'Acknowledge their time while creating urgency.',                 4);
