-- Widen the field_pins column-level UPDATE grant to include objection.
-- 20260824150000 revoked table-level UPDATE on field_pins from authenticated
-- and re-granted UPDATE on (pin_type, note) only. 20260917120000 then added
-- the objection column claiming no grant changes were needed — true for
-- INSERT (table-level grant) but not for UPDATE, so switching an existing
-- pin's result to Not Interested with an objection (updatePin in
-- src/hooks/useFieldPins.ts) fails with a permission error for every role.
-- The same-day/ownership RLS fences from 20260824150000 are unchanged;
-- is_remote_drop, coordinates, and log_date stay server-owned.
-- Idempotent; apply by hand via `supabase db query --linked --file <file>`.

GRANT UPDATE (objection) ON public.field_pins TO authenticated;
