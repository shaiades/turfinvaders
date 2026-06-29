import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { StatCard, ArcadePanel, TeamBadge } from "@/components/arcade";

export const Route = createFileRoute("/_authenticated/teams/$teamId")({
  head: () => ({ meta: [{ title: "Van — Knockout" }] }),
  component: TeamDetail,
});

function TeamDetail() {
  const { teamId } = Route.useParams();

  const { data, isLoading } = useQuery({
    queryKey: ["team_detail", teamId],
    queryFn: async () => {
      const [teamR, profilesR, logsR] = await Promise.all([
        supabase.from("teams").select("id, name, color, captain_id").eq("id", teamId).maybeSingle(),
        supabase.from("profiles").select("id, display_name, team_id").eq("team_id", teamId),
        supabase.from("daily_logs").select("canvasser_id, demos_sits, sales, no_demo, one_legs, future_leads").eq("team_id", teamId),
      ]);
      const team = teamR.data;
      if (!team) return null;
      const captainName = team.captain_id
        ? (await supabase.from("profiles").select("display_name").eq("id", team.captain_id).maybeSingle()).data?.display_name ?? "—"
        : "—";

      const agg = new Map<string, { leads: number; sales: number; sits: number }>();
      for (const l of logsR.data ?? []) {
        const a = agg.get(l.canvasser_id) ?? { leads: 0, sales: 0, sits: 0 };
        a.leads += (l.demos_sits ?? 0) + (l.sales ?? 0) + (l.no_demo ?? 0) + (l.one_legs ?? 0) + (l.future_leads ?? 0);
        a.sales += l.sales ?? 0;
        a.sits += l.demos_sits ?? 0;
        agg.set(l.canvasser_id, a);
      }
      const members = (profilesR.data ?? []).map((p) => {
        const a = agg.get(p.id) ?? { leads: 0, sales: 0, sits: 0 };
        return { id: p.id, name: p.display_name ?? "Unknown", ...a, points: a.sits + a.sales * 2 };
      }).sort((a, b) => b.points - a.points);

      const totals = members.reduce((acc, m) => ({
        leads: acc.leads + m.leads, sales: acc.sales + m.sales, sits: acc.sits + m.sits,
      }), { leads: 0, sales: 0, sits: 0 });

      return { team: { ...team, color: team.color ?? "#00f0ff", captainName }, members, totals };
    },
  });

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!data) {
    return (
      <div className="space-y-4">
        <Link to="/teams" className="text-xs text-muted-foreground hover:text-neon">← All Vans</Link>
        <div className="arcade-card p-6 text-sm text-muted-foreground">This Van no longer exists. It may have been deleted.</div>
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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Leads" value={totals.leads.toLocaleString()} accent="neon" />
        <StatCard label="Sits" value={totals.sits.toLocaleString()} accent="accent" />
        <StatCard label="Sales" value={totals.sales.toLocaleString()} accent="victory" />
        <StatCard label="Crew" value={String(members.length)} accent="warning" />
      </div>

      <ArcadePanel title="Roster">
        {members.length === 0 ? (
          <div className="text-sm text-muted-foreground">No canvassers assigned to this Van yet.</div>
        ) : (
          <ol className="divide-y divide-border">
            {members.map((m, i) => (
              <li key={m.id} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <span className="font-display text-xs text-muted-foreground w-6">{String(i + 1).padStart(2, "0")}</span>
                  <Link to="/canvassers/$canvasserId" params={{ canvasserId: m.id }} className="font-medium hover:text-neon">{m.name}</Link>
                </div>
                <div className="flex items-center gap-5 text-xs text-muted-foreground">
                  <span>{m.leads} leads</span>
                  <span>{m.sales} sales</span>
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
