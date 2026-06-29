import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { StatCard, ArcadePanel, TeamBadge } from "@/components/arcade";
import { LiveLeadCounter } from "@/components/LiveLeadCounter";
import { CommandCenter } from "@/components/CommandCenter";
import { FleetManager } from "@/components/FleetManager";
import { HistoricalImporter } from "@/components/HistoricalImporter";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CanvasserPersonalDashboard } from "@/components/CanvasserPersonalDashboard";
import { SuspendedBadge, useCanvasserStatuses } from "@/components/SuspendedBadge";
import { useTodayLeads } from "@/hooks/useTodayLeads";
import { DEMO_TEAMS, demoCanvassers, teamTotals, formatCurrency } from "@/lib/demo-data";
import { Trophy, Zap, DoorOpen, Target, TrendingUp, Building2, Truck, FileSpreadsheet } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Knockout" }] }),
  component: Dashboard,
});

function Dashboard() {
  const { role, loading, teamId, displayName, user } = useAuth();

  const { data: settings } = useQuery({
    queryKey: ["company_settings"],
    queryFn: async () => {
      const { data } = await supabase.from("company_settings").select("*").maybeSingle();
      return data;
    },
  });

  if (loading) return <Loading />;
  if (!role) return <NoRole />;

  if (role === "owner") return <OwnerDashboard visibility={!!settings?.global_visibility} />;
  if (role === "captain") return <CaptainDashboard teamId={teamId} visibility={!!settings?.global_visibility} />;
  return <CanvasserDashboard displayName={displayName} teamId={teamId} userId={user?.id} visibility={!!settings?.global_visibility} />;
}

function Loading() { return <div className="text-muted-foreground text-sm">Loading dashboard…</div>; }

function NoRole() {
  return (
    <div className="arcade-card p-8 text-center">
      <h1 className="font-display text-base text-neon">AWAITING ROSTER ASSIGNMENT</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Your account is created. An Owner needs to assign you a role and team before you can play.
      </p>
    </div>
  );
}

function VisibilityChip({ on }: { on: boolean }) {
  return (
    <span className={`text-[10px] font-display uppercase tracking-widest px-2 py-1 rounded border ${
      on ? "border-[var(--victory)] text-victory" : "border-border text-muted-foreground"
    }`}>
      Global Vis · {on ? "ON" : "OFF"}
    </span>
  );
}

