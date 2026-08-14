import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, TeamBadge, ArcadeCard } from "@/components/arcade";
import { MANAGER_ROLES, requireRoleBeforeLoad } from "@/lib/roles";
import { useDateRange } from "@/hooks/useDateRange";
import { RangeTabs } from "@/components/RangeTabs";

export const Route = createFileRoute("/_authenticated/teams/")({
  head: () => ({ meta: [{ title: "Vans — Knockout" }] }),
  // Leadership-only: canvassers/sales reps bounce in beforeLoad (real DB
  // roles), before the page mounts or fires any queries.
  beforeLoad: requireRoleBeforeLoad(MANAGER_ROLES),
  component: TeamsIndex,
});

function TeamsIndex() {
  // Same Day / Week / Month selector as the van detail page — the cards'
  // Leads/Sales follow it (Crew stays a headcount). Defaults to the pay week.
  const rangeControls = useDateRange({ initialTab: "week" });
  const { range } = rangeControls;

  const { data: teams } = useQuery({
    queryKey: ["teams_with_totals", range.startISO, range.endISO],
    // Keep the cards mounted while a new range loads.
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const [teamsR, profilesR, logsR] = await Promise.all([
        supabase.from("teams").select("id, name, color, captain_id").order("name"),
        supabase.from("profiles").select("id, display_name, team_id"),
        supabase
          .from("daily_logs")
          .select("team_id, demos_sits, sales, no_demo, one_legs, future_leads")
          .gte("log_date", range.startISO)
          .lte("log_date", range.endISO),
      ]);
      const captainName = new Map((profilesR.data ?? []).map((p) => [p.id, p.display_name ?? "—"]));
      const memberCount = new Map<string, number>();
      for (const p of profilesR.data ?? []) {
        if (p.team_id) memberCount.set(p.team_id, (memberCount.get(p.team_id) ?? 0) + 1);
      }
      const totalsByTeam = new Map<string, { leads: number; sales: number; sits: number }>();
      for (const l of logsR.data ?? []) {
        if (!l.team_id) continue;
        const t = totalsByTeam.get(l.team_id) ?? { leads: 0, sales: 0, sits: 0 };
        t.leads += (l.demos_sits ?? 0) + (l.sales ?? 0) + (l.no_demo ?? 0) + (l.one_legs ?? 0) + (l.future_leads ?? 0);
        t.sales += l.sales ?? 0;
        t.sits += l.demos_sits ?? 0;
        totalsByTeam.set(l.team_id, t);
      }
      return (teamsR.data ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color ?? "#00f0ff",
        captain: t.captain_id ? captainName.get(t.captain_id) ?? "—" : "—",
        members: memberCount.get(t.id) ?? 0,
        ...(totalsByTeam.get(t.id) ?? { leads: 0, sales: 0, sits: 0 }),
      }));
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl text-neon">VANS</h1>
      <RangeTabs controls={rangeControls} />
      <ArcadePanel
        title="All Vans"
        action={
          <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            {range.label}
          </span>
        }
      >
        {teams === undefined ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : teams.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No Vans yet. Create one in the Fleet Manager.
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {teams.map((t) => (
              <ArcadeCard
                key={t.id}
                asChild
                className="p-5 hover:arcade-card-glow active:arcade-card-glow"
              >
                <Link to="/teams/$teamId" params={{ teamId: t.id }}>
                  <TeamBadge name={t.name} color={t.color} />
                  <div className="mt-4 text-xs text-muted-foreground">
                    Captain · <span className="text-foreground">{t.captain}</span>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    <div>
                      <div className="text-[10px] font-display uppercase text-muted-foreground">
                        Leads
                      </div>
                      <div className="text-sm">{t.leads.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-[10px] font-display uppercase text-muted-foreground">
                        Sales
                      </div>
                      <div className="text-sm">{t.sales}</div>
                    </div>
                    <div>
                      <div className="text-[10px] font-display uppercase text-muted-foreground">
                        Crew
                      </div>
                      <div className="text-sm text-victory">{t.members}</div>
                    </div>
                  </div>
                </Link>
              </ArcadeCard>
            ))}
          </div>
        )}
      </ArcadePanel>
    </div>
  );
}
