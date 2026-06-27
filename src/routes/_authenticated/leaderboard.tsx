import { createFileRoute, Link } from "@tanstack/react-router";
import { DEMO_TEAMS, demoCanvassers, formatCurrency } from "@/lib/demo-data";
import { ArcadePanel, TeamBadge } from "@/components/arcade";
import { SuspendedBadge, useCanvasserStatuses } from "@/components/SuspendedBadge";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Lock } from "lucide-react";

export const Route = createFileRoute("/_authenticated/leaderboard")({
  head: () => ({ meta: [{ title: "Leaderboard — Knockout" }] }),
  component: Leaderboard,
});

function Leaderboard() {
  const { role, teamId } = useAuth();
  const { data: statuses } = useCanvasserStatuses();
  const { data: settings } = useQuery({
    queryKey: ["company_settings"],
    queryFn: async () => (await supabase.from("company_settings").select("*").maybeSingle()).data,
  });
  const visibility = !!settings?.global_visibility;
  const canSeeAll = role === "owner" || role === "captain" || visibility;

  const all = demoCanvassers().sort((a, b) => b.revenueGenerated - a.revenueGenerated);
  const scoped = canSeeAll ? all : all.filter((p) => p.teamId === teamId);

  return (
    <div className="space-y-6">
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
        <ol className="divide-y divide-border">
          {scoped.map((p, i) => {
            const team = DEMO_TEAMS.find((t) => t.id === p.teamId)!;
            const suspended = statuses?.[p.id] === "suspended";
            return (
              <li key={p.id} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`font-display text-sm w-8 ${i < 3 ? "text-victory" : "text-muted-foreground"}`}>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <Link to="/canvassers/$canvasserId" params={{ canvasserId: p.id }} className="font-medium hover:text-neon truncate">{p.name}</Link>
                  <TeamBadge name={team.name} color={team.color} />
                  {suspended && <SuspendedBadge />}
                </div>
                <div className="flex items-center gap-5 text-xs text-muted-foreground shrink-0">
                  <span>{p.doorsKnocked} doors</span>
                  <span>{p.salesClosed} sales</span>
                  <span className="text-victory">{formatCurrency(p.revenueGenerated)}</span>
                </div>
              </li>
            );
          })}
        </ol>
      </ArcadePanel>
    </div>
  );
}
