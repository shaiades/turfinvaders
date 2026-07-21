import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { laWeekStartISO, addDaysISO } from "@/lib/dates";
import { ArcadePanel, StatCard, TeamBadge } from "@/components/arcade";
import { RankPill } from "@/components/RankPill";
import { payRateForPoints } from "@/lib/pay";

type Row = {
  canvasser_id: string;
  team_id: string | null;
  no_demo: number;
  one_legs: number;
  future_leads: number;
  demos_sits: number;
  sales: number;
};

// Mon–Sat of the current LA week (midnight PT reset).
function weekRange() {
  const start = laWeekStartISO();
  return { start, end: addDaysISO(start, 5) };
}

type Totals = { bo: number; ol: number; rs: number; pm: number; sales: number; total: number; points: number };

function emptyTotals(): Totals {
  return { bo: 0, ol: 0, rs: 0, pm: 0, sales: 0, total: 0, points: 0 };
}

function rollup(rows: Row[]): Totals {
  const t = emptyTotals();
  for (const r of rows) {
    const pm = Math.max(0, (r.demos_sits ?? 0) - (r.sales ?? 0));
    t.bo += r.no_demo ?? 0;
    t.ol += r.one_legs ?? 0;
    t.rs += r.future_leads ?? 0;
    t.pm += pm;
    t.sales += r.sales ?? 0;
    t.points += (r.demos_sits ?? 0) + (r.sales ?? 0);
  }
  t.total = t.bo + t.ol + t.rs + t.pm + t.sales;
  return t;
}

