-- ═══════════════════════════════════════════════════════════════════════════
-- WRITE LOCK (owner mandate 2026-10-10, rule L — the real fix for double-issuing).
--
-- The dispatcher already re-reads people6 right before every write and unions
-- rather than replaces (rules A1/A3 + H5). That stops a writer from ERASING a
-- rep, but not two writers from issuing the SAME pair onto TWO different leads
-- in the same minute (the 10/9 Jovanny+Josiah → Krupa 2:00 / Dolan 4:00
-- double-issue): each writer read before the other wrote, so neither saw the
-- other's in-flight assignment.
--
-- This adds a tiny, short-lived advisory lock that every people6 / status
-- writer takes BEFORE its read-modify-write and clears after:
--   · 'item:<itemId>'  serializes two writers on the SAME block item;
--   · 'rep:<userId>'    serializes issuing the SAME rep across DIFFERENT items
--                       (the cross-pair guard — what actually catches 10/9).
-- A lock is stolen only once expired (TTL, default 45s) so a crashed edge
-- invocation self-heals; re-acquiring as the same holder is a no-op refresh.
--
-- Idempotent — safe to run more than once.
-- Apply via: supabase db query --linked --file supabase/migrations/20261020120000_write_locks.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.monday_write_locks (
  lock_key text NOT NULL PRIMARY KEY,   -- 'item:<id>' | 'rep:<monday user id>'
  holder text NOT NULL,                 -- the invocation that owns the lock
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS monday_write_locks_expires_idx
  ON public.monday_write_locks (expires_at);

GRANT ALL ON public.monday_write_locks TO service_role;
ALTER TABLE public.monday_write_locks ENABLE ROW LEVEL SECURITY;
-- No authenticated policy: the lock is service-role-only (the edge functions).
-- Reads are allowed to admins for debugging the lock table.
DROP POLICY IF EXISTS "write locks read admin" ON public.monday_write_locks;
CREATE POLICY "write locks read admin" ON public.monday_write_locks
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'office_staff'));

-- try_acquire_write_lock — atomically take the lock iff it is free, already
-- ours, or expired. Returns TRUE iff the caller now holds it. The ON CONFLICT
-- UPDATE only fires on an expired lock or a re-acquire by the same holder; a
-- lock held fresh by someone else leaves the row untouched and the final SELECT
-- reports that other holder, so the function returns FALSE.
CREATE OR REPLACE FUNCTION public.try_acquire_write_lock(
  p_key text,
  p_holder text,
  p_ttl_sec int DEFAULT 45
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _holder text;
BEGIN
  INSERT INTO public.monday_write_locks (lock_key, holder, acquired_at, expires_at)
  VALUES (p_key, p_holder, now(), now() + make_interval(secs => GREATEST(p_ttl_sec, 1)))
  ON CONFLICT (lock_key) DO UPDATE
    SET holder = EXCLUDED.holder,
        acquired_at = now(),
        expires_at = EXCLUDED.expires_at
    WHERE public.monday_write_locks.expires_at < now()
       OR public.monday_write_locks.holder = EXCLUDED.holder;
  SELECT holder INTO _holder FROM public.monday_write_locks WHERE lock_key = p_key;
  RETURN _holder = p_holder;
END $$;

-- release_write_lock — drop the lock only if WE still hold it (never free
-- another holder's lock, even if ours already expired and was stolen).
CREATE OR REPLACE FUNCTION public.release_write_lock(
  p_key text,
  p_holder text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.monday_write_locks WHERE lock_key = p_key AND holder = p_holder;
$$;

REVOKE ALL ON FUNCTION public.try_acquire_write_lock(text, text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_write_lock(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_acquire_write_lock(text, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_write_lock(text, text) TO service_role;
