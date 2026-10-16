-- ═══════════════════════════════════════════════════════════════════════════
-- MERGE CANVASSERS v2 (conversion audit 2026-10-15, Phase 1 §1) — the Aug 16
-- merge tool predates ~20 tables, so merging today silently destroys badges,
-- gratitude streaks, cartoon art and purpose data (CASCADE on hard delete) or
-- fails outright on the NO-ACTION FKs added since (activity_tests.rep_id,
-- rep_job_visits.rep_id, production_job_overrides.set_by,
-- purpose_safety_flags.*_by). This migration:
--
--   1. profiles.non_person — marks rows that are attribution channels, not
--      people ("Test", "Cris López & Eric"), so lists/leaderboards/View As can
--      hide them while the Monday webhook keeps crediting them. Lead-source
--      channels (is_pseudo_source_name) stay their own concept — those are
--      additionally protected from rename/merge.
--   2. fold_display_name() — accent-folded normalize (unaccent), the SQL twin
--      of the edge matcher's new folded tier, used by the duplicate dry-run
--      and bulk merge in supabase/corrections/.
--   3. purpose_* child FKs become ON UPDATE CASCADE so a purpose profile can
--      follow a merge (the composite (id, user_id) anchor otherwise makes the
--      parent's user_id unupdatable).
--   4. merge_canvassers() rewritten: every table added since Aug 16 is moved,
--      summed or deduped (list below); non_person rows refuse to merge; and a
--      NULL auth.uid() is treated as a service/SQL-editor caller (owner-level)
--      so corrections can drive bulk merges — anon never gets EXECUTE, and
--      every PostgREST-authenticated caller has a non-null uid, so NULL can
--      only be postgres/service_role.
--   5. rename_canvasser() gets the same non_person refusal + service-caller
--      rule.
--
-- Pay surfaces are untouched: payroll_run_lines / commission_clawbacks are
-- point-in-time snapshots and keep their original canvasser_id + name, and
-- nothing here touches calc_*_paycheck. Monday-name-keyed surfaces
-- (block_cards.reps, contest_ledger.rep_name, attendance_overrides,
-- ooh_* rep_name, feed_events.actor_name) follow Monday, not profiles — same
-- scope rule as 20260816010000.
--
-- Idempotent — safe to re-paste.
-- Apply via: supabase db query --linked --file supabase/migrations/20261027120000_merge_canvassers_v2.sql
-- Runs AFTER 20260816010000 (canvasser_rename_merge) and 20261026120000.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA extensions;

-- ── 1) non_person flag ──────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS non_person boolean NOT NULL DEFAULT false;

-- ── 2) Accent-folded name key ───────────────────────────────────────────────
-- "Cris López" and "Cris Lopez" fold to the same key. STABLE (unaccent reads
-- its dictionary), so no index on it — it's a grouping/matching key for the
-- dry-run report, the bulk merge, and ad-hoc duplicate queries.
CREATE OR REPLACE FUNCTION public.fold_display_name(_s text)
RETURNS text LANGUAGE sql STABLE
AS $$
  SELECT public.normalize_display_name(extensions.unaccent(COALESCE(_s, '')))
$$;
REVOKE ALL ON FUNCTION public.fold_display_name(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fold_display_name(text) TO authenticated, service_role;

-- ── 3) purpose_* children: let the parent's user_id move ────────────────────
-- Children anchor to UNIQUE (id, user_id) on purpose_profiles with NO ACTION,
-- which freezes purpose_profiles.user_id forever. ON UPDATE CASCADE keeps the
-- denormalized child user_id in lockstep when a merge repoints the parent.
DO $$
DECLARE
  _child text;
  _con record;
BEGIN
  FOREACH _child IN ARRAY ARRAY[
    'purpose_answers','purpose_goals','purpose_beliefs','purpose_whys',
    'purpose_if_then_plans','purpose_reflections','purpose_safety_flags',
    'purpose_revision_log'
  ] LOOP
    FOR _con IN
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE nsp.nspname = 'public' AND rel.relname = _child
        AND con.contype = 'f'
        AND con.confrelid = 'public.purpose_profiles'::regclass
        AND con.confupdtype = 'a'  -- NO ACTION only; already-cascading left alone
    LOOP
      EXECUTE format(
        'ALTER TABLE public.%I DROP CONSTRAINT %I', _child, _con.conname);
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I
           FOREIGN KEY (purpose_profile_id, user_id)
           REFERENCES public.purpose_profiles (id, user_id)
           ON UPDATE CASCADE ON DELETE CASCADE',
        _child, _con.conname);
    END LOOP;
  END LOOP;
END $$;

