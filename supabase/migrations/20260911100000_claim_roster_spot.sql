-- ── claim_roster_spot ───────────────────────────────────────────────────────
-- Self-serve joining (owner ask 2026-09-11: "can they just login from the
-- website — I don't have time to invite each person"). A brand-new signup
-- whose name matches a board-minted placeholder claims that roster spot on
-- the spot: role granted, van/office/XP/pay state copied, and every log,
-- lead, pin, and turf the placeholder owned moves to the new login. The
-- ROSTER stays the allowlist — managers control who is on the boards, so a
-- name that matches nothing (or matches an account that already has a
-- login) still lands in the waiting room for manual activation. This
-- deliberately narrows the 2026-08-12 "signup must not self-assign" rule:
-- self-assignment is allowed ONLY at canvasser tier and ONLY into a spot a
-- manager already created.
--
-- Guards:
--   * caller must be authenticated, role-less (pre-activation only), and a
--     real login profile (not a placeholder, not a pseudo channel name);
--   * the name must not be borne by ANY other login (no claiming accounts);
--   * only ACTIVE placeholders count, and none of them may carry a role
--     above canvasser/sales_rep (captain/confirmer+ spots need an invite);
--   * runs under the same advisory locks as merge_canvassers/rename so
--     concurrent merges cannot interleave.
--
-- The history move is the placeholder-only subset of merge_canvassers
-- (placeholders have no auth-keyed rows — canvasser_stats, time_entries,
-- objection_attempts, hype_events are necessarily empty). daily_logs /
-- daily_metrics still SUM-collapse because two same-named placeholders (the
-- webhook-dupe case) can collide on the same date key.

CREATE OR REPLACE FUNCTION public.claim_roster_spot()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _caller uuid := auth.uid();
  _me public.profiles%ROWTYPE;
  _rep public.profiles%ROWTYPE;
  _norm text;
  _role public.app_role;
  _ph_ids uuid[];
  _ph uuid;
  _n int;
  c_daily_logs int := 0;  c_daily_metrics int := 0;  c_leads int := 0;
  c_lead_events int := 0; c_field_pins int := 0;     c_territories int := 0;
  c_turfs int := 0;       c_turf_hist int := 0;      c_aliases int := 0;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('canvasser_identity'));
  PERFORM pg_advisory_xact_lock(hashtext('user_roles_swap'));

  -- Pre-activation accounts only: anyone holding a role already went
  -- through activation (or IS staff) and must use Combine, not claim.
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _caller) THEN
    RETURN jsonb_build_object('status', 'already_active');
  END IF;

  SELECT * INTO _me FROM public.profiles WHERE id = _caller;
  IF NOT FOUND OR _me.is_placeholder THEN
    RETURN jsonb_build_object('status', 'no_match');
  END IF;
  _norm := public.normalize_display_name(_me.display_name);
  IF _norm = '' OR public.is_pseudo_source_name(_me.display_name) THEN
    RETURN jsonb_build_object('status', 'no_match');
  END IF;

  -- A name already borne by another LOGIN is never claimable — that person
  -- exists; signing up with their name must not touch their account.
  IF EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id <> _caller
      AND NOT p.is_placeholder
      AND public.normalize_display_name(p.display_name) = _norm
  ) THEN
    RETURN jsonb_build_object('status', 'name_taken');
  END IF;

  SELECT array_agg(p.id) INTO _ph_ids
  FROM public.profiles p
  WHERE p.id <> _caller
    AND p.is_placeholder
    AND COALESCE(p.is_active, true)
    AND public.normalize_display_name(p.display_name) = _norm;
  IF _ph_ids IS NULL THEN
    RETURN jsonb_build_object('status', 'no_match');
  END IF;

  -- Canvasser-tier spots only: anything above needs a manager's invite.
  IF EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = ANY (_ph_ids)
      AND ur.role NOT IN ('canvasser'::public.app_role, 'sales_rep'::public.app_role)
  ) THEN
    RETURN jsonb_build_object('status', 'name_taken');
  END IF;

  -- Role: the roster's own tier wins; otherwise the signup's requested_role
  -- claim (metadata), clamped to the canvasser tier.
  SELECT ur.role INTO _role
  FROM public.user_roles ur
  WHERE ur.user_id = ANY (_ph_ids)
    AND ur.role IN ('canvasser'::public.app_role, 'sales_rep'::public.app_role)
  ORDER BY CASE ur.role WHEN 'sales_rep'::public.app_role THEN 0 ELSE 1 END
  LIMIT 1;
  IF _role IS NULL THEN
    SELECT CASE WHEN u.raw_user_meta_data ->> 'requested_role' = 'sales_rep'
                THEN 'sales_rep'::public.app_role
                ELSE 'canvasser'::public.app_role END
      INTO _role
    FROM auth.users u WHERE u.id = _caller;
    _role := COALESCE(_role, 'canvasser'::public.app_role);
  END IF;

  -- Rep placeholder (prefer one on a van): its person-state rides onto the
  -- login profile — same field set the invite flow copies. display_name
  -- takes the roster's canonical casing so the webhook matcher stays exact.
  SELECT * INTO _rep FROM public.profiles
  WHERE id = ANY (_ph_ids)
  ORDER BY (team_id IS NULL), created_at
  LIMIT 1;

  UPDATE public.profiles SET
    display_name = _rep.display_name,
    team_id = _rep.team_id,
    office_location = _rep.office_location,
    suspension_tracked = _rep.suspension_tracked,
    level = _rep.level,
    xp = _rep.xp,
    current_rank = _rep.current_rank,
    rolling_4_week_sit_avg = _rep.rolling_4_week_sit_avg,
    consecutive_weeks_3_plus_sits = _rep.consecutive_weeks_3_plus_sits,
    consecutive_weeks_7_plus_sits = _rep.consecutive_weeks_7_plus_sits,
    avg_commission = _rep.avg_commission,
    monthly_goal = _rep.monthly_goal,
    weekly_income_goal = _rep.weekly_income_goal,
    recruits_count = _rep.recruits_count,
    status = _rep.status,
    pay_lock_status = _rep.pay_lock_status,
    pay_lock_warned_on = _rep.pay_lock_warned_on,
    pay_lock_reverted_on = _rep.pay_lock_reverted_on,
    pay_lock_evaluated_week = _rep.pay_lock_evaluated_week,
    pay_lock_prev_status = _rep.pay_lock_prev_status,
    pay_lock_prev_warned_on = _rep.pay_lock_prev_warned_on,
    pay_lock_prev_reverted_on = _rep.pay_lock_prev_reverted_on,
    updated_at = now()
  WHERE id = _caller;

  INSERT INTO public.user_roles (user_id, role) VALUES (_caller, _role);

  FOREACH _ph IN ARRAY _ph_ids LOOP
    -- daily_logs: 3-col key (canvasser_id, log_date, office_location) —
    -- SUM counters into colliding rows, then move the rest (verbatim from
    -- merge_canvassers 20260816010000).
    UPDATE public.daily_logs k SET
      doors_knocked    = k.doors_knocked    + l.doors_knocked,
      people_talked_to = k.people_talked_to + l.people_talked_to,
      renters          = k.renters          + l.renters,
      leads_called_in  = k.leads_called_in  + l.leads_called_in,
      next_days        = k.next_days        + l.next_days,
      future_leads     = k.future_leads     + l.future_leads,
      demos_sits       = k.demos_sits       + l.demos_sits,
      sales            = k.sales            + l.sales,
      one_legs         = k.one_legs         + l.one_legs,
      no_shows         = k.no_shows         + l.no_shows,
      no_demo          = k.no_demo          + l.no_demo,
      confirmed_leads  = k.confirmed_leads  + l.confirmed_leads,
      unmarked         = k.unmarked         + l.unmarked,
      not_interested   = k.not_interested   + l.not_interested,
      ctc              = k.ctc              + l.ctc,
      non_core         = k.non_core         + l.non_core,
      notes            = NULLIF(concat_ws(E'\n', k.notes, l.notes), '')
    FROM public.daily_logs l
    WHERE k.canvasser_id = _caller AND l.canvasser_id = _ph
      AND k.log_date = l.log_date AND k.office_location = l.office_location;
    GET DIAGNOSTICS _n = ROW_COUNT; c_daily_logs := c_daily_logs + _n;
    DELETE FROM public.daily_logs l
    WHERE l.canvasser_id = _ph AND EXISTS (
      SELECT 1 FROM public.daily_logs k
      WHERE k.canvasser_id = _caller AND k.log_date = l.log_date
        AND k.office_location = l.office_location);
    UPDATE public.daily_logs SET canvasser_id = _caller WHERE canvasser_id = _ph;
    GET DIAGNOSTICS _n = ROW_COUNT; c_daily_logs := c_daily_logs + _n;

    -- daily_metrics: 2-col key (canvasser_id, metric_date).
    UPDATE public.daily_metrics k SET
      leads_called_in = k.leads_called_in + l.leads_called_in,
      leads_confirmed = k.leads_confirmed + l.leads_confirmed,
      sits_ran_today  = k.sits_ran_today  + l.sits_ran_today,
      leads_submitted = k.leads_submitted + l.leads_submitted,
      no_answers      = k.no_answers      + l.no_answers,
      killed          = k.killed          + l.killed,
      pending         = k.pending         + l.pending,
      blowouts        = k.blowouts        + l.blowouts,
      outside_leads   = k.outside_leads   + l.outside_leads,
      resets          = k.resets          + l.resets,
      pitch_missed    = k.pitch_missed    + l.pitch_missed,
      sales           = k.sales           + l.sales,
      leads_generated = k.leads_generated + l.leads_generated,
      future          = k.future          + l.future
    FROM public.daily_metrics l
    WHERE k.canvasser_id = _caller AND l.canvasser_id = _ph
      AND k.metric_date = l.metric_date;
    GET DIAGNOSTICS _n = ROW_COUNT; c_daily_metrics := c_daily_metrics + _n;
    DELETE FROM public.daily_metrics l
    WHERE l.canvasser_id = _ph AND EXISTS (
      SELECT 1 FROM public.daily_metrics k
      WHERE k.canvasser_id = _caller AND k.metric_date = l.metric_date);
    UPDATE public.daily_metrics SET canvasser_id = _caller WHERE canvasser_id = _ph;
    GET DIAGNOSTICS _n = ROW_COUNT; c_daily_metrics := c_daily_metrics + _n;

    -- Straight repoints (profiles-keyed).
    UPDATE public.leads SET canvasser_id = _caller WHERE canvasser_id = _ph;
    GET DIAGNOSTICS _n = ROW_COUNT; c_leads := c_leads + _n;

    UPDATE public.lead_events SET canvasser_id = _caller WHERE canvasser_id = _ph;
    GET DIAGNOSTICS _n = ROW_COUNT; c_lead_events := c_lead_events + _n;

    UPDATE public.field_pins SET canvasser_id = _caller WHERE canvasser_id = _ph;
    GET DIAGNOSTICS _n = ROW_COUNT; c_field_pins := c_field_pins + _n;

    UPDATE public.territories SET
      canvasser_id = CASE WHEN canvasser_id = _ph THEN _caller ELSE canvasser_id END,
      created_by   = CASE WHEN created_by   = _ph THEN _caller ELSE created_by   END
    WHERE canvasser_id = _ph OR created_by = _ph;
    GET DIAGNOSTICS _n = ROW_COUNT; c_territories := c_territories + _n;

    -- Turfs in two steps (stamp_turf_assignment BEFORE trigger stamps the
    -- assignee repoint — correct, it IS a reassignment to the claimant).
    SELECT count(*) INTO _n FROM public.turfs
    WHERE assigned_user_id = _ph OR created_by = _ph;
    c_turfs := c_turfs + _n;
    UPDATE public.turfs SET assigned_user_id = _caller WHERE assigned_user_id = _ph;
    UPDATE public.turfs SET created_by = _caller WHERE created_by = _ph;

    UPDATE public.turf_assignment_history
    SET assigned_user_id = _caller WHERE assigned_user_id = _ph;
    GET DIAGNOSTICS _n = ROW_COUNT; c_turf_hist := c_turf_hist + _n;

    -- teams.captain_id can point at a role-less placeholder (UI-dead FK) —
    -- repoint so the profile delete below can't trip it.
    UPDATE public.teams SET captain_id = _caller WHERE captain_id = _ph;

    -- Aliases follow; merged_into chains collapse to the claimant.
    UPDATE public.canvasser_aliases SET profile_id = _caller, updated_at = now()
    WHERE profile_id = _ph;
    GET DIAGNOSTICS _n = ROW_COUNT; c_aliases := c_aliases + _n;
    UPDATE public.profiles SET merged_into = _caller WHERE merged_into = _ph;

    -- Placeholder cleanup: no auth user behind it → hard delete, same as
    -- merge_canvassers' placeholder-loser path.
    DELETE FROM public.user_roles WHERE user_id = _ph;
    DELETE FROM public.profiles WHERE id = _ph;
  END LOOP;

  BEGIN
    PERFORM public.refresh_canvasser_rank(_caller);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'status', 'claimed',
    'role', _role,
    'team_id', _rep.team_id,
    'display_name', _rep.display_name,
    'claimed_ids', to_jsonb(_ph_ids),
    'moved', jsonb_build_object(
      'daily_logs', c_daily_logs,
      'daily_metrics', c_daily_metrics,
      'leads', c_leads,
      'lead_events', c_lead_events,
      'field_pins', c_field_pins,
      'territories', c_territories,
      'turfs', c_turfs,
      'turf_assignment_history', c_turf_hist,
      'aliases_repointed', c_aliases
    )
  );
END $$;

REVOKE ALL ON FUNCTION public.claim_roster_spot() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_roster_spot() TO authenticated, service_role;