export function PerformanceMatrix() {
  const { start, end } = useMemo(() => weekRange(), []);

  const { data, isLoading } = useQuery({
    queryKey: ["performance-matrix", start, end],
    queryFn: async () => {
      const [logsRes, profilesRes, teamsRes] = await Promise.all([
        supabase
          .from("daily_logs")
          .select("canvasser_id, team_id, no_demo, one_legs, future_leads, demos_sits, sales, log_date")
          .gte("log_date", start)
          .lte("log_date", end),
        supabase.from("profiles").select("id, display_name, team_id, current_rank"),
        supabase.from("teams").select("id, name, color"),
      ]);
      if (logsRes.error) throw logsRes.error;
      if (profilesRes.error) throw profilesRes.error;
      if (teamsRes.error) throw teamsRes.error;
      return {
        logs: (logsRes.data ?? []) as Row[],
        profiles: profilesRes.data ?? [],
        teams: teamsRes.data ?? [],
      };
    },
  });

  const view = useMemo(() => {
    if (!data) return null;
    const profileById = new Map(data.profiles.map((p) => [p.id, p]));
    const teamById = new Map(data.teams.map((t) => [t.id, t]));

    const company = rollup(data.logs);

    const byTeamRows = new Map<string, Row[]>();
    const byCanvRows = new Map<string, Row[]>();
    for (const r of data.logs) {
      const tid = r.team_id ?? profileById.get(r.canvasser_id)?.team_id ?? "unassigned";
      if (!byTeamRows.has(tid)) byTeamRows.set(tid, []);
      byTeamRows.get(tid)!.push(r);
      if (!byCanvRows.has(r.canvasser_id)) byCanvRows.set(r.canvasser_id, []);
      byCanvRows.get(r.canvasser_id)!.push(r);
    }

    const teamCards = data.teams
      .map((t) => ({ team: t, totals: rollup(byTeamRows.get(t.id) ?? []) }))
      .sort((a, b) => b.totals.total - a.totals.total);

    const canvassers = Array.from(byCanvRows.entries())
      .map(([cid, rows]) => {
        const totals = rollup(rows);
        const profile = profileById.get(cid);
        const team = profile?.team_id ? teamById.get(profile.team_id) : null;
        const rank = (profile as any)?.current_rank ?? "Jr. Silver";
        return {
          id: cid,
          name: profile?.display_name ?? "Unknown",
          team,
          totals,
          rate: payRateForPoints(totals.points),
          rank,
        };
      })
      .sort((a, b) => b.totals.points - a.totals.points);

    return { company, teamCards, canvassers };
  }, [data]);

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading performance matrix…</div>;
  if (!view) return null;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Week · {start} → {end}
        </div>
        <h2 className="font-display text-lg text-neon mt-1">COMPANY TOTALS</h2>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Total Leads" value={view.company.total} accent="victory" />
        <StatCard label="BO" value={view.company.bo} accent="warning" />
        <StatCard label="OL" value={view.company.ol} accent="warning" />
        <StatCard label="RS" value={view.company.rs} accent="accent" />
        <StatCard label="PM" value={view.company.pm} accent="neon" />
        <StatCard label="Sales" value={view.company.sales} accent="victory" />
      </div>

      <ArcadePanel title="Van Breakdown">
        {view.teamCards.length === 0 ? (
          <div className="text-sm text-muted-foreground">No vans found.</div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {view.teamCards.map(({ team, totals }) => (
              <div key={team.id} className="arcade-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <TeamBadge name={team.name} color={team.color} />
                  <span className="font-display text-xs text-victory">{totals.total} LEADS</span>
                </div>
                <div className="grid grid-cols-5 gap-2 text-center">
                  <Mini label="BO" value={totals.bo} />
                  <Mini label="OL" value={totals.ol} />
                  <Mini label="RS" value={totals.rs} />
                  <Mini label="PM" value={totals.pm} />
                  <Mini label="Sale" value={totals.sales} />
                </div>
                <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                  <span>Points</span>
                  <span className="font-display text-neon">{totals.points}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </ArcadePanel>

      <ArcadePanel title="Individual Roster">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-display uppercase tracking-widest text-muted-foreground border-b border-border">
                <th className="text-left py-2">Canvasser</th>
                <th className="text-left py-2">Van</th>
                <th className="text-left py-2">Rank</th>
                <th className="text-right py-2">Leads</th>
                <th className="text-right py-2">BO</th>
                <th className="text-right py-2">OL</th>
                <th className="text-right py-2">RS</th>
                <th className="text-right py-2">PM</th>
                <th className="text-right py-2">Sales</th>
                <th className="text-right py-2">Points</th>
                <th className="text-right py-2">Pay Rate</th>
              </tr>
            </thead>
            <tbody>
              {view.canvassers.map((c) => (
                <tr key={c.id} className="border-b border-border/40 hover:bg-surface-elevated">
                  <td className="py-2.5 font-medium">{c.name}</td>
                  <td className="py-2.5">
                    {c.team ? <TeamBadge name={c.team.name} color={c.team.color} /> : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  <td className="py-2.5"><RankPill rank={c.rank} /></td>
                  <td className="py-2.5 text-right text-victory">{c.totals.total}</td>
                  <td className="py-2.5 text-right">{c.totals.bo}</td>
                  <td className="py-2.5 text-right">{c.totals.ol}</td>
                  <td className="py-2.5 text-right">{c.totals.rs}</td>
                  <td className="py-2.5 text-right">{c.totals.pm}</td>
                  <td className="py-2.5 text-right text-victory">{c.totals.sales}</td>
                  <td className="py-2.5 text-right font-display text-neon">{c.totals.points}</td>
                  <td className="py-2.5 text-right font-display text-xs">
                    <span className={c.rate === 35 ? "text-victory" : c.rate === 30 ? "text-neon" : "text-muted-foreground"}>
                      ${c.rate}/hr
                    </span>
                  </td>
                </tr>
              ))}
              {view.canvassers.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-6 text-center text-sm text-muted-foreground">
                    No canvasser activity this week.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </ArcadePanel>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-[9px] font-display uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="text-sm font-medium mt-1">{value}</div>
    </div>
  );
}
