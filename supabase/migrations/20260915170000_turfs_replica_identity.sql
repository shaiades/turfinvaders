-- Realtime delivers UPDATE/DELETE events to RLS-scoped subscribers only when
-- the OLD row is fully present in WAL (the policy is evaluated against it).
-- turfs joined supabase_realtime with default replica identity (PK only), so
-- a turf REASSIGNMENT never live-pushed to the canvasser's map — the teammate
-- only saw their new area after a full app reload. INSERTs were unaffected,
-- which is why fresh areas sometimes appeared and reassigned ones didn't.
-- zip_assignments already runs FULL (20260911100000); bring turfs in line.
ALTER TABLE public.turfs REPLICA IDENTITY FULL;
