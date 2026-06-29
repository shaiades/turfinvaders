
-- Strict per-canvasser visibility for daily_logs and leads.
-- Visibility toggle no longer widens raw row access — it only controls
-- production-metric peer views in the app layer.

DROP POLICY IF EXISTS "daily_logs read scoped" ON public.daily_logs;
CREATE POLICY "daily_logs read scoped"
  ON public.daily_logs FOR SELECT
  USING (
    canvasser_id = auth.uid()
    OR public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR (
      public.has_role(auth.uid(), 'captain'::app_role)
      AND team_id IN (SELECT id FROM public.teams WHERE captain_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "leads read scoped" ON public.leads;
CREATE POLICY "leads read scoped"
  ON public.leads FOR SELECT
  USING (
    canvasser_id = auth.uid()
    OR public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
    OR (
      public.has_role(auth.uid(), 'captain'::app_role)
      AND team_id IN (SELECT id FROM public.teams WHERE captain_id = auth.uid())
    )
  );
