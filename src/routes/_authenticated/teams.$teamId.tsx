import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { StatCard, ArcadePanel, TeamBadge, ArcadeCard } from "@/components/arcade";
import { MANAGER_ROLES, requireRoleBeforeLoad } from "@/lib/roles";
import { useDateRange } from "@/hooks/useDateRange";
import { RangeTabs } from "@/components/RangeTabs";
import { normalizeName } from "@/lib/utils";
import { FormerBadge } from "@/components/FormerBadge";

export const Route = createFileRoute("/_authenticated/teams/$teamId")({
  head: () => ({ meta: [{ title: "Van — Knockout" }] }),
  // Leadership-only: canvassers/sales reps bounce in beforeLoad (real DB
  // roles), before the page mounts or fires any queries.
  beforeLoad: requireRoleBeforeLoad(MANAGER_ROLES),
  component: TeamDetail,
});

function TeamDetail() {
  const { teamId } = Route.useParams();
  // Day / Week / Month selector — was an unbounded all-time aggregate before
  // 2026-08-12; defaults to the pay week like the rest of the manager suite.
  const rangeControls = useDateRange({ initialTab: "week" });
  const { range } = rangeControls;

  const { data } = useQuery({
    queryKey: ["team_detail", teamId, range.startISO, range.endISO],
    // Keep the page (and the range selector) mounted while a new range loads.
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const [teamR, profilesR, logsR, rolesR] = await Promise.all([
        supabase.from("teams").select("id, name, color").eq("id", teamId).maybeSingle(),
        supabase.from("profiles").select("id, display_name, team_id").eq("team_id", teamId),
        supabase
          .from("daily_logs")
          .select("canvasser_id, demos_sits, sales, no_demo, one_legs, future_leads")
          .eq("team_id", teamId)
          .gte("log_date", range.startISO)
          .lte("log_date", range.endISO),
        supabase.from("user_roles").select("user_id").eq("role", "captain"),
      ]);
      const team = teamR.data;
      if (!team) return null;
      // The current/former partition below depends on both fetches — a
      // failed profiles query would silently tag the whole roster Former.
      if (profilesR.error) throw profilesR.error;
      if (logsR.error) throw logsR.error;
      // Captain label = member(s) of this van holding the captain role.
      // teams.captain_id is seed-era data with no UI writer — never label from
      // it. Deduped by normalizeName: same-name duplicate profiles are normal.
      const captainIds = new Set((rolesR.data ?? []).map((r) => r.user_id));
      const seenCaptainKeys = new Set<string>();
      const captainName =
        (profilesR.data ?? [])
          .filter((p) => {
            if (!captainIds.has(p.id)) return false;
            const key = normalizeName(p.display_name) || `id:${p.id}`;
            if (seenCaptainKeys.has(key)) return false;
            seenCaptainKeys.add(key);
            return true;
          })
          .map((p) => p.display_name ?? "—")
          .sort()
          .join(" · ") || "—";

      const agg = new Map<string, { leads: number; sales: number; sits: number }>();
      for (const l of logsR.data ?? []) {
        const a = agg.get(l.canvasser_id) ?? { leads: 0, sales: 0, sits: 0 };
        a.leads += (l.demos_sits ?? 0) + (l.sales ?? 0) + (l.no_demo ?? 0) + (l.one_legs ?? 0) + (l.future_leads ?? 0);
        a.sales += l.sales ?? 0;
        a.sits += l.demos_sits ?? 0;
        agg.set(l.canvasser_id, a);
      }
      // The log fetch filters on the row SNAPSHOT team_id, so people who
      // have since left the van still contribute rows. List them (tagged
      // former) instead of discarding their production — van history must
      // not shrink when someone is removed (owner, 2026-08-27).
      const currentIds = new Set((profilesR.data ?? []).map((p) => p.id));
      const formerIds = [...agg.keys()].filter((id) => !currentIds.has(id));
      const formerNames = new Map<string, string | null>();
      if (formerIds.length > 0) {
        const formerR = await supabase
          .from("profiles")
          .select("id, display_name")
          .in("id", formerIds);
        // Throw, don't degrade: silently dropping former members would shrink
        // the totals — the exact mismatch this fetch exists to prevent.
        if (formerR.error) throw formerR.error;
        for (const p of formerR.data ?? []) formerNames.set(p.id, p.display_name);
      }
      const members = [
        ...(profilesR.data ?? []).map((p) => {
          const a = agg.get(p.id) ?? { leads: 0, sales: 0, sits: 0 };
          return {
            id: p.id,
            name: p.display_name ?? "Unknown",
            ...a,
            points: a.sits + a.sales * 2,
            former: false,
          };
        }),
        // Only ids with a surviving profile row join the list; hard-deleted
        // ghosts stay out, exactly as before.
        ...formerIds
          .filter((id) => formerNames.has(id))
          .map((id) => {
            const a = agg.get(id) ?? { leads: 0, sales: 0, sits: 0 };
            return {
              id,
              name: formerNames.get(id) ?? "Former agent",
              ...a,
              points: a.sits + a.sales * 2,
              former: true,
            };
          }),
      ].sort((a, b) => b.points - a.points);

      // Totals fold from data rows via the member list (former included), so
      // this page agrees with the /teams index card for the same van/range.
      const totals = members.reduce((acc, m) => ({
        leads: acc.leads + m.leads, sales: acc.sales + m.sales, sits: acc.sits + m.sits,
      }), { leads: 0, sales: 0, sits: 0 });

      return { team: { ...team, color: team.color ?? "#00f0ff", captainName }, members, totals };
    },
  });

  // undefined = first load (no placeholder yet); null = team really missing.
  if (data === undefined) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (data === null) {
    return (
      <div className="space-y-4">
        <Link to="/teams" className="text-xs text-muted-foreground hover:text-neon">
          ← All Vans
        </Link>
        <ArcadeCard className="p-6 text-sm text-muted-foreground">
          This Van no longer exists. It may have been deleted.
        </ArcadeCard>
      </div>
    );
  }
  const { team, members, totals } = data;

  return (
    <div className="space-y-8">
      <div>
        <Link to="/teams" className="text-xs text-muted-foreground hover:text-neon">← All Vans</Link>
        <div className="mt-3 flex items-center gap-3">
          <TeamBadge name={team.name} color={team.color} />
          <span className="text-xs text-muted-foreground">Captain · <span className="text-foreground">{team.captainName}</span></span>
        </div>
      </div>

      <RangeTabs controls={rangeControls} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Leads"
          value={totals.leads.toLocaleString()}
          sublabel={range.label}
          accent="neon"
        />
        <StatCard
          label="Sits"
          value={totals.sits.toLocaleString()}
          sublabel={range.label}
          accent="accent"
        />
        <StatCard
          label="Sales"
          value={totals.sales.toLocaleString()}
          sublabel={range.label}
          accent="victory"
        />
        {/* Crew stays a CURRENT headcount (matches the /teams index card);
            former members appear below only for their in-range history. */}
        <StatCard
          label="Crew"
          value={String(members.filter((m) => !m.former).length)}
          accent="warning"
        />
      </div>

      <ArcadePanel title="Roster">
        {members.length === 0 ? (
          <div className="text-sm text-muted-foreground">No canvassers assigned to this Van yet.</div>
        ) : (
          <ol className="divide-y divide-border">
            {members.map((m, i) => (
              <li key={m.id} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-display text-xs text-muted-foreground w-6">{String(i + 1).padStart(2, "0")}</span>
                  <Link to="/canvassers/$canvasserId" params={{ canvasserId: m.id }} className="font-medium hover:text-neon min-w-0 truncate">{m.name}</Link>
                  {m.former && <FormerBadge />}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{m.leads}<span className="hidden sm:inline"> leads</span></span>
                  <span>{m.sales}<span className="hidden sm:inline"> sales</span></span>
                  <span className="text-victory">{m.points} pts</span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </ArcadePanel>
    </div>
  );
}
