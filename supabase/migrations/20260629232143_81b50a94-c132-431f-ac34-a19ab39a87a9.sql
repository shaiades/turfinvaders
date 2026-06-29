-- Lock down EXECUTE on SECURITY DEFINER functions per Supabase linter 0028/0029.
-- Revoke from PUBLIC and anon; grant authenticated only where the app/RLS needs it.

REVOKE EXECUTE ON FUNCTION public.global_visibility_on() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.my_team_id(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fire_lead_event_on_confirm() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_evaluate_suspension() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_canvasser_rank(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.calc_monthly_paycheck(uuid, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.bump_daily_log_from_pin() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.evaluate_canvasser_suspension(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_refresh_rank_from_log() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.calc_weekly_paycheck(uuid, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;

-- Re-grant to authenticated for helpers used by RLS policies and app server fns.
GRANT EXECUTE ON FUNCTION public.global_visibility_on() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_team_id(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_canvasser_rank(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calc_monthly_paycheck(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calc_weekly_paycheck(uuid, date) TO authenticated;

-- Service role keeps full access for triggers/admin paths.
GRANT EXECUTE ON FUNCTION public.global_visibility_on() TO service_role;
GRANT EXECUTE ON FUNCTION public.my_team_id(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO service_role;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
GRANT EXECUTE ON FUNCTION public.fire_lead_event_on_confirm() TO service_role;
GRANT EXECUTE ON FUNCTION public.trg_evaluate_suspension() TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_canvasser_rank(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.calc_monthly_paycheck(uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.bump_daily_log_from_pin() TO service_role;
GRANT EXECUTE ON FUNCTION public.evaluate_canvasser_suspension(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.trg_refresh_rank_from_log() TO service_role;
GRANT EXECUTE ON FUNCTION public.calc_weekly_paycheck(uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.touch_updated_at() TO service_role;