import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { DEMO_TEAMS, demoCanvassers, teamTotals, formatCurrency } from "@/lib/demo-data";
import { StatCard, ArcadePanel, TeamBadge } from "@/components/arcade";

export const Route = createFileRoute("/_authenticated/teams/$teamId")({
  head: ({ params }) => {
    const t = DEMO_TEAMS.find((x) => x.id === params.teamId);
    return { meta: [{ title: `${t?.name ?? "Team"} — Knockout` }] };
  },
  component: TeamDetail,
});

function TeamDetail() {
  const { teamId } = Route.useParams();
  const team = DEMO_TEAMS.find((t) => t.id === teamId);
  if (!team) throw notFound();
  const members = demoCanvassers().filter((c) => c.teamId === team.id).sort((a, b) => b.revenueGenerated - a.revenueGenerated);
  const totals = teamTotals(team.id);

  return (
    <div className="space-y-8">
      <div>
        <Link to="/teams" className="text-xs text-muted-foreground hover:text-neon">← All teams</Link>
        <div className="mt-3 flex items-center gap-3">
          <TeamBadge name={team.name} color={team.color} />
          <span className="text-xs text-muted-foreground">Captain · <span className="text-foreground">{team.captain}</span></span>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Revenue" value={formatCurrency(totals.revenue)} accent="victory" />
        <StatCard label="Doors" value={totals.doors.toLocaleString()} accent="neon" />
        <StatCard label="Sales" value={totals.sales.toLocaleString()} accent="accent" />
        <StatCard label="Players" value={totals.members} accent="warning" />
      </div>

      <ArcadePanel title="Roster">
        <ol className="divide-y divide-border">
          {members.map((m, i) => (
            <li key={m.id} className="flex items-center justify-between py-3">
              <div className="flex items-center gap-3">
                <span className="font-display text-xs text-muted-foreground w-6">{String(i + 1).padStart(2, "0")}</span>
                <Link to="/canvassers/$canvasserId" params={{ canvasserId: m.id }} className="font-medium hover:text-neon">{m.name}</Link>
                <span className="text-[10px] font-display text-victory">LVL {m.level}</span>
              </div>
              <div className="flex items-center gap-5 text-xs text-muted-foreground">
                <span>{m.doorsKnocked} doors</span>
                <span>{m.salesClosed} sales</span>
                <span className="text-victory">{formatCurrency(m.revenueGenerated)}</span>
              </div>
            </li>
          ))}
        </ol>
      </ArcadePanel>
    </div>
  );
}
