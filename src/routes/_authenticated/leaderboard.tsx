import { createFileRoute, Link } from "@tanstack/react-router";
import { ArcadePanel, TeamBadge } from "@/components/arcade";
import { SuspendedBadge, useCanvasserStatuses } from "@/components/SuspendedBadge";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Lock } from "lucide-react";
import { LiveFeed } from "@/components/LiveFeed";

export const Route = createFileRoute("/_authenticated/leaderboard")({
  head: () => ({ meta: [{ title: "Leaderboard — Knockout" }] }),
  component: Leaderboard,
});

function fmtMoney(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function Leaderboard() {
  const { role, teamId } = useAuth();
  const { data: statuses } = useCanvasserStatuses();

  const { data: settings } = useQuery({
    queryKey: ["company_settings"],
    queryFn: async () => (await supabase.from("company_settings").select("*").maybeSingle()).data,
  });
  const visibility = !!settings?.global_visibility;
  const canSeeAll = role === "owner" || role === "captain" || visibility;

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["leaderboard_real"],
    queryFn: async () => {
      const [teamsR, profilesR, logsR] = await Promise.all([
        supabase.from("teams").select("id, name, color"),
        supabase.from("profiles").select("id, display_name, team_id"),
        supabase.from("daily_logs").select("canvasser_id, demos_sits, sales, no_demo, one_legs, future_leads"),
      ]);
      const teamById = new Map((teamsR.data ?? []).map((t) => [t.id, t]));
      const agg = new Map<string, { doors: number; sales: number; sits: number }>();
      for (const l of logsR.data ?? []) {
        const a = agg.get(l.canvasser_id) ?? { doors: 0, sales: 0, sits: 0 };
        const leads = (l.demos_sits ?? 0) + (l.sales ?? 0) + (l.no_demo ?? 0) + (l.one_legs ?? 0) + (l.future_leads ?? 0);
        a.doors += leads;
        a.sales += l.sales ?? 0;
        a.sits += l.demos_sits ?? 0;
        agg.set(l.canvasser_id, a);
      }
      return (profilesR.data ?? [])
        .filter((p) => p.team_id && teamById.has(p.team_id))
        .map((p) => {
          const a = agg.get(p.id) ?? { doors: 0, sales: 0, sits: 0 };
          const team = teamById.get(p.team_id!)!;
          return {
            id: p.id,
            name: p.display_name ?? "Unknown",
            teamId: p.team_id!,
            teamName: team.name,
            teamColor: team.color ?? "#00f0ff",
            doors: a.doors,
            sales: a.sales,
            points: a.sits + a.sales * 2,
          };
        })
        .sort((a, b) => b.points - a.points);
    },
  });

  const scoped = canSeeAll ? rows : rows.filter((p) => p.teamId === teamId);

  return (
    <div className="space-y-6">
      <LiveFeed />
      <div className="flex items-end justify-between flex-wrap gap-3">
        <h1 className="font-display text-2xl text-neon">LEADERBOARD</h1>
        <span className={`text-[10px] font-display uppercase tracking-widest px-2 py-1 rounded border ${
          visibility ? "border-[var(--victory)] text-victory" : "border-border text-muted-foreground"
        }`}>
          {visibility ? "Global · ON" : "Scoped to your team"}
        </span>
      </div>

      {!canSeeAll && (
        <div className="arcade-card p-4 text-sm text-muted-foreground flex items-center gap-2">
          <Lock className="w-4 h-4" /> Cross-team leaderboard is hidden. Owner has Global Visibility off.
        </div>
      )}

      <ArcadePanel title="Top Players">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : scoped.length === 0 ? (
          <div className="text-sm text-muted-foreground">No canvassers assigned to a Van yet.</div>
        ) : (
          <ol className="divide-y divide-border">
            {scoped.map((p, i) => {
              const suspended = statuses?.[p.id] === "suspended";
              return (
                <li key={p.id} className="flex items-center justify-between py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`font-display text-sm w-8 ${i < 3 ? "text-victory" : "text-muted-foreground"}`}>
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <Link to="/canvassers/$canvasserId" params={{ canvasserId: p.id }} className="font-medium hover:text-neon truncate">{p.name}</Link>
                    <TeamBadge name={p.teamName} color={p.teamColor} />
                    {suspended && <SuspendedBadge />}
                  </div>
                  <div className="flex items-center gap-5 text-xs text-muted-foreground shrink-0">
                    <span>{p.doors} leads</span>
                    <span>{p.sales} sales</span>
                    <span className="text-victory">{p.points} pts</span>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </ArcadePanel>
    </div>
  );
}
