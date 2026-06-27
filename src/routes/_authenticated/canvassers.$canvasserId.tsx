import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { DEMO_TEAMS, demoCanvassers, formatCurrency } from "@/lib/demo-data";
import { StatCard, ArcadePanel, TeamBadge } from "@/components/arcade";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Lock } from "lucide-react";

export const Route = createFileRoute("/_authenticated/canvassers/$canvasserId")({
  head: () => ({ meta: [{ title: "Player profile — Knockout" }] }),
  component: CanvasserProfile,
});

function CanvasserProfile() {
  const { canvasserId } = Route.useParams();
  const { role, teamId } = useAuth();
  const { data: settings } = useQuery({
    queryKey: ["company_settings"],
    queryFn: async () => (await supabase.from("company_settings").select("*").maybeSingle()).data,
  });

  const player = demoCanvassers().find((c) => c.id === canvasserId);
  if (!player) throw notFound();
  const team = DEMO_TEAMS.find((t) => t.id === player.teamId)!;

  const isSelf = false; // demo profiles
  const sameTeam = teamId === player.teamId;
  const visibility = !!settings?.global_visibility;

  // Owners + Captains always see everything. Canvassers: own team always; peer teams only if visibility ON.
  const canViewFull = role === "owner" || role === "captain" || isSelf || sameTeam || visibility;

  return (
    <div className="space-y-8">
      <div>
        <Link to="/teams/$teamId" params={{ teamId: team.id }} className="text-xs text-muted-foreground hover:text-neon">← Back to {team.name}</Link>
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <h1 className="font-display text-2xl text-neon">{player.name.toUpperCase()}</h1>
          <TeamBadge name={team.name} color={team.color} />
          <span className="text-[10px] font-display text-victory">LVL {player.level}</span>
        </div>
      </div>

      {!canViewFull ? (
        <div className="arcade-card p-8 text-center">
          <Lock className="w-6 h-6 mx-auto text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            This player's profile is private. Ask the Owner to enable Global Visibility to see peer stats.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard label="Doors Knocked" value={player.doorsKnocked} accent="neon" />
            <StatCard label="Contacts Made" value={player.contactsMade} accent="warning" />
            <StatCard label="Sales Closed" value={player.salesClosed} accent="accent" />
            <StatCard
              label="Revenue Generated"
              value={formatCurrency(player.revenueGenerated)}
              accent="victory"
              sublabel={role === "canvasser" && !isSelf ? "Production metric · personal income hidden" : undefined}
            />
          </div>

          <ArcadePanel title="Conversion Funnel">
            <div className="space-y-3">
              <FunnelRow label="Doors knocked" value={player.doorsKnocked} max={player.doorsKnocked} />
              <FunnelRow label="Contacts made" value={player.contactsMade} max={player.doorsKnocked} />
              <FunnelRow label="Sales closed" value={player.salesClosed} max={player.doorsKnocked} />
            </div>
            <div className="mt-4 text-xs text-muted-foreground">
              Close rate · <span className="text-victory font-display">{((player.salesClosed / player.contactsMade) * 100).toFixed(1)}%</span>
            </div>
          </ArcadePanel>
        </>
      )}
    </div>
  );
}

function FunnelRow({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max ? (value / max) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{value.toLocaleString()}</span>
      </div>
      <div className="h-2 bg-surface-elevated rounded">
        <div className="h-full rounded bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