-- ── 4) merge_canvassers v2 ──────────────────────────────────────────────────
-- Same signature and same direction guard (the keeper must hold the login
-- when any loser does). New in v2, per loser:
--   canvasser_badges        PK (user_id,badge_id): earliest earned_at, seen OR
--   gratitude_entries       UNIQUE (user_id,entry_date): keeper's row wins
--   activity_tests          UNIQUE (rep_id,taken_on,source): keeper's wins
--   rep_job_visits          UNIQUE (monday_item_id,rep_id,visited_on): dedupe
--   rep_commission_notes    UNIQUE (monday_item_id,rep_id): keeper's wins
--   production_job_overrides.set_by, house_notes.author_id,
--   zip_assignments.captain_id/assigned_by, profiles.van_locked_by: repoint
--   canvasser_photos        PK profile_id: approved art wins, else keeper's
--   kombat_rep_aliases      PK profile_id: keeper's wins
--   purpose_profiles        UNIQUE user_id: repoint when keeper has none
--                           (children follow via ON UPDATE CASCADE), else the
--                           loser's stays on the archived row — reported
--   purpose_leadership_notes.author_user_id, purpose_safety_flags
--                           acknowledged_by/cleared_by: repoint
--   meal_periods, push_subscriptions, contest_proofs: straight repoint
--   time_week_attestations  one active per (user,week): loser's superseded
--   time_clock_exceptions   one active per (user,date): loser's revoked
--   day_off_requests        one active per (user,date): loser's cancelled
--   respawn_requests        UNIQUE (user_id,week_start): keeper's wins;
--                           moved rows get the keeper's rep_name snapshot
--   sick_leave_ledger       one accrual per (user,week): accruals SUM
CREATE OR REPLACE FUNCTION public.merge_canvassers(
  _loser_ids uuid[], _keeper uuid, _keep_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _caller uuid := auth.uid();
  _caller_is_owner boolean;
  _losers uuid[];
  _loser uuid;
  _keeper_row public.profiles%ROWTYPE;
  _loser_row public.profiles%ROWTYPE;
  _keeper_auth boolean;
  _loser_auth boolean;
  _keeper_norm text;
  _loser_norm text;
  _n int;
  _res text;
  c_daily_logs int := 0;  c_daily_metrics int := 0;  c_leads int := 0;
  c_lead_events int := 0; c_field_pins int := 0;     c_territories int := 0;
  c_turfs int := 0;       c_turf_hist int := 0;      c_stats int := 0;
  c_time int := 0;        c_obj int := 0;            c_hype int := 0;
  c_teams int := 0;       c_alias_repointed int := 0; c_roles int := 0;
  c_alias_cleared int := 0;
  -- v2 counters
  c_badges int := 0;      c_gratitude int := 0;      c_activity int := 0;
  c_visits int := 0;      c_comm_notes int := 0;     c_overrides int := 0;
  c_house_notes int := 0; c_zip int := 0;            c_photos int := 0;
  c_kombat_alias int := 0; c_purpose int := 0;       c_purpose_notes int := 0;
  c_meals int := 0;       c_attest int := 0;         c_exceptions int := 0;
  c_dayoff int := 0;      c_respawn int := 0;        c_sick int := 0;
  c_push int := 0;        c_proofs int := 0;         c_van_lock int := 0;
  _purpose_skipped uuid[] := '{}'::uuid[];
  _aliases jsonb := '[]'::jsonb;
  _alias_skipped jsonb := '[]'::jsonb;
  _archived uuid[] := '{}'::uuid[];
  _deleted uuid[] := '{}'::uuid[];
  _rename_result jsonb := NULL;
BEGIN
  -- NULL caller = service_role or the SQL editor (anon has no EXECUTE and
  -- every PostgREST-authenticated caller carries a uid) — owner-level, so
  -- supabase/corrections can drive bulk merges.
  IF _caller IS NULL THEN
    _caller_is_owner := true;
  ELSE
    _caller_is_owner := public.has_role(_caller, 'owner'::app_role);
    IF NOT (
      _caller_is_owner
      OR public.has_role(_caller, 'captain'::app_role)
      OR public.has_role(_caller, 'office_staff'::app_role)
    ) THEN
      RAISE EXCEPTION 'Only Owners, Captains, or Admins can merge canvassers';
    END IF;
  END IF;

  SELECT array_agg(DISTINCT u) INTO _losers FROM unnest(COALESCE(_loser_ids, '{}'::uuid[])) u;
  IF _losers IS NULL THEN RAISE EXCEPTION 'No profiles to merge'; END IF;
  IF _keeper IS NULL THEN RAISE EXCEPTION 'No keeper selected'; END IF;
  IF _keeper = ANY (_losers) THEN RAISE EXCEPTION 'Cannot merge a profile into itself'; END IF;

  -- Serialize concurrent merges/renames (chained merges must not interleave);
  -- the role deletions below additionally share the swap lock with
  -- set_user_role / prepare_profile_deletion so owner checks can't be raced.
  PERFORM pg_advisory_xact_lock(hashtext('canvasser_identity'));
  PERFORM pg_advisory_xact_lock(hashtext('user_roles_swap'));

  SELECT * INTO _keeper_row FROM public.profiles WHERE id = _keeper;
  IF NOT FOUND THEN RAISE EXCEPTION 'Keeper profile not found'; END IF;
  IF NOT COALESCE(_keeper_row.is_active, true) THEN
    RAISE EXCEPTION 'Keeper must be active — reactivate them first';
  END IF;
  IF public.is_pseudo_source_name(_keeper_row.display_name) THEN
    RAISE EXCEPTION 'Lead-source channels cannot be merged';
  END IF;
  IF COALESCE(_keeper_row.non_person, false) THEN
    RAISE EXCEPTION 'Non-person rows cannot be merged';
  END IF;
  IF public.has_role(_keeper, 'owner'::app_role) THEN
    RAISE EXCEPTION 'Owner accounts cannot be merged';
  END IF;
  IF NOT _caller_is_owner AND public.is_privileged_account(_keeper) THEN
    RAISE EXCEPTION 'Only Owners can merge Admin accounts';
  END IF;
  _keeper_auth := EXISTS (SELECT 1 FROM auth.users WHERE id = _keeper);
  _keeper_norm := public.normalize_display_name(_keeper_row.display_name);

  -- The keeper is the live bearer of its name — clear any alias shadowing it
  -- (same reasoning as rename_canvasser's clearing of the new name).
  DELETE FROM public.canvasser_aliases WHERE alias_norm = _keeper_norm;
  GET DIAGNOSTICS c_alias_cleared = ROW_COUNT;

  FOREACH _loser IN ARRAY _losers LOOP
    SELECT * INTO _loser_row FROM public.profiles WHERE id = _loser;
    IF NOT FOUND THEN RAISE EXCEPTION 'Profile % not found', _loser; END IF;
    IF public.is_pseudo_source_name(_loser_row.display_name) THEN
      RAISE EXCEPTION 'Lead-source channels cannot be merged';
    END IF;
    IF COALESCE(_loser_row.non_person, false) THEN
      RAISE EXCEPTION 'Non-person rows cannot be merged';
    END IF;
    IF public.has_role(_loser, 'owner'::app_role) THEN
      RAISE EXCEPTION 'Owner accounts cannot be merged';
    END IF;
    IF NOT _caller_is_owner AND public.is_privileged_account(_loser) THEN
      RAISE EXCEPTION 'Only Owners can merge Admin accounts';
    END IF;
    _loser_auth := EXISTS (SELECT 1 FROM auth.users WHERE id = _loser);
    IF _loser_auth AND NOT _keeper_auth THEN
      RAISE EXCEPTION
        '"%" has a login account and "%" does not — merge in the other direction so the login (roles, hours, stats) is kept',
        _loser_row.display_name, _keeper_row.display_name;
    END IF;
    _loser_norm := public.normalize_display_name(_loser_row.display_name);

    -- daily_logs: 3-col key (canvasser_id, log_date, office_location) —
    -- SUM every counter into colliding keeper rows, then move the rest.
    -- The office dimension is preserved: same-date rows from different
    -- offices stay distinct rows under the keeper.
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
    WHERE k.canvasser_id = _keeper AND l.canvasser_id = _loser
      AND k.log_date = l.log_date AND k.office_location = l.office_location;
    GET DIAGNOSTICS _n = ROW_COUNT; c_daily_logs := c_daily_logs + _n;
    DELETE FROM public.daily_logs l
    WHERE l.canvasser_id = _loser AND EXISTS (
      SELECT 1 FROM public.daily_logs k
      WHERE k.canvasser_id = _keeper AND k.log_date = l.log_date
        AND k.office_location = l.office_location);
    UPDATE public.daily_logs SET canvasser_id = _keeper WHERE canvasser_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_daily_logs := c_daily_logs + _n;

    -- daily_metrics: 2-col key (canvasser_id, metric_date) — same
    -- sum-and-collapse; the keeper row keeps its own office_location.
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
    WHERE k.canvasser_id = _keeper AND l.canvasser_id = _loser
      AND k.metric_date = l.metric_date;
    GET DIAGNOSTICS _n = ROW_COUNT; c_daily_metrics := c_daily_metrics + _n;
    DELETE FROM public.daily_metrics l
    WHERE l.canvasser_id = _loser AND EXISTS (
      SELECT 1 FROM public.daily_metrics k
      WHERE k.canvasser_id = _keeper AND k.metric_date = l.metric_date);
    UPDATE public.daily_metrics SET canvasser_id = _keeper WHERE canvasser_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_daily_metrics := c_daily_metrics + _n;

    -- Straight repoints (profiles-keyed or FK-less).
    UPDATE public.leads SET canvasser_id = _keeper WHERE canvasser_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_leads := c_leads + _n;

    UPDATE public.lead_events SET canvasser_id = _keeper WHERE canvasser_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_lead_events := c_lead_events + _n;

    UPDATE public.field_pins SET canvasser_id = _keeper WHERE canvasser_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_field_pins := c_field_pins + _n;

    UPDATE public.territories SET
      canvasser_id = CASE WHEN canvasser_id = _loser THEN _keeper ELSE canvasser_id END,
      created_by   = CASE WHEN created_by   = _loser THEN _keeper ELSE created_by   END
    WHERE canvasser_id = _loser OR created_by = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_territories := c_territories + _n;

    -- Turfs, in two steps because of the stamp_turf_assignment BEFORE
    -- trigger (20260815020000): (1) assignee repoints — the trigger stamps
    -- the reassignment to the merging manager and the AFTER trigger logs
    -- history, which is correct (it IS a reassignment); (2) created_by
    -- repoints — untouched by the trigger. assigned_by on rows whose
    -- assignee is unchanged is deliberately LEFT ALONE: the trigger would
    -- silently revert the write anyway, and the value is historical
    -- provenance pointing at an auth-backed profile (assigners come from
    -- auth.uid()), which a merge archives with merged_into set — never
    -- deletes — so the pointer stays resolvable.
    SELECT count(*) INTO _n FROM public.turfs
    WHERE assigned_user_id = _loser OR created_by = _loser;
    c_turfs := c_turfs + _n;
    UPDATE public.turfs SET assigned_user_id = _keeper WHERE assigned_user_id = _loser;
    UPDATE public.turfs SET created_by = _keeper WHERE created_by = _loser;

    -- History log: the person who worked the turf follows the merge; the
    -- assigning manager stays as recorded (same provenance reasoning).
    UPDATE public.turf_assignment_history
    SET assigned_user_id = _keeper WHERE assigned_user_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_turf_hist := c_turf_hist + _n;

    -- ── profiles-keyed tables added after Aug 16 ────────────────────────────

    -- gratitude_entries: UNIQUE (user_id, entry_date) — keeper's entry wins.
    DELETE FROM public.gratitude_entries l
    WHERE l.user_id = _loser AND EXISTS (
      SELECT 1 FROM public.gratitude_entries k
      WHERE k.user_id = _keeper AND k.entry_date = l.entry_date);
    UPDATE public.gratitude_entries SET user_id = _keeper WHERE user_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_gratitude := c_gratitude + _n;

    -- activity_tests: UNIQUE (rep_id, taken_on, source) — keeper's take wins.
    DELETE FROM public.activity_tests l
    WHERE l.rep_id = _loser AND EXISTS (
      SELECT 1 FROM public.activity_tests k
      WHERE k.rep_id = _keeper AND k.taken_on = l.taken_on AND k.source = l.source);
    UPDATE public.activity_tests SET rep_id = _keeper WHERE rep_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_activity := c_activity + _n;

    -- rep_job_visits: UNIQUE (monday_item_id, rep_id, visited_on) — dedupe.
    DELETE FROM public.rep_job_visits l
    WHERE l.rep_id = _loser AND EXISTS (
      SELECT 1 FROM public.rep_job_visits k
      WHERE k.rep_id = _keeper AND k.monday_item_id = l.monday_item_id
        AND k.visited_on = l.visited_on);
    UPDATE public.rep_job_visits SET rep_id = _keeper WHERE rep_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_visits := c_visits + _n;

    -- rep_commission_notes: UNIQUE (monday_item_id, rep_id) — keeper's wins.
    DELETE FROM public.rep_commission_notes l
    WHERE l.rep_id = _loser AND EXISTS (
      SELECT 1 FROM public.rep_commission_notes k
      WHERE k.rep_id = _keeper AND k.monday_item_id = l.monday_item_id);
    UPDATE public.rep_commission_notes SET rep_id = _keeper WHERE rep_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_comm_notes := c_comm_notes + _n;

    UPDATE public.production_job_overrides SET set_by = _keeper WHERE set_by = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_overrides := c_overrides + _n;

    UPDATE public.house_notes SET author_id = _keeper WHERE author_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_house_notes := c_house_notes + _n;

    UPDATE public.zip_assignments SET
      captain_id  = CASE WHEN captain_id  = _loser THEN _keeper ELSE captain_id  END,
      assigned_by = CASE WHEN assigned_by = _loser THEN _keeper ELSE assigned_by END
    WHERE captain_id = _loser OR assigned_by = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_zip := c_zip + _n;

    UPDATE public.profiles SET van_locked_by = _keeper WHERE van_locked_by = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_van_lock := c_van_lock + _n;

    -- canvasser_photos: PK profile_id, name_norm is the UI join key.
    -- Approved cartoon art wins; otherwise the keeper's row does.
    IF EXISTS (SELECT 1 FROM public.canvasser_photos WHERE profile_id = _keeper) THEN
      IF EXISTS (SELECT 1 FROM public.canvasser_photos
                 WHERE profile_id = _loser AND cartoon_status = 'approved')
         AND NOT EXISTS (SELECT 1 FROM public.canvasser_photos
                 WHERE profile_id = _keeper AND cartoon_status = 'approved') THEN
        DELETE FROM public.canvasser_photos WHERE profile_id = _keeper;
        UPDATE public.canvasser_photos
        SET profile_id = _keeper,
            name = _keeper_row.display_name,
            name_norm = _keeper_norm,
            updated_at = now()
        WHERE profile_id = _loser;
        GET DIAGNOSTICS _n = ROW_COUNT; c_photos := c_photos + _n;
      ELSE
        DELETE FROM public.canvasser_photos WHERE profile_id = _loser;
      END IF;
    ELSE
      UPDATE public.canvasser_photos
      SET profile_id = _keeper,
          name = _keeper_row.display_name,
          name_norm = _keeper_norm,
          updated_at = now()
      WHERE profile_id = _loser;
      GET DIAGNOSTICS _n = ROW_COUNT; c_photos := c_photos + _n;
    END IF;

    -- kombat_rep_aliases: PK profile_id — keeper's mapping wins.
    IF EXISTS (SELECT 1 FROM public.kombat_rep_aliases WHERE profile_id = _keeper) THEN
      DELETE FROM public.kombat_rep_aliases WHERE profile_id = _loser;
    ELSE
      UPDATE public.kombat_rep_aliases SET profile_id = _keeper, updated_at = now()
      WHERE profile_id = _loser;
      GET DIAGNOSTICS _n = ROW_COUNT; c_kombat_alias := c_kombat_alias + _n;
    END IF;

    -- purpose_profiles: UNIQUE user_id. Children follow via the ON UPDATE
    -- CASCADE FKs installed above. When the keeper already answered, the
    -- loser's reflections stay on the archived row (auth-backed losers are
    -- archived, never deleted) and the skip is reported — merging two sets of
    -- personal answers is a human call, not SQL's.
    IF EXISTS (SELECT 1 FROM public.purpose_profiles WHERE user_id = _loser) THEN
      IF EXISTS (SELECT 1 FROM public.purpose_profiles WHERE user_id = _keeper) THEN
        _purpose_skipped := _purpose_skipped || _loser;
      ELSE
        UPDATE public.purpose_profiles SET user_id = _keeper WHERE user_id = _loser;
        GET DIAGNOSTICS _n = ROW_COUNT; c_purpose := c_purpose + _n;
      END IF;
    END IF;
    UPDATE public.purpose_leadership_notes SET author_user_id = _keeper
    WHERE author_user_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_purpose_notes := c_purpose_notes + _n;
    UPDATE public.purpose_safety_flags SET
      acknowledged_by = CASE WHEN acknowledged_by = _loser THEN _keeper ELSE acknowledged_by END,
      cleared_by      = CASE WHEN cleared_by      = _loser THEN _keeper ELSE cleared_by      END
    WHERE acknowledged_by = _loser OR cleared_by = _loser;

    -- ── auth.users-keyed tables ─────────────────────────────────────────────
    -- The direction guard above means these can only have loser rows when the
    -- keeper is auth-backed too; for placeholder losers they are no-ops.

    -- canvasser_stats: SUM on (user_id, period, period_start) collision.
    UPDATE public.canvasser_stats k SET
      doors_knocked     = k.doors_knocked     + l.doors_knocked,
      contacts_made     = k.contacts_made     + l.contacts_made,
      sales_closed      = k.sales_closed      + l.sales_closed,
      revenue_generated = k.revenue_generated + l.revenue_generated
    FROM public.canvasser_stats l
    WHERE k.user_id = _keeper AND l.user_id = _loser
      AND k.period = l.period AND k.period_start = l.period_start;
    GET DIAGNOSTICS _n = ROW_COUNT; c_stats := c_stats + _n;
    DELETE FROM public.canvasser_stats l
    WHERE l.user_id = _loser AND EXISTS (
      SELECT 1 FROM public.canvasser_stats k
      WHERE k.user_id = _keeper AND k.period = l.period
        AND k.period_start = l.period_start);
    UPDATE public.canvasser_stats SET user_id = _keeper WHERE user_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_stats := c_stats + _n;

    -- time_entries: one OPEN entry per user — if both are clocked in,
    -- close the loser's at now() (the billable trigger prices it).
    IF EXISTS (SELECT 1 FROM public.time_entries WHERE user_id = _keeper AND clock_out IS NULL) THEN
      UPDATE public.time_entries SET clock_out = now()
      WHERE user_id = _loser AND clock_out IS NULL;
    END IF;
    UPDATE public.time_entries SET user_id = _keeper WHERE user_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_time := c_time + _n;

    -- meal_periods ride with their time entries.
    UPDATE public.meal_periods SET user_id = _keeper WHERE user_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_meals := c_meals + _n;

    -- canvasser_badges: PK (user_id, badge_id) — a trophy is earned once;
    -- keep the earliest earn and whether its unlock animation ever played.
    UPDATE public.canvasser_badges k SET
      earned_at = least(k.earned_at, l.earned_at),
      seen      = k.seen OR l.seen
    FROM public.canvasser_badges l
    WHERE k.user_id = _keeper AND l.user_id = _loser AND k.badge_id = l.badge_id;
    GET DIAGNOSTICS _n = ROW_COUNT; c_badges := c_badges + _n;
    DELETE FROM public.canvasser_badges l
    WHERE l.user_id = _loser AND EXISTS (
      SELECT 1 FROM public.canvasser_badges k
      WHERE k.user_id = _keeper AND k.badge_id = l.badge_id);
    UPDATE public.canvasser_badges SET user_id = _keeper WHERE user_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_badges := c_badges + _n;

    -- time_week_attestations: one ACTIVE per (user, week) — when both sides
    -- signed the same week, the loser's becomes a superseded prior version.
    UPDATE public.time_week_attestations l SET superseded_at = now()
    WHERE l.user_id = _loser AND l.superseded_at IS NULL AND EXISTS (
      SELECT 1 FROM public.time_week_attestations k
      WHERE k.user_id = _keeper AND k.week_start = l.week_start
        AND k.superseded_at IS NULL);
    UPDATE public.time_week_attestations SET user_id = _keeper WHERE user_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_attest := c_attest + _n;

    -- time_clock_exceptions: one ACTIVE per (user, date) — revoke the
    -- loser's colliding pass; the keeper's grant covers the day.
    UPDATE public.time_clock_exceptions l SET revoked_at = now()
    WHERE l.user_id = _loser AND l.revoked_at IS NULL AND EXISTS (
      SELECT 1 FROM public.time_clock_exceptions k
      WHERE k.user_id = _keeper AND k.exception_date = l.exception_date
        AND k.revoked_at IS NULL);
    UPDATE public.time_clock_exceptions SET user_id = _keeper WHERE user_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_exceptions := c_exceptions + _n;

    -- day_off_requests: one ACTIVE per (user, date) — cancel the loser's
    -- colliding request (the keeper's stands).
    UPDATE public.day_off_requests l
    SET status = 'cancelled', cancelled_at = now()
    WHERE l.user_id = _loser AND l.status IN ('pending', 'approved') AND EXISTS (
      SELECT 1 FROM public.day_off_requests k
      WHERE k.user_id = _keeper AND k.absence_date = l.absence_date
        AND k.status IN ('pending', 'approved'));
    UPDATE public.day_off_requests SET user_id = _keeper WHERE user_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_dayoff := c_dayoff + _n;

    -- respawn_requests: UNIQUE (user_id, week_start) — keeper's wins; moved
    -- rows take the keeper's name snapshot.
    DELETE FROM public.respawn_requests l
    WHERE l.user_id = _loser AND EXISTS (
      SELECT 1 FROM public.respawn_requests k
      WHERE k.user_id = _keeper AND k.week_start = l.week_start);
    UPDATE public.respawn_requests
    SET user_id = _keeper, rep_name = _keeper_row.display_name, updated_at = now()
    WHERE user_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_respawn := c_respawn + _n;

    -- sick_leave_ledger: one ACCRUAL per (user, week) — the person earned
    -- hours across both logins, so colliding accruals SUM; usage/adjustment
    -- rows move as-is.
    UPDATE public.sick_leave_ledger k SET hours = k.hours + l.hours
    FROM public.sick_leave_ledger l
    WHERE k.user_id = _keeper AND l.user_id = _loser
      AND k.kind = 'accrual' AND l.kind = 'accrual'
      AND k.week_start = l.week_start;
    GET DIAGNOSTICS _n = ROW_COUNT; c_sick := c_sick + _n;
    DELETE FROM public.sick_leave_ledger l
    WHERE l.user_id = _loser AND l.kind = 'accrual' AND EXISTS (
      SELECT 1 FROM public.sick_leave_ledger k
      WHERE k.user_id = _keeper AND k.kind = 'accrual'
        AND k.week_start = l.week_start);
    UPDATE public.sick_leave_ledger SET user_id = _keeper WHERE user_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_sick := c_sick + _n;

    -- Devices keep receiving pushes; proofs keep their review state.
    UPDATE public.push_subscriptions SET user_id = _keeper WHERE user_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_push := c_push + _n;
    UPDATE public.contest_proofs SET rep_id = _keeper WHERE rep_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_proofs := c_proofs + _n;

    UPDATE public.objection_attempts SET canvasser_id = _keeper WHERE canvasser_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_obj := c_obj + _n;

    UPDATE public.hype_events
    SET canvasser_id = _keeper, canvasser_name = _keeper_row.display_name
    WHERE canvasser_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_hype := c_hype + _n;

    UPDATE public.teams SET captain_id = _keeper WHERE captain_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_teams := c_teams + _n;

    -- Roles: keeper keeps its own; the loser's are dropped. No auto-grant —
    -- role changes stay owner-only (set_user_role, 2026-08-12 decision).
    DELETE FROM public.user_roles WHERE user_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_roles := c_roles + _n;

    -- Chained merges: aliases that pointed at the loser follow the keeper,
    -- and merged_into chains collapse to the final keeper.
    UPDATE public.canvasser_aliases SET profile_id = _keeper, updated_at = now()
    WHERE profile_id = _loser;
    GET DIAGNOSTICS _n = ROW_COUNT; c_alias_repointed := c_alias_repointed + _n;
    UPDATE public.profiles SET merged_into = _keeper WHERE merged_into = _loser;

    -- Record the loser's name as an alias of the keeper (before the loser
    -- row is renamed/deleted below).
    IF _loser_norm <> _keeper_norm THEN
      _res := public.record_canvasser_alias(
        _loser_norm, _loser_row.display_name, _keeper, 'merge', _caller, _losers);
      IF _res = 'recorded' THEN
        _aliases := _aliases || jsonb_build_object('alias', _loser_row.display_name);
      ELSE
        _alias_skipped := _alias_skipped
          || jsonb_build_object('alias', _loser_row.display_name, 'reason', _res);
      END IF;
    END IF;

    -- Loser cleanup. No auth user → hard delete (everything movable already
    -- moved; remaining FKs cascade nothing). Auth-backed → archive + suffix
    -- the name so the edge matcher's exact tier (which has NO is_active
    -- filter) can never hit it again; the alias shields the old exact name
    -- regardless.
    IF NOT _loser_auth THEN
      DELETE FROM public.profiles WHERE id = _loser;
      _deleted := _deleted || _loser;
    ELSE
      UPDATE public.profiles SET
        is_active = false,
        team_id = NULL,
        merged_into = _keeper,
        display_name = CASE WHEN display_name LIKE '% (merged)'
                            THEN display_name
                            ELSE display_name || ' (merged)' END,
        updated_at = now()
      WHERE id = _loser;
      _archived := _archived || _loser;
    END IF;
  END LOOP;

  -- Surviving name, when the caller wants the OTHER side's (or any explicit)
  -- name on the merged identity. rename_canvasser re-validates (pseudo names
  -- refused, privileged targets owner-only), records the keeper's old name
  -- as an alias, clears aliases shadowing the new one, and syncs
  -- hype_events — all inside this same transaction. Advisory locks are
  -- reentrant here.
  IF _keep_name IS NOT NULL
     AND public.normalize_display_name(_keep_name) <> _keeper_norm THEN
    _rename_result := public.rename_canvasser(ARRAY[_keeper], _keep_name);
  END IF;

  -- Keeper's rank/rolling stats derive from daily_logs — refresh, best
  -- effort (the pay engine sets its own guard flag internally).
  BEGIN
    PERFORM public.refresh_canvasser_rank(_keeper);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'keeper', _keeper,
    'keeper_auth_backed', _keeper_auth,
    'losers_archived', to_jsonb(_archived),
    'losers_deleted', to_jsonb(_deleted),
    'aliases_added', _aliases,
    'aliases_skipped', _alias_skipped,
    'aliases_cleared', c_alias_cleared,
    'purpose_left_on_archived', to_jsonb(_purpose_skipped),
    'keep_name_result', _rename_result,
    'moved', jsonb_build_object(
      'daily_logs', c_daily_logs,
      'daily_metrics', c_daily_metrics,
      'leads', c_leads,
      'lead_events', c_lead_events,
      'field_pins', c_field_pins,
      'territories', c_territories,
      'turfs', c_turfs,
      'turf_assignment_history', c_turf_hist,
      'canvasser_stats', c_stats,
      'time_entries', c_time,
      'objection_attempts', c_obj,
      'hype_events', c_hype,
      'teams_captaincy', c_teams,
      'aliases_repointed', c_alias_repointed,
      'roles_dropped', c_roles,
      'canvasser_badges', c_badges,
      'gratitude_entries', c_gratitude,
      'activity_tests', c_activity,
      'rep_job_visits', c_visits,
      'rep_commission_notes', c_comm_notes,
      'production_job_overrides', c_overrides,
      'house_notes', c_house_notes,
      'zip_assignments', c_zip,
      'canvasser_photos', c_photos,
      'kombat_rep_aliases', c_kombat_alias,
      'purpose_profiles', c_purpose,
      'purpose_leadership_notes', c_purpose_notes,
      'meal_periods', c_meals,
      'time_week_attestations', c_attest,
      'time_clock_exceptions', c_exceptions,
      'day_off_requests', c_dayoff,
      'respawn_requests', c_respawn,
      'sick_leave_ledger', c_sick,
      'push_subscriptions', c_push,
      'contest_proofs', c_proofs,
      'van_locks', c_van_lock
    )
  );
