import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { DEMO_TEAMS, demoCanvassers, formatCurrency } from "@/lib/demo-data";
import { StatCard, ArcadePanel, TeamBadge } from "@/components/arcade";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Lock, EyeOff } from "lucide-react";

export const Route = createFileRoute("/_authenticated/canvassers/$canvasserId")({
  head: () => ({ meta: [{ title: "Player profile — Knockout" }] }),
  component: CanvasserProfile,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function startOfWeekISO() {
  const d = new Date(); d.setHours(0,0,0,0);
  d.setDate(d.getDate() - d.getDay()); // Sunday
  return d.toISOString();
}
function startOfMonthISO() {
  const d = new Date(); d.setHours(0,0,0,0); d.setDate(1);
  return d.toISOString();
}

function CanvasserProfile() {
  const { canvasserId } = Route.useParams();
  const { role, teamId, user } = useAuth();

  const { data: settings } = useQuery({
    queryKey: ["company_settings"],
    queryFn: async () => (await supabase.from("company_settings").select("*").maybeSingle()).data,
  });

  // Real revenue from confirmed leads (only meaningful when canvasserId is a real UUID)
  const isRealUser = UUID_RE.test(canvasserId);
  const revenueQuery = useQuery({
    enabled: isRealUser,
    queryKey: ["canvasser_revenue", canvasserId],
    queryFn: async () => {
      const [weekRes, monthRes, teamRes] = await Promise.all([
        supabase.from("leads").select("sale_amount")
          .eq("canvasser_id", canvasserId).eq("status", "confirmed").eq("is_sale", true)
          .gte("created_at", startOfWeekISO()),
        supabase.from("leads").select("sale_amount")
          .eq("canvasser_id", canvasserId).eq("status", "confirmed").eq("is_sale", true)
          .gte("created_at", startOfMonthISO()),
        supabase.from("profiles").select("team_id").eq("id", canvasserId).maybeSingle(),
      ]);
      const sum = (rows: { sale_amount: number | null }[] | null) =>
        (rows ?? []).reduce((a, r) => a + Number(r.sale_amount ?? 0), 0);
      return {
        weekly: sum(weekRes.data),
        monthly: sum(monthRes.data),
        teamId: teamRes.data?.team_id ?? null,
      };
    },
  });

  const player = demoCanvassers().find((c) => c.id === canvasserId);
  if (!isRealUser && !player) throw notFound();

  const team = player
    ? DEMO_TEAMS.find((t) => t.id === player.teamId)!
    : { id: revenueQuery.data?.teamId ?? "", name: "Roster", color: "#10b981" };
  const profileTeamId = player?.teamId ?? revenueQuery.data?.teamId ?? null;

  const isSelf = !!user && user.id === canvasserId;
  const sameTeam = teamId && profileTeamId && teamId === profileTeamId;
  const visibility = !!settings?.global_visibility;

  // VISIBILITY of the profile itself
  const canViewFull =
    role === "owner" || role === "office_staff" || role === "captain"
    || isSelf || sameTeam || visibility;

  // REVENUE PRIVACY SHIELD
  // Hidden when a canvasser is viewing a peer (production metrics only).
  // Owners, Office Staff, and the canvasser's direct captain always see revenue.
  const directCaptainQuery = useQuery({
    enabled: role === "captain" && !!profileTeamId && !isSelf,
    queryKey: ["is_direct_captain", profileTeamId, user?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("teams").select("captain_id").eq("id", profileTeamId!).maybeSingle();
      return data?.captain_id === user?.id;
    },
  });
  const isDirectCaptain = !!directCaptainQuery.data;
  const canViewRevenue =
    isSelf
    || role === "owner"
    || role === "office_staff"
    || (role === "captain" && isDirectCaptain);

  // Numbers
  const weekly = isRealUser
    ? (revenueQuery.data?.weekly ?? 0)
    : player ? Math.round(player.revenueGenerated * 0.25) : 0;
  const monthly = isRealUser
    ? (revenueQuery.data?.monthly ?? 0)
    : player ? player.revenueGenerated : 0;

  return (
    <div className="space-y-8">
      <div>
        {team.id ? (
          <Link to="/teams/$teamId" params={{ teamId: team.id }} className="text-xs text-muted-foreground hover:text-neon">
            ← Back to {team.name}
          </Link>
        ) : null}
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <h1 className="font-display text-2xl text-neon">{(player?.name ?? "PLAYER").toUpperCase()}</h1>
          {team.id && <TeamBadge name={team.name} color={team.color} />}
          {player && <span className="text-[10px] font-display text-victory">LVL {player.level}</span>}
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
            <StatCard label="Doors Knocked" value={player?.doorsKnocked ?? "—"} accent="neon" />
            <StatCard label="Contacts Made" value={player?.contactsMade ?? "—"} accent="warning" />
            <StatCard label="Sales Closed" value={player?.salesClosed ?? "—"} accent="accent" />
            <StatCard
              label="Revenue Generated"
              value={player ? formatCurrency(player.revenueGenerated) : "—"}
              accent="victory"
            />
          </div>

          {canViewRevenue ? (
            <ArcadePanel title="Revenue · Confirmed Sales">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <StatCard label="Weekly Revenue" value={formatCurrency(weekly)} accent="victory"
                  sublabel="Since Sunday · confirmed sales only" />
                <StatCard label="Monthly Revenue" value={formatCurrency(monthly)} accent="victory"
                  sublabel="Month-to-date · confirmed sales only" />
              </div>
            </ArcadePanel>
          ) : (
            <ArcadePanel title="Revenue · Confirmed Sales">
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <EyeOff className="w-4 h-4" />
                Revenue is hidden on peer profiles. You see production metrics only.
              </div>
            </ArcadePanel>
          )}

          {player && (
            <ArcadePanel title="Conversion Funnel">
              <div className="space-y-3">
                <FunnelRow label="Doors knocked" value={player.doorsKnocked} max={player.doorsKnocked} />
                <FunnelRow label="Contacts made" value={player.contactsMade} max={player.doorsKnocked} />
                <FunnelRow label="Sales closed" value={player.salesClosed} max={player.doorsKnocked} />
              </div>
              <div className="mt-4 text-xs text-muted-foreground">
                Close rate · <span className="text-victory font-display">
                  {((player.salesClosed / player.contactsMade) * 100).toFixed(1)}%
                </span>
              </div>
            </ArcadePanel>
          )}
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
