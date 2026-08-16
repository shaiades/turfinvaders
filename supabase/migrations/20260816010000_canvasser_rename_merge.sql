-- Canvasser identity management: rename + merge for the results surfaces.
-- Managers (owner/captain/office_staff) can rename a canvasser and merge
-- duplicate identities ("Jonathan H" == "Jonathan Hanna" — the Bouncer in
-- monday-live-dispatch mints a placeholder profile per unmatched name
-- variant, so one person can span several profile rows). Every old name is
-- recorded in canvasser_aliases so the edge function routes future Monday
-- events carrying the old name to the keeper instead of re-minting a
-- duplicate (the matcher tries exact profile match, THEN aliases, then the
-- fuzzy tiers; edge redeploy required). Close Kombat's block_cards.reps
-- (raw Monday name text) is deliberately untouched — sales-rep standings
-- follow Monday, not profiles.
--
-- Apply by hand in the Supabase dashboard SQL editor. Idempotent — safe to
-- re-paste. Runs AFTER 20260803010000 (is_privileged_account),
-- 20260728020000 (daily_logs 3-col unique key), 20260815020000
-- (turf triggers / turf_assignment_history).

-- ── 0) Name normalizer + pseudo-source guard ────────────────────────────────
-- SQL twin of normalizeName in monday-live-dispatch/index.ts and
-- src/lib/utils.ts — trim, lowercase, collapse internal whitespace. The
-- character class mirrors JavaScript's \s (POSIX [[:space:]] alone misses
-- NBSP and the other Unicode spaces Monday paste-ins carry, which would
-- desync the twins and strand unmatchable aliases).
CREATE OR REPLACE FUNCTION public.normalize_display_name(_s text)
RETURNS text LANGUAGE sql IMMUTABLE
AS $$
  SELECT lower(btrim(
    regexp_replace(
      COALESCE(_s, ''),
      '[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+',
      ' ',
      'g'
    ),
    ' '
  ))
$$;
REVOKE ALL ON FUNCTION public.normalize_display_name(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.normalize_display_name(text) TO authenticated, service_role;

-- Pseudo lead-source channels: the SOURCE_FALLBACKS credited-as names in
-- monday-live-dispatch/index.ts plus the names seeded off the suspension
-- donut in 20260729010000. EXTEND THIS LIST in the same PR as any
-- SOURCE_FALLBACKS addition (src/lib/lead-sources.ts is the client twin).
-- suspension_tracked=false is NOT used as the marker — the suspension ✕ in
-- the UI also clears it on real people.
CREATE OR REPLACE FUNCTION public.is_pseudo_source_name(_name text)
RETURNS boolean LANGUAGE sql IMMUTABLE
AS $$
  SELECT public.normalize_display_name(_name) IN (
    'self gen', 'job walk', 'reload', 'upsell',
    'rehash / cynthia king', 'referral', 'ryan appointinator'
  )
$$;
REVOKE ALL ON FUNCTION public.is_pseudo_source_name(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_pseudo_source_name(text) TO authenticated, service_role;

-- ── 1) Alias table + merge provenance ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.canvasser_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alias_norm text NOT NULL,                 -- normalized old name (lookup key)
  alias_raw text NOT NULL,                  -- the display name as it was
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'rename' CHECK (source IN ('rename', 'merge')),
  created_by uuid,                          -- acting manager; no FK (house pattern)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canvasser_aliases_norm_uk UNIQUE (alias_norm),
  CONSTRAINT canvasser_aliases_norm_is_normalized
    CHECK (alias_norm = public.normalize_display_name(alias_norm) AND alias_norm <> ''),
  CONSTRAINT canvasser_aliases_norm_not_pseudo
    CHECK (NOT public.is_pseudo_source_name(alias_norm))
);
CREATE INDEX IF NOT EXISTS canvasser_aliases_profile_idx
  ON public.canvasser_aliases (profile_id);

GRANT SELECT ON public.canvasser_aliases TO authenticated;
GRANT ALL ON public.canvasser_aliases TO service_role;
ALTER TABLE public.canvasser_aliases ENABLE ROW LEVEL SECURITY;

-- Manager-tier read only. Deliberately NO authenticated write policies:
-- aliases are written exclusively by the SECURITY DEFINER RPCs below and by
-- service_role (the edge function reads via service key anyway).
DROP POLICY IF EXISTS "Managers read canvasser aliases" ON public.canvasser_aliases;
CREATE POLICY "Managers read canvasser aliases"
  ON public.canvasser_aliases FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner'::app_role)
    OR public.has_role(auth.uid(), 'captain'::app_role)
    OR public.has_role(auth.uid(), 'office_staff'::app_role)
  );

