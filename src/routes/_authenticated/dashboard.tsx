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
import { PayrollLedger } from "@/components/PayrollLedger";
import { ExecutiveDashboard } from "@/components/ExecutiveDashboard";
import { TimesheetEditor } from "@/components/TimesheetEditor";
import { LiveDispatch } from "@/components/LiveDispatch";
import { WeeklyScheduleSettings } from "@/components/WeeklyScheduleSettings";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CanvasserPersonalDashboard } from "@/components/CanvasserPersonalDashboard";
import { SuspendedBadge, useCanvasserStatuses } from "@/components/SuspendedBadge";
import { useTodayLeads } from "@/hooks/useTodayLeads";
import { DEMO_TEAMS, demoCanvassers, teamTotals, formatCurrency } from "@/lib/demo-data";
import { Zap, DoorOpen, Truck, FileSpreadsheet } from "lucide-react";

type OwnerTab = "dispatch" | "executive" | "fleet" | "timesheets" | "payroll";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Knockout" }] }),
  validateSearch: (s: Record<string, unknown>): { tab: OwnerTab } => {
    const t = s.tab;
    return {
      tab:
        t === "fleet" || t === "payroll" || t === "timesheets" || t === "executive"
          ? t
          : "dispatch",
    };
  },
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
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Owner</div>
          <h1 className="font-display text-2xl text-foreground mt-1">COMMAND</h1>
        </div>
        <div className="flex items-center gap-3">
          <VisibilityChip on={visibility} />
          <Dialog open={importOpen} onOpenChange={setImportOpen}>
            <DialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="font-display text-[10px] tracking-widest uppercase"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 mr-2" />
                Import CSV
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl">
              <DialogHeader>
                <DialogTitle className="font-display uppercase tracking-widest text-sm">
                  Import Monday.com CSV
                </DialogTitle>
                <DialogDescription>
                  Auto-detects BO/OL/RS/PM/Sale outcomes and pipes totals into the Paycheck Engine.
                </DialogDescription>
              </DialogHeader>
              <HistoricalImporter onImported={() => setImportOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => navigate({ search: { tab: v as OwnerTab }, replace: true })}
        className="space-y-4"
      >
        <TabsList className="bg-surface">
          <TabsTrigger value="dispatch">Live Dispatch</TabsTrigger>
          <TabsTrigger value="executive">Executive Dashboard</TabsTrigger>
          <TabsTrigger value="fleet">Fleet Manager</TabsTrigger>
          <TabsTrigger value="timesheets">Timesheets</TabsTrigger>
          <TabsTrigger value="payroll">Payroll</TabsTrigger>
        </TabsList>
        <TabsContent value="dispatch" className="mt-0"><LiveDispatch /></TabsContent>
        <TabsContent value="executive" className="mt-0"><ExecutiveDashboard /></TabsContent>
        <TabsContent value="fleet" className="mt-0"><FleetManager /></TabsContent>
        <TabsContent value="timesheets" className="mt-0"><TimesheetEditor /></TabsContent>
        <TabsContent value="payroll" className="mt-0"><PayrollLedger /></TabsContent>
      </Tabs>
    </div>
  );
}
/* ============ CAPTAIN ============ */
function CaptainDashboard({ teamId, visibility }: { teamId: string | null; visibility: boolean }) {
  const PLACEHOLDER_TEAM = { id: "", name: "Unassigned", color: "#10b981", captain: "" };
  const myTeamId = teamId ?? DEMO_TEAMS[0]?.id ?? "";
  const myTeam = DEMO_TEAMS.find((t) => t.id === myTeamId) ?? DEMO_TEAMS[0] ?? PLACEHOLDER_TEAM;
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
function CanvasserDashboard({ displayName, teamId, userId, visibility: _v }: { displayName: string | null; teamId: string | null; userId?: string; visibility: boolean }) {
  const myTeam = DEMO_TEAMS.find((t) => t.id === teamId) ?? DEMO_TEAMS[0] ?? { id: "", name: "Unassigned", color: "#10b981", captain: "" };

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Player</div>
        <h1 className="font-display text-2xl text-foreground mt-1">{(displayName ?? "You").toUpperCase()}</h1>
        {myTeam.id && (
          <div className="mt-2 flex items-center gap-2">
            <TeamBadge name={myTeam.name} color={myTeam.color} />
          </div>
        )}
      </div>

      {/* Massive primary CTA — log a door */}
      <Link
        to="/my-territory"
        className="block w-full rounded-xl bg-victory text-background font-display text-xl sm:text-2xl uppercase tracking-widest text-center py-8 sm:py-10 shadow-[0_0_36px_-6px_color-mix(in_oklab,var(--victory)_70%,transparent)] hover:opacity-95 active:scale-[0.99] transition"
      >
        <DoorOpen className="inline w-7 h-7 mr-3 -mt-1" />
        Log a Door
      </Link>

      {userId ? (
        <CanvasserPersonalDashboard userId={userId} />
      ) : (
        <div className="text-sm text-muted-foreground">Loading your dashboard…</div>
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
