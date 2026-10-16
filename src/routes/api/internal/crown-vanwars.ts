import { createFileRoute } from "@tanstack/react-router";

/**
 * Van Wars Saturday crowning (conversion audit 2026-10-15, Phase 1 §3) —
 * Vercel Cron. The race locks Saturday 6 PM PT: this records the week's
 * champion into vanwars_wins (Wall of Fame), recomputes the monthly Turf
 * King, and announces the crown on the Street Feed (feed_events kind
 * 'crowning' — the feed_push trigger turns that into the "👑 Van Wars
 * champion" push when the owner has pushes on). It replaces the manual
 * captain button, which was routinely forgotten.
 *
 * Scoring is the SAME pure function the field board renders
 * (buildVanWarStandings over the Mon–Sat week ladder): leads set per active
 * knocker, Confirmation desk + Unassigned excluded, 3 active knockers to
 * rank. The two can never disagree.
 *
 * Scheduling: "0 1 * * 0" + "0 2 * * 0" UTC (Sunday UTC = Saturday evening
 * LA) with the LA-time guard keeping exactly one slot live in any DST season
 * (the god-digest doctrine). Idempotent: one row per (week_start, 'week') —
 * a second landing sees the row and skips the feed shout.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>`; `?force=1` (still
 * secret-gated) bypasses the time guard for a manual run.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function handle(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: "CRON_SECRET not configured" }, 500);
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";

  const { LA_TZ } = await import("@/lib/dates");
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: LA_TZ,
      hour: "2-digit",
      hour12: false,
      weekday: "short",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  const laHour = Number(parts.hour === "24" ? "0" : parts.hour);
  if (!force && !(parts.weekday === "Sat" && laHour === 18)) {
    return json({
      skipped: true,
      reason: `LA ${parts.weekday} hour ${laHour}: outside the Saturday 6 PM window`,
    });
  }

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { laWeekStartISO, laMonthStartISO, laMidnightUtcISO, addDaysISO } =
      await import("@/lib/dates");
    const { computeDispatchProduction } = await import("@/lib/dispatch.functions");
    const { buildVanWarStandings } = await import("@/lib/vanwars");

    const week = laWeekStartISO();

    // Idempotence: crowned already (a retry or the second DST slot) → done.
    const { data: existing } = await supabaseAdmin
      .from("vanwars_wins" as never)
      .select("team_name")
      .eq("week_start", week)
      .eq("kind", "week")
      .maybeSingle();
    if (existing) {
      return json({ ok: true, alreadyCrowned: (existing as { team_name: string }).team_name });
    }

    // The same Mon–Sat window the field board's week ladder uses.
    const weekEnd = addDaysISO(week, 5);
    const prod = await computeDispatchProduction({
      log_start: week,
      log_end: weekEnd,
      vol_start: laMidnightUtcISO(week),
      vol_end: laMidnightUtcISO(addDaysISO(weekEnd, 1)),
    });

    const [profilesR, teamsR, captainsR] = await Promise.all([
      supabaseAdmin.from("profiles").select("id, display_name, team_id"),
      supabaseAdmin.from("teams").select("id, name, color"),
      supabaseAdmin.from("user_roles").select("user_id").eq("role", "captain"),
    ]);
    const profById = new Map((profilesR.data ?? []).map((p) => [p.id, p]));
    const teamById = new Map((teamsR.data ?? []).map((t) => [t.id, t]));
    const captainIds = new Set((captainsR.data ?? []).map((r) => r.user_id));
    const captainByTeam: Record<string, string> = {};
    for (const p of profilesR.data ?? []) {
      if (captainIds.has(p.id) && p.team_id && p.display_name && !captainByTeam[p.team_id]) {
        captainByTeam[p.team_id] = String(p.display_name).split(" ")[0];
      }
    }

    // Knocker rows — the server twin of useVanWars' mapping over the ladder
    // (same skip-empty rule as useArcadeLadder; non-person filtering doesn't
    // matter here because channel rows carry no team and Unassigned is
    // excluded by the scorer anyway).
    const ids = new Set<string>([
      ...Object.keys(prod.points ?? {}),
      ...Object.keys(prod.volume ?? {}),
      ...Object.keys(prod.results ?? {}),
    ]);
    const rows = [];
    for (const id of ids) {
      const r = prod.results?.[id];
      const pts = prod.points?.[id] ?? 0;
      const vol = prod.volume?.[id] ?? 0;
      if (pts === 0 && vol === 0 && (r?.lds ?? 0) === 0 && (r?.drs ?? 0) === 0) continue;
      const prof = profById.get(id);
      const teamId = prod.snapshotTeam?.[id] ?? prof?.team_id ?? null;
      const team = teamId ? teamById.get(teamId) : null;
      rows.push({
        teamId: teamId ?? null,
        label: (teamId && captainByTeam[teamId]) || team?.name || "Unassigned",
        teamName: team?.name ?? null,
        teamColor: team?.color ?? null,
        ld: r?.ld ?? 0,
        drs: r?.drs ?? 0,
        pts,
        vol,
        sitSits: prod.funnelSits?.[id] ?? 0,
        sitLeads: prod.funnelLeads?.[id] ?? 0,
      });
    }

    const standings = buildVanWarStandings(rows);
    const champ = standings.find((s) => s.ranked) ?? null;
    if (!champ) {
      await supabaseAdmin.from("webhook_logs").insert({
        step: "VanWars_Crown_Skipped",
        data: { week, reason: "no crew with 3+ active knockers", crews: standings.length },
      });
      return json({ ok: true, crowned: null, reason: "no rankable crew this week" });
    }

    const { error: winErr } = await supabaseAdmin.from("vanwars_wins" as never).upsert(
      {
        week_start: week,
        kind: "week",
        team_id: champ.teamId,
        team_name: champ.name,
        color: champ.color,
        war_score: Number(champ.war.toFixed(1)),
      } as never,
      { onConflict: "week_start,kind" },
    );
    if (winErr) throw new Error(`vanwars_wins upsert: ${winErr.message}`);

    // Monthly Turf King = the crew with the most weekly wins this month
    // (ties: higher summed war score, so a tie can't fall to Map order).
    const month = laMonthStartISO();
    const { data: monthWins } = await supabaseAdmin
      .from("vanwars_wins" as never)
      .select("team_name, color, war_score")
      .eq("kind", "week")
      .gte("week_start", month);
    const tally = new Map<string, { n: number; war: number; color: string | null }>();
    for (const r of (monthWins ?? []) as unknown as Array<{
      team_name: string;
      color: string | null;
      war_score: number | null;
    }>) {
      const cur = tally.get(r.team_name) ?? { n: 0, war: 0, color: r.color };
      cur.n += 1;
      cur.war += Number(r.war_score ?? 0);
      tally.set(r.team_name, cur);
    }
    let king: { name: string; color: string | null } | null = null;
    let best = { n: 0, war: -1 };
    for (const [name, v] of tally) {
      if (v.n > best.n || (v.n === best.n && v.war > best.war)) {
        best = { n: v.n, war: v.war };
        king = { name, color: v.color };
      }
    }
    if (king) {
      const { error: kingErr } = await supabaseAdmin.from("vanwars_wins" as never).upsert(
        {
          week_start: month,
          kind: "king",
          team_name: king.name,
          color: king.color,
          period: month.slice(0, 7),
        } as never,
        { onConflict: "week_start,kind" },
      );
      if (kingErr) throw new Error(`turf king upsert: ${kingErr.message}`);
    }

    // Street Feed shout — the feed_push trigger upgrades it to the
    // "👑 Van Wars champion" push when feed_push is on. Best-effort.
    let feed: string | null = null;
    try {
      const { error: feedErr } = await supabaseAdmin.from("feed_events" as never).insert({
        kind: "crowning",
        actor_name: champ.name,
        color: champ.color,
        body: `${champ.name}'s crew took the week — ${champ.war.toFixed(1)} leads per knocker (${champ.lds} total)`,
      } as never);
      feed = feedErr ? feedErr.message : "sent";
    } catch (e) {
      feed = e instanceof Error ? e.message : String(e);
    }

    await supabaseAdmin.from("webhook_logs").insert({
      step: "VanWars_Crowned",
      data: {
        week,
        champ: champ.name,
        war: Number(champ.war.toFixed(1)),
        lds: champ.lds,
        knockers: champ.knockers,
        king: king?.name ?? null,
        feed,
      },
    });
    return json({ ok: true, crowned: champ.name, war: champ.war, king: king?.name ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.from("webhook_logs").insert({
        step: "VanWars_Crown_Failed",
        data: { error: message } as never,
      });
    } catch {
      /* the log is best-effort — the 500 below still reports */
    }
    return json({ error: message }, 500);
  }
}

export const Route = createFileRoute("/api/internal/crown-vanwars")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});
