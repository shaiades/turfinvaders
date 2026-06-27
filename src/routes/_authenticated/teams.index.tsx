import { createFileRoute, Link } from "@tanstack/react-router";
import { DEMO_TEAMS, teamTotals, formatCurrency } from "@/lib/demo-data";
import { ArcadePanel, TeamBadge } from "@/components/arcade";

export const Route = createFileRoute("/_authenticated/teams/")({
  head: () => ({ meta: [{ title: "Teams — Knockout" }] }),
  component: TeamsIndex,
});

function TeamsIndex() {
  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl text-neon">TEAMS</h1>
      <ArcadePanel title="All Teams">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {DEMO_TEAMS.map((t) => {
            const totals = teamTotals(t.id);
            return (
              <Link key={t.id} to="/teams/$teamId" params={{ teamId: t.id }} className="arcade-card p-5 hover:arcade-card-glow">
                <TeamBadge name={t.name} color={t.color} />
                <div className="mt-4 text-xs text-muted-foreground">Captain · <span className="text-foreground">{t.captain}</span></div>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div><div className="text-[9px] font-display uppercase text-muted-foreground">Doors</div><div className="text-sm">{totals.doors.toLocaleString()}</div></div>
                  <div><div className="text-[9px] font-display uppercase text-muted-foreground">Sales</div><div className="text-sm">{totals.sales}</div></div>
                  <div><div className="text-[9px] font-display uppercase text-muted-foreground">Rev</div><div className="text-sm text-victory">{formatCurrency(totals.revenue)}</div></div>
                </div>
              </Link>
            );
          })}
        </div>
      </ArcadePanel>
    </div>
  );
}