END $$;
REVOKE ALL ON FUNCTION public.merge_canvassers(uuid[], uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_canvassers(uuid[], uuid, text) TO authenticated, service_role;

-- ── 5) rename_canvasser v2: non_person refusal + the same service-caller rule
CREATE OR REPLACE FUNCTION public.rename_canvasser(_ids uuid[], _new_name text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _caller uuid := auth.uid();
  _caller_is_owner boolean;
  _new_raw text;
  _new_norm text := public.normalize_display_name(_new_name);
  _ids_d uuid[];
  _n int;
  _renamed int := 0;
  _cleared int := 0;
  _collisions uuid[];
  _old record;
  _res text;
  _aliases jsonb := '[]'::jsonb;
  _skipped jsonb := '[]'::jsonb;
BEGIN
  -- NULL caller = service_role or the SQL editor (see merge_canvassers v2).
  IF _caller IS NULL THEN
    _caller_is_owner := true;
  ELSE
    _caller_is_owner := public.has_role(_caller, 'owner'::app_role);
    IF NOT (
      _caller_is_owner
      OR public.has_role(_caller, 'captain'::app_role)
      OR public.has_role(_caller, 'office_staff'::app_role)
    ) THEN
      RAISE EXCEPTION 'Only Owners, Captains, or Admins can rename canvassers';
    END IF;
  END IF;

  -- Raw form keeps the caller's casing but collapses the same whitespace the
  -- normalizer folds, so display and norm can never disagree on word breaks.
  _new_raw := btrim(
    regexp_replace(
      COALESCE(_new_name, ''),
      '[[:space:]   -     　﻿]+',
      ' ',
      'g'
    ),
    ' '
  );
  IF _new_norm = '' THEN RAISE EXCEPTION 'New name cannot be empty'; END IF;
  IF length(_new_raw) > 80 THEN RAISE EXCEPTION 'New name is too long'; END IF;
  IF public.is_pseudo_source_name(_new_norm) THEN
    RAISE EXCEPTION 'That name is reserved for a lead-source channel';
  END IF;

  SELECT array_agg(DISTINCT u) INTO _ids_d FROM unnest(COALESCE(_ids, '{}'::uuid[])) u;
  IF _ids_d IS NULL THEN RAISE EXCEPTION 'No profiles selected'; END IF;

  -- Serialize with merges (and other renames) so alias bookkeeping can't race.
  PERFORM pg_advisory_xact_lock(hashtext('canvasser_identity'));

  SELECT count(*) INTO _n FROM public.profiles WHERE id = ANY (_ids_d);
  IF _n <> array_length(_ids_d, 1) THEN
    RAISE EXCEPTION 'Unknown profile in selection';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = ANY (_ids_d) AND public.is_pseudo_source_name(display_name)
  ) THEN
    RAISE EXCEPTION 'Lead-source channels cannot be renamed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = ANY (_ids_d) AND COALESCE(non_person, false)
  ) THEN
    RAISE EXCEPTION 'Non-person rows cannot be renamed';
  END IF;
  IF NOT _caller_is_owner AND EXISTS (
    SELECT 1 FROM unnest(_ids_d) u WHERE public.is_privileged_account(u)
  ) THEN
    RAISE EXCEPTION 'Only Owners can rename Admin accounts';
  END IF;

  SELECT array_agg(p.id) INTO _collisions
  FROM public.profiles p
  WHERE public.normalize_display_name(p.display_name) = _new_norm
    AND NOT (p.id = ANY (_ids_d));

  -- The renamed profiles are now live bearers of the new name — any alias
  -- still claiming it must go, or the matcher would keep routing the name
  -- to the alias target instead of them.
  DELETE FROM public.canvasser_aliases WHERE alias_norm = _new_norm;
  GET DIAGNOSTICS _cleared = ROW_COUNT;

  -- One alias per distinct OLD name, pointed at its best bearer:
  -- auth-backed first, then non-placeholder, then oldest.
  FOR _old IN
    SELECT DISTINCT ON (public.normalize_display_name(p.display_name))
           public.normalize_display_name(p.display_name) AS norm,
           p.display_name AS raw,
           p.id
    FROM public.profiles p
    WHERE p.id = ANY (_ids_d)
    ORDER BY public.normalize_display_name(p.display_name),
             (EXISTS (SELECT 1 FROM auth.users au WHERE au.id = p.id)) DESC,
             p.is_placeholder ASC,
             p.created_at ASC
  LOOP
    IF _old.norm = _new_norm THEN CONTINUE; END IF;
    _res := public.record_canvasser_alias(_old.norm, _old.raw, _old.id, 'rename', _caller, _ids_d);
    IF _res = 'recorded' THEN
      _aliases := _aliases || jsonb_build_object('alias', _old.raw, 'target', _old.id);
    ELSE
      _skipped := _skipped || jsonb_build_object('alias', _old.raw, 'reason', _res);
    END IF;
  END LOOP;

  UPDATE public.profiles
  SET display_name = _new_raw, updated_at = now()
  WHERE id = ANY (_ids_d);
  GET DIAGNOSTICS _renamed = ROW_COUNT;

  -- Denormalized ticker names follow the person.
  UPDATE public.hype_events SET canvasser_name = _new_raw
  WHERE canvasser_id = ANY (_ids_d);

  RETURN jsonb_build_object(
    'renamed', _renamed,
    'new_name', _new_raw,
    'aliases_recorded', _aliases,
    'aliases_skipped', _skipped,
    'aliases_cleared', _cleared,
    'name_collision_ids', to_jsonb(COALESCE(_collisions, '{}'::uuid[]))
  );
END $$;
REVOKE ALL ON FUNCTION public.rename_canvasser(uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rename_canvasser(uuid[], text) TO authenticated, service_role;