DROP TRIGGER IF EXISTS canvasser_aliases_touch ON public.canvasser_aliases;
CREATE TRIGGER canvasser_aliases_touch BEFORE UPDATE ON public.canvasser_aliases
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Where an archived (auth-backed) loser went — enables chained-merge
-- collapse and repair queries after a merge raced an in-flight webhook.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS merged_into uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ── 2) Internal alias writer (not directly callable by end users) ───────────
-- Skips empty/pseudo norms, and norms still borne by a profile OUTSIDE the
-- operation (_exclude): the matcher's exact tier still finds that bearer, so
-- an alias would silently steal a different person's credit.
CREATE OR REPLACE FUNCTION public.record_canvasser_alias(
  _norm text, _raw text, _target uuid, _source text, _created_by uuid, _exclude uuid[]
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF _norm IS NULL OR _norm = '' THEN RETURN 'skipped_empty'; END IF;
  IF public.is_pseudo_source_name(_norm) THEN RETURN 'skipped_pseudo'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE public.normalize_display_name(p.display_name) = _norm
      AND NOT (p.id = ANY (COALESCE(_exclude, '{}'::uuid[])))
  ) THEN
    RETURN 'skipped_shared_name';
  END IF;
  INSERT INTO public.canvasser_aliases (alias_norm, alias_raw, profile_id, source, created_by)
  VALUES (_norm, _raw, _target, _source, _created_by)
  ON CONFLICT (alias_norm) DO UPDATE
    SET profile_id = EXCLUDED.profile_id,
        alias_raw  = EXCLUDED.alias_raw,
        source     = EXCLUDED.source,
        created_by = EXCLUDED.created_by,
        updated_at = now();
  RETURN 'recorded';
END $$;
REVOKE ALL ON FUNCTION public.record_canvasser_alias(text, text, uuid, text, uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_canvasser_alias(text, text, uuid, text, uuid, uuid[])
  TO service_role;

-- Hygiene on re-paste: if an earlier paste ran an older normalizer, any
-- alias row it stored that the CURRENT normalizer would write differently
-- is dead for lookups and would trip the CHECK on its next UPDATE — drop
-- such rows (no-op on a fresh apply).
DELETE FROM public.canvasser_aliases
WHERE alias_norm <> public.normalize_display_name(alias_norm);

-- ── 3) rename_canvasser ─────────────────────────────────────────────────────
-- _ids: every profile id grouped under one results-board row (same-name
-- duplicates included — the UI re-resolves the set by normalized name).
-- Renaming onto a name that already belongs to a DIFFERENT profile is
-- ALLOWED (the board groups by name, and that grouping is how a rename
-- doubles as a soft merge); the colliding ids come back in
-- name_collision_ids so the UI can offer a true merge.
-- Any alias that previously claimed the NEW name is deleted: a live profile
-- now bears that name, and a stale alias would silently steal every future
-- Monday card carrying it (aliases outrank the fuzzy tiers in the matcher).
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
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  _caller_is_owner := public.has_role(_caller, 'owner'::app_role);
  IF NOT (
    _caller_is_owner
    OR public.has_role(_caller, 'captain'::app_role)
    OR public.has_role(_caller, 'office_staff'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only Owners, Captains, or Admins can rename canvassers';
  END IF;

  -- Raw form keeps the caller's casing but collapses the same whitespace the
  -- normalizer folds, so display and norm can never disagree on word breaks.
  _new_raw := btrim(
    regexp_replace(
      COALESCE(_new_name, ''),
      '[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+',
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

-- ── 4) merge_canvassers ─────────────────────────────────────────────────────
-- Everything the losers ever produced moves to the keeper; counter tables
-- SUM on unique-key collision (a real person's two profiles can both have
-- rows on the same date). The keeper must hold the login when any loser
-- does: canvasser_stats / time_entries / objection_attempts /
-- hype_events.canvasser_id / teams.captain_id are keyed to auth.users, and
-- absorbing a login account into a placeholder would strand payroll hours
-- and delete the person's roles — the merge refuses and tells the caller to
-- flip the direction (the UI already picks the auth-backed side as keeper).
-- _keep_name: optional display name the merged identity should carry
-- (either side's name) — applied atomically via rename_canvasser, so "which
-- profile keeps the login" and "which name survives" are independent.
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
  _aliases jsonb := '[]'::jsonb;
  _alias_skipped jsonb := '[]'::jsonb;
  _archived uuid[] := '{}'::uuid[];
  _deleted uuid[] := '{}'::uuid[];
  _rename_result jsonb := NULL;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  _caller_is_owner := public.has_role(_caller, 'owner'::app_role);
  IF NOT (
    _caller_is_owner
    OR public.has_role(_caller, 'captain'::app_role)
    OR public.has_role(_caller, 'office_staff'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only Owners, Captains, or Admins can merge canvassers';
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

    -- auth.users-keyed tables. The direction guard above means these can
    -- only have loser rows when the keeper is auth-backed too, so the
    -- repoints below can never trip the auth FK; for placeholder losers
    -- they are no-ops.
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
      'roles_dropped', c_roles
    )
  );
END $$;
-- Drop the pre-fix 2-arg signature if an earlier paste created it, so
-- PostgREST can't route rpc calls ambiguously.
DROP FUNCTION IF EXISTS public.merge_canvassers(uuid[], uuid);
REVOKE ALL ON FUNCTION public.merge_canvassers(uuid[], uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_canvassers(uuid[], uuid, text) TO authenticated, service_role;
