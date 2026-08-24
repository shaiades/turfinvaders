-- Same-day fence for pin corrections — defense in depth BELOW the UI.
-- 20260824140000 made pin UPDATE/DELETE move daily_logs counters; until now
-- "same-day only" and "remote pins never count" were enforced purely by which
-- pins the Territory map happens to render. This closes the two DB-level gaps:
--   1) The old "Canvassers manage their pins" FOR ALL policy allowed a
--      canvasser to UPDATE/DELETE their pins from ANY day (stale tab past
--      midnight, or a direct API call with their own JWT) — rewriting
--      historical, payroll-adjacent counters. Now UPDATE/DELETE require
--      log_date = the current LA day; SELECT/INSERT semantics are unchanged.
--   2) Table-level UPDATE let a canvasser flip is_remote_drop=false on their
--      own flagged pins and self-credit stats. UPDATE is now column-limited
--      to pin_type and note for clients; is_remote_drop, coordinates, and
--      log_date stay server-owned (SECURITY DEFINER / service-role paths are
--      unaffected by column grants).
-- Idempotent; apply by hand in the Supabase dashboard SQL editor.

-- 1) Split the FOR ALL policy into per-command policies with a date fence on
--    the two correction commands. All four use canvasser_id = auth.uid(), so
--    canvassers still only ever touch their own pins.
DROP POLICY IF EXISTS "Canvassers manage their pins" ON public.field_pins;

DROP POLICY IF EXISTS "Canvassers read their pins" ON public.field_pins;
CREATE POLICY "Canvassers read their pins"
  ON public.field_pins FOR SELECT TO authenticated
  USING (canvasser_id = auth.uid());

DROP POLICY IF EXISTS "Canvassers insert their pins" ON public.field_pins;
CREATE POLICY "Canvassers insert their pins"
  ON public.field_pins FOR INSERT TO authenticated
  WITH CHECK (canvasser_id = auth.uid());

DROP POLICY IF EXISTS "Canvassers correct today's pins" ON public.field_pins;
CREATE POLICY "Canvassers correct today's pins"
  ON public.field_pins FOR UPDATE TO authenticated
  USING (
    canvasser_id = auth.uid()
    AND log_date = (now() AT TIME ZONE 'America/Los_Angeles')::date
  )
  WITH CHECK (
    canvasser_id = auth.uid()
    AND log_date = (now() AT TIME ZONE 'America/Los_Angeles')::date
  );

DROP POLICY IF EXISTS "Canvassers delete today's pins" ON public.field_pins;
CREATE POLICY "Canvassers delete today's pins"
  ON public.field_pins FOR DELETE TO authenticated
  USING (
    canvasser_id = auth.uid()
    AND log_date = (now() AT TIME ZONE 'America/Los_Angeles')::date
  );

-- 2) Clients may only change the knock result (and a future note) — never the
--    remote flag, coordinates, ownership, or date.
REVOKE UPDATE ON public.field_pins FROM authenticated;
GRANT UPDATE (pin_type, note) ON public.field_pins TO authenticated;