/* ============ OWNER ============ */
function OwnerDashboard({ visibility }: { visibility: boolean }) {
  const [importOpen, setImportOpen] = useState(false);
  const teams = DEMO_TEAMS.map((t) => ({ ...t, totals: teamTotals(t.id) }));
  const grand = teams.reduce((a, t) => ({
    doors: a.doors + t.totals.doors, sales: a.sales + t.totals.sales,
    revenue: a.revenue + t.totals.revenue, members: a.members + t.totals.members,
  }), { doors: 0, sales: 0, revenue: 0, members: 0 });

  const { data: leads } = useTodayLeads();

  const offices = useQuery({
    queryKey: ["offices", "with-teams"],
    queryFn: async () => {
      const [officesRes, teamsRes] = await Promise.all([
        supabase.from("offices").select("id, name, color").order("name"),
        supabase.from("teams").select("id, name, color, office_id").order("name"),
      ]);
      if (officesRes.error) throw officesRes.error;
      if (teamsRes.error) throw teamsRes.error;
      return { offices: officesRes.data ?? [], teams: teamsRes.data ?? [] };
    },
  });

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Owner View</div>
          <h1 className="font-display text-2xl text-neon mt-1">COMPANY HQ</h1>
        </div>
        <VisibilityChip on={visibility} />
      </div>

      {/* Master Live Lead Counter — company-wide leads today */}
      <div className="arcade-card p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Live · All Offices
          </div>
          <h2 className="font-display text-lg text-neon mt-1">TOTAL LEADS TODAY</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Auto-summed from every Van across the company. Updates in real time.
          </p>
        </div>
        <LiveLeadCounter value={leads.total} size="lg" accent="victory" label="LEADS · TODAY" />
      </div>

      <Tabs defaultValue="command" className="space-y-4">
        <TabsList className="bg-surface">
          <TabsTrigger value="command">Command Center</TabsTrigger>
          <TabsTrigger value="fleet">Fleet Manager</TabsTrigger>
          <TabsTrigger value="import">Historical Importer</TabsTrigger>
        </TabsList>
        <TabsContent value="command" className="mt-0"><CommandCenter /></TabsContent>
        <TabsContent value="fleet" className="mt-0"><FleetManager /></TabsContent>
        <TabsContent value="import" className="mt-0"><HistoricalImporter /></TabsContent>
      </Tabs>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Revenue" value={formatCurrency(grand.revenue)} accent="victory" />
        <StatCard label="Doors Knocked" value={grand.doors.toLocaleString()} accent="neon" />
        <StatCard label="Sales Closed" value={grand.sales.toLocaleString()} accent="accent" />
        <StatCard label="Active Players" value={grand.members} accent="warning" />
      </div>

      <ArcadePanel title="Offices">
        {offices.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading offices…</div>
        ) : (offices.data?.offices.length ?? 0) === 0 ? (
          <div className="text-sm text-muted-foreground">No offices yet.</div>
        ) : (
          <div className="space-y-5">
            {offices.data!.offices.map((o) => {
              const vans = offices.data!.teams.filter((t) => t.office_id === o.id);
              return (
                <div key={o.id} className="border border-border rounded-lg p-4">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-3">
                      <span
                        className="w-9 h-9 rounded-md grid place-items-center"
                        style={{ background: `color-mix(in oklab, ${o.color} 18%, transparent)`, color: o.color }}
                      >
                        <Building2 className="w-5 h-5" />
                      </span>
                      <div>
                        <div className="font-display text-sm" style={{ color: o.color }}>{o.name}</div>
                        <div className="text-xs text-muted-foreground">{vans.length} vans</div>
                      </div>
                    </div>
                    <LiveLeadCounter
                      value={leads.byOffice[o.id] ?? 0}
                      size="md"
                      label={`${o.name} · LEADS`}
                    />
                  </div>
                  {vans.length > 0 && (
                    <div className="mt-4 grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {vans.map((v) => (
                        <Link
                          key={v.id}
                          to="/teams/$teamId"
                          params={{ teamId: v.id }}
                          className="arcade-card p-3 flex items-center justify-between gap-3 hover:arcade-card-glow transition-shadow"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <Truck className="w-4 h-4 shrink-0" style={{ color: v.color }} />
                            <TeamBadge name={v.name} color={v.color} />
                          </div>
                          <LiveLeadCounter
                            value={leads.byTeam[v.id] ?? 0}
                            size="sm"
                            label="LEADS"
                          />
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ArcadePanel>

      <ArcadePanel title="All Teams (Legacy Mock)">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {teams.map((t) => (
            <Link key={t.id} to="/teams/$teamId" params={{ teamId: t.id }} className="arcade-card p-5 hover:arcade-card-glow transition-shadow">
              <div className="flex items-center justify-between">
                <TeamBadge name={t.name} color={t.color} />
                <span className="text-xs text-muted-foreground">{t.totals.members} players</span>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <Mini label="Doors" value={t.totals.doors.toLocaleString()} />
                <Mini label="Sales" value={t.totals.sales.toLocaleString()} />
                <Mini label="Rev" value={formatCurrency(t.totals.revenue)} />
              </div>
              <div className="mt-4 text-xs text-muted-foreground">Captain · <span className="text-foreground">{t.captain}</span></div>
            </Link>
          ))}
        </div>
      </ArcadePanel>
    </div>
  );
}

/* ============ CAPTAIN ============ */
function CaptainDashboard({ teamId, visibility }: { teamId: string | null; visibility: boolean }) {
  const myTeamId = teamId ?? DEMO_TEAMS[0].id; // demo fallback
  const myTeam = DEMO_TEAMS.find((t) => t.id === myTeamId) ?? DEMO_TEAMS[0];
  const members = demoCanvassers().filter((c) => c.teamId === myTeam.id).sort((a, b) => b.revenueGenerated - a.revenueGenerated);
  const totals = teamTotals(myTeam.id);
  const { data: leads } = useTodayLeads();

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Captain View</div>
          <h1 className="font-display text-2xl text-neon mt-1 flex items-center gap-3">
            <TeamBadge name={myTeam.name} color={myTeam.color} />
          </h1>
        </div>
        <VisibilityChip on={visibility} />
      </div>

      {/* Van-level Live Lead Counter */}
      <div className="arcade-card p-5 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Truck className="w-5 h-5 text-neon" />
          <div>
            <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              Live · This Van
            </div>
            <div className="font-display text-sm text-neon mt-0.5">{myTeam.name.toUpperCase()} · LEADS TODAY</div>
          </div>
        </div>
        <LiveLeadCounter value={leads.byTeam[myTeam.id] ?? 0} size="md" accent="victory" />
      </div>

      <CommandCenter teamId={myTeam.id} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Team Revenue" value={formatCurrency(totals.revenue)} accent="victory" />
        <StatCard label="Doors" value={totals.doors.toLocaleString()} accent="neon" />
        <StatCard label="Sales" value={totals.sales.toLocaleString()} accent="accent" />
        <StatCard label="Roster" value={totals.members} accent="warning" />
      </div>

      <ArcadePanel title="Team Roster">
        <RosterTable members={members} />
      </ArcadePanel>

      {visibility ? (
        <ArcadePanel title="Other Vans">
          <div className="grid sm:grid-cols-2 gap-4">
            {DEMO_TEAMS.filter((t) => t.id !== myTeam.id).map((t) => {
              const tt = teamTotals(t.id);
              return (
                <Link key={t.id} to="/teams/$teamId" params={{ teamId: t.id }} className="arcade-card p-4 hover:arcade-card-glow">
                  <div className="flex items-center justify-between mb-3">
                    <TeamBadge name={t.name} color={t.color} />
                    <LiveLeadCounter value={leads.byTeam[t.id] ?? 0} size="sm" label="LEADS" />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Mini label="Doors" value={tt.doors.toLocaleString()} />
                    <Mini label="Sales" value={tt.sales.toLocaleString()} />
                    <Mini label="Rev" value={formatCurrency(tt.revenue)} />
                  </div>
                </Link>
              );
            })}
          </div>
        </ArcadePanel>
      ) : (
        <div className="arcade-card p-5 text-sm text-muted-foreground flex items-center gap-2">
          <Zap className="w-4 h-4" /> Global Visibility is off. Only your van is visible. Ask the Owner to flip it on for cross-team views.
        </div>
      )}
    </div>
  );
}

/* ============ CANVASSER ============ */
function CanvasserDashboard({ displayName, teamId, userId, visibility }: { displayName: string | null; teamId: string | null; userId?: string; visibility: boolean }) {
  const myTeam = DEMO_TEAMS.find((t) => t.id === teamId) ?? DEMO_TEAMS[0];
  const peers = demoCanvassers().sort((a, b) => b.salesClosed - a.salesClosed).slice(0, 6);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Player Card</div>
          <h1 className="font-display text-2xl text-neon mt-1">{(displayName ?? "You").toUpperCase()}</h1>
          <div className="mt-2 flex items-center gap-2">
            <TeamBadge name={myTeam.name} color={myTeam.color} />
          </div>
        </div>
        <VisibilityChip on={visibility} />
      </div>

      {userId ? (
        <CanvasserPersonalDashboard userId={userId} />
      ) : (
        <div className="text-sm text-muted-foreground">Loading your dashboard…</div>
      )}

      {visibility ? (
        <ArcadePanel title="Player Leaderboard" action={<Link to="/leaderboard" className="text-xs text-neon">View all →</Link>}>
          <ol className="divide-y divide-border">
            {peers.map((p, i) => {
              const team = DEMO_TEAMS.find((t) => t.id === p.teamId)!;
              return (
                <li key={p.id} className="flex items-center justify-between py-3">
                  <div className="flex items-center gap-3">
                    <span className="font-display text-xs text-muted-foreground w-6">{String(i + 1).padStart(2, "0")}</span>
                    <Link to="/canvassers/$canvasserId" params={{ canvasserId: p.id }} className="font-medium hover:text-neon">{p.name}</Link>
                    <TeamBadge name={team.name} color={team.color} />
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span><DoorOpen className="inline w-3 h-3 mr-1" />{p.doorsKnocked}</span>
                    <span><Target className="inline w-3 h-3 mr-1" />{p.salesClosed}</span>
                    <span className="text-victory"><TrendingUp className="inline w-3 h-3 mr-1" />{formatCurrency(p.revenueGenerated)}</span>
                  </div>
                </li>
              );
            })}
          </ol>
        </ArcadePanel>
      ) : (
        <div className="arcade-card p-5 text-sm text-muted-foreground flex items-center gap-2">
          <Trophy className="w-4 h-4" /> Global Visibility is off. Focus mode — only your own stats are shown.
        </div>
      )}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] font-display uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="text-sm font-medium mt-1">{value}</div>
    </div>
  );
}

function RosterTable({ members }: { members: ReturnType<typeof demoCanvassers> }) {
  const { data: statuses } = useCanvasserStatuses();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] font-display uppercase tracking-widest text-muted-foreground border-b border-border">
            <th className="text-left py-2">Rank</th>
            <th className="text-left py-2">Player</th>
            <th className="text-right py-2">Lvl</th>
            <th className="text-right py-2">Doors</th>
            <th className="text-right py-2">Sales</th>
            <th className="text-right py-2">Revenue</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m, i) => {
            const suspended = statuses?.[m.id] === "suspended";
            return (
              <tr key={m.id} className="border-b border-border/40 hover:bg-surface-elevated">
                <td className="py-2.5 font-display text-xs text-muted-foreground">{String(i + 1).padStart(2, "0")}</td>
                <td className="py-2.5">
                  <div className="flex items-center gap-2">
                    <Link to="/canvassers/$canvasserId" params={{ canvasserId: m.id }} className="hover:text-neon font-medium">{m.name}</Link>
                    {suspended && <SuspendedBadge />}
                  </div>
                </td>
                <td className="py-2.5 text-right text-victory font-display text-xs">{m.level}</td>
                <td className="py-2.5 text-right">{m.doorsKnocked}</td>
                <td className="py-2.5 text-right">{m.salesClosed}</td>
                <td className="py-2.5 text-right text-victory">{formatCurrency(m.revenueGenerated)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
