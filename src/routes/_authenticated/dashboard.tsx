import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { isAdminRole } from "@/lib/roles";
import { useQuery } from "@tanstack/react-query";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { supabase } from "@/integrations/supabase/client";
import {
  StatCard,
  ArcadePanel,
  TeamBadge,
  MobileCardList,
  MobileCard,
  MobileCardHeader,
  MobileStatGrid,
  MobileStat,
  metricText,
  ArcadeCard,
  NeonButton,
} from "@/components/arcade";
import { LiveLeadCounter } from "@/components/LiveLeadCounter";
import { CommandCenter } from "@/components/CommandCenter";
import { HistoricalImporter } from "@/components/HistoricalImporter";
import { PayrollLedger } from "@/components/PayrollLedger";
import { TimesheetEditor } from "@/components/TimesheetEditor";
import { FleetDispatch } from "@/components/FleetDispatch";
import { WeeklyScheduleSettings } from "@/components/WeeklyScheduleSettings";
import { CompanySettingsPanel } from "@/components/CompanySettingsPanel";
import { AddTeamMemberDialog } from "@/components/AddTeamMemberDialog";
import { RosterPanel } from "@/components/RosterPanel";
import { NewSignupsPanel } from "@/components/NewSignupsPanel";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CanvasserPersonalDashboard } from "@/components/CanvasserPersonalDashboard";
import {
  SuspendedBadge,
  useCanvasserStatuses,
  isSuspendedStatus,
} from "@/components/SuspendedBadge";
import { useTodayLeads } from "@/hooks/useTodayLeads";
import { useDateRange } from "@/hooks/useDateRange";
import { RangeTabs } from "@/components/RangeTabs";
import { formatCurrency } from "@/lib/utils";
import { Zap, DoorOpen, Truck, FileSpreadsheet } from "lucide-react";

type OwnerTab = "dispatch" | "timesheets" | "payroll" | "settings";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Knockout" }] }),
  validateSearch: (s: Record<string, unknown>): { tab: OwnerTab } => {
    // Legacy bookmarks: the old Fleet tab AND the old Executive Dashboard tab
    // both merged into Fleet Dispatch (2026-08-04).
    const t = s.tab === "fleet" || s.tab === "executive" ? "dispatch" : s.tab;
    return {
      tab: t === "payroll" || t === "timesheets" || t === "settings" ? t : "dispatch",
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

  // Owners and Office Staff (Admins) both get the full Command view.
  if (isAdminRole(role)) return <OwnerDashboard visibility={!!settings?.global_visibility} />;
  if (role === "captain")
    return <CaptainDashboard teamId={teamId} visibility={!!settings?.global_visibility} />;
  return (
    <CanvasserDashboard
      displayName={displayName}
      teamId={teamId}
      userId={user?.id}
      visibility={!!settings?.global_visibility}
    />
  );
}

function Loading() {
  return <div className="text-muted-foreground text-sm">Loading dashboard…</div>;
}

/** Day-1 waiting room. Roles are Owner/Captain-granted (security decision
 *  2026-08-12 — signup must NOT self-assign), so instead of a dead card this
 *  screen watches user_roles and unlocks itself the moment the grant lands:
 *  refreshSession() retriggers useAuth's hydrate via onAuthStateChange, with
 *  a hard reload as the fallback. */
function NoRole() {
  const { user } = useAuth();
  const { data: hasRole } = useQuery({
    enabled: !!user,
    queryKey: ["waiting_room_role", user?.id],
    refetchInterval: 8_000,
    queryFn: async () => {
      const { data } = await supabase.from("user_roles").select("role").eq("user_id", user!.id);
      return (data ?? []).length > 0;
    },
  });

  useEffect(() => {
    if (!hasRole) return;
    toast.success("You're on the roster — loading your run!");
    supabase.auth.refreshSession();
    const fallback = setTimeout(() => window.location.reload(), 3000);
    return () => clearTimeout(fallback);
  }, [hasRole]);

  return (
    <ArcadeCard glow className="p-8 text-center max-w-md mx-auto">
      <h1 className="font-display text-base text-neon">PLAYER CREATED</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Your account is live — an Owner or Captain now assigns your role and van. This screen
        unlocks itself the moment that happens, usually within the hour. Nothing to refresh, no need
        to sign out.
      </p>
      <p className="mt-3 text-xs text-muted-foreground">
        Starting a shift right now? Ping your Captain to activate you on the spot.
      </p>
      <div className="mt-5 inline-flex items-center gap-2 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        <span className="w-2 h-2 rounded-full bg-neon animate-pulse" aria-hidden />
        Watching for your roster spot…
      </div>
    </ArcadeCard>
  );
}

function VisibilityChip({ on }: { on: boolean }) {
  return (
    <span
      className={`text-[10px] font-display uppercase tracking-widest px-2 py-1 rounded border ${
        on ? "border-[var(--victory)] text-victory" : "border-border text-muted-foreground"
      }`}
    >
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
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="font-display text-lg md:text-2xl text-foreground truncate">COMMAND</h1>
          <VisibilityChip on={visibility} />
        </div>
        <div className="hidden md:block shrink-0">
          <Dialog open={importOpen} onOpenChange={setImportOpen}>
            <DialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="font-display text-[10px] tracking-widest uppercase shrink-0"
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
        <div className="-mx-4 sm:mx-0 overflow-x-auto scrollbar-hide">
          <TabsList className="bg-surface flex w-max min-w-full flex-nowrap whitespace-nowrap px-4 sm:px-0">
            <TabsTrigger value="dispatch">Fleet Dispatch</TabsTrigger>
            <TabsTrigger value="timesheets">Timesheets</TabsTrigger>
            <TabsTrigger value="payroll">Payroll</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="dispatch" className="mt-0">
          <FleetDispatch />
        </TabsContent>
        <TabsContent value="timesheets" className="mt-0">
          <TimesheetEditor />
        </TabsContent>
        <TabsContent value="payroll" className="mt-0">
          <PayrollLedger />
        </TabsContent>
        <TabsContent value="settings" className="mt-0 space-y-6">
          <WeeklyScheduleSettings />
          <NewSignupsPanel />
          <RosterPanel />
          <CompanySettingsPanel />
          <ArcadeCard faction="turf" className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm text-muted-foreground">
              Roles, teams, and account cleanup live on the Manage Players screen.
            </div>
            <NeonButton asChild tone="turf-pink">
              <Link to="/users">Manage Players</Link>
            </NeonButton>
          </ArcadeCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
/* ============ CAPTAIN ============ */
function CaptainDashboard({ teamId, visibility }: { teamId: string | null; visibility: boolean }) {
  const { user } = useAuth();
  const { data: leads } = useTodayLeads();
  // Day / Week / Month selector — defaults to the pay week, matching the old
  // week-to-date board, and drives every panel below the live counter.
  const rangeControls = useDateRange({ initialTab: "week" });
  const { range } = rangeControls;

  const teamQuery = useQuery({
    enabled: !!teamId,
    queryKey: ["captain_team", teamId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("teams")
        .select("id, name, color, captain_id")
        .eq("id", teamId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // daily_logs/leads RLS grants captains rows only for teams where they are the
  // captain_id — which can diverge from profiles.team_id (e.g. a replaced captain
  // still assigned to the van as a member). Only query when we're the real captain,
  // and say so instead of rendering misleading zeros.
  const isVanCaptain = !!user && teamQuery.data?.captain_id === user.id;

  const rosterQuery = useQuery({
    enabled: !!teamId && isVanCaptain,
    queryKey: ["captain_roster", teamId, range.startISO, range.endISO],
    queryFn: async () => {
      const [profilesRes, logsRes, salesRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, display_name, level, is_active")
          .eq("team_id", teamId!),
        supabase
          .from("daily_logs")
          .select("canvasser_id, doors_knocked, sales")
          .eq("team_id", teamId!)
          .gte("log_date", range.startISO)
          .lte("log_date", range.endISO),
        supabase
          .from("leads")
          .select("canvasser_id, sale_amount")
          .eq("team_id", teamId!)
          .eq("status", "confirmed")
          .eq("is_sale", true)
          .gte("created_at", range.startUtcISO)
          .lt("created_at", range.endUtcExclusiveISO),
      ]);
      if (profilesRes.error) throw profilesRes.error;
      if (logsRes.error) throw logsRes.error;
      if (salesRes.error) throw salesRes.error;

      const byId = new Map<string, RosterRow>();
      for (const p of profilesRes.data ?? []) {
        if (p.is_active === false) continue;
        byId.set(p.id, {
          id: p.id,
          name: p.display_name ?? "Player",
          level: p.level ?? 1,
          doorsKnocked: 0,
          salesClosed: 0,
          revenueGenerated: 0,
        });
      }
      for (const l of logsRes.data ?? []) {
        const m = byId.get(l.canvasser_id);
        if (!m) continue;
        m.doorsKnocked += l.doors_knocked ?? 0;
        m.salesClosed += l.sales ?? 0;
      }
      for (const s of salesRes.data ?? []) {
        const m = s.canvasser_id ? byId.get(s.canvasser_id) : undefined;
        if (!m) continue;
        m.revenueGenerated += Number(s.sale_amount ?? 0);
      }
      const members = [...byId.values()].sort((a, b) => b.revenueGenerated - a.revenueGenerated);
      const totals = members.reduce(
        (acc, m) => ({
          doors: acc.doors + m.doorsKnocked,
          sales: acc.sales + m.salesClosed,
          revenue: acc.revenue + m.revenueGenerated,
          members: acc.members + 1,
        }),
        { doors: 0, sales: 0, revenue: 0, members: 0 },
      );
      return { members, totals };
    },
  });

  // Cross-van cards read daily_metrics (the leaderboard pipeline) because
  // captains cannot read other teams' daily_logs/leads under RLS by design.
  const otherVansQuery = useQuery({
    enabled: visibility,
    queryKey: ["captain_other_vans", range.startISO, range.endISO],
    queryFn: async () => {
      const [teamsRes, profilesRes, metricsRes] = await Promise.all([
        supabase.from("teams").select("id, name, color"),
        supabase.from("profiles").select("id, team_id"),
        supabase
          .from("daily_metrics")
          .select("canvasser_id, leads_submitted, leads_confirmed, sales")
          .gte("metric_date", range.startISO)
          .lte("metric_date", range.endISO),
      ]);
      if (teamsRes.error) throw teamsRes.error;
      if (profilesRes.error) throw profilesRes.error;
      if (metricsRes.error) throw metricsRes.error;

      const teamByCanvasser = new Map((profilesRes.data ?? []).map((p) => [p.id, p.team_id]));
      const perTeam = new Map<string, { submits: number; confirmed: number; sales: number }>();
      for (const m of metricsRes.data ?? []) {
        const tid = teamByCanvasser.get(m.canvasser_id);
        if (!tid) continue;
        const t = perTeam.get(tid) ?? { submits: 0, confirmed: 0, sales: 0 };
        t.submits += m.leads_submitted ?? 0;
        t.confirmed += m.leads_confirmed ?? 0;
        t.sales += m.sales ?? 0;
        perTeam.set(tid, t);
      }
      return { teams: teamsRes.data ?? [], perTeam };
    },
  });

  // Live: refresh the roster/totals as team logs land.
  useRealtimeInvalidate({
    channel: "captain-dashboard-live",
    tables: ["daily_logs"],
    invalidateKeys: [["captain_roster", teamId]],
    enabled: !!teamId,
  });

  const myTeam = teamQuery.data ?? { id: teamId ?? "", name: "Unassigned", color: "#10b981" };
  const members = rosterQuery.data?.members ?? [];
  const totals = rosterQuery.data?.totals ?? { doors: 0, sales: 0, revenue: 0, members: 0 };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Captain View
          </div>
          <h1 className="font-display text-2xl text-neon mt-1 flex items-center gap-3">
            <TeamBadge name={myTeam.name} color={myTeam.color} />
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <VisibilityChip on={visibility} />
          <AddTeamMemberDialog />
        </div>
      </div>

      {/* Van-level Live Lead Counter */}
      <ArcadeCard className="p-5 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Truck className="w-5 h-5 text-neon" />
          <div>
            <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              Live · This Van
            </div>
            <div className="font-display text-sm text-neon mt-0.5">
              {myTeam.name.toUpperCase()} · LEADS TODAY
            </div>
          </div>
        </div>
        <LiveLeadCounter value={leads.byTeam[myTeam.id] ?? 0} size="md" accent="victory" />
      </ArcadeCard>

      {/* Day / Week / Month — governs the Command Center, team stats, and Other Vans */}
      <RangeTabs controls={rangeControls} />

      {teamId ? (
        isVanCaptain ? (
          <CommandCenter
            teamId={teamId}
            range={{ startISO: range.startISO, endISO: range.endISO, label: range.label }}
          />
        ) : teamQuery.isSuccess ? (
          <ArcadeCard className="p-8 text-center">
            <h2 className="font-display text-sm text-neon">MEMBER VIEW</h2>
            <p className="mt-3 text-sm text-muted-foreground">
              You're assigned to this van as a member — live team stats are visible to the van's
              captain. Ask an Owner if you should be set as this van's captain.
            </p>
          </ArcadeCard>
        ) : (
          <div className="text-sm text-muted-foreground">Loading van…</div>
        )
      ) : (
        <ArcadeCard className="p-8 text-center">
          <h2 className="font-display text-sm text-neon">NO VAN ASSIGNED</h2>
          <p className="mt-3 text-sm text-muted-foreground">
            You are not assigned to a van yet. Ask an Owner to add you to a team to see your roster
            and stats.
          </p>
        </ArcadeCard>
      )}

      {isVanCaptain && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              label="Team Revenue"
              value={formatCurrency(totals.revenue)}
              sublabel={range.label}
              accent="victory"
            />
            <StatCard
              label="Doors"
              value={totals.doors.toLocaleString()}
              sublabel={range.label}
              accent="neon"
            />
            <StatCard
              label="Sales"
              value={totals.sales.toLocaleString()}
              sublabel={range.label}
              accent="accent"
            />
            <StatCard
              label="Roster"
              value={totals.members}
              sublabel="Active members"
              accent="warning"
            />
          </div>

          <ArcadePanel title="Team Roster">
            {rosterQuery.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading roster…</div>
            ) : members.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No active members on this van yet.
              </div>
            ) : (
              <RosterTable members={members} />
            )}
          </ArcadePanel>
        </>
      )}

      {visibility ? (
        <ArcadePanel title="Other Vans">
          <div className="grid sm:grid-cols-2 gap-4">
            {(otherVansQuery.data?.teams ?? [])
              .filter((t) => t.id !== teamId)
              .map((t) => {
                const tt = otherVansQuery.data?.perTeam.get(t.id) ?? {
                  submits: 0,
                  confirmed: 0,
                  sales: 0,
                };
                return (
                  <ArcadeCard key={t.id} asChild className="hover:arcade-card-glow">
                    <Link to="/teams/$teamId" params={{ teamId: t.id }}>
                      <div className="flex items-center justify-between mb-3">
                        <TeamBadge name={t.name} color={t.color ?? "#10b981"} />
                        <LiveLeadCounter value={leads.byTeam[t.id] ?? 0} size="sm" label="LEADS" />
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <Mini label="Submits" value={tt.submits.toLocaleString()} />
                        <Mini label="Confirmed" value={tt.confirmed.toLocaleString()} />
                        <Mini label="Sales" value={tt.sales.toLocaleString()} />
                      </div>
                    </Link>
                  </ArcadeCard>
                );
              })}
          </div>
        </ArcadePanel>
      ) : (
        <ArcadeCard className="p-5 text-sm text-muted-foreground flex items-center gap-2">
          <Zap className="w-4 h-4" /> Global Visibility is off. Only your van is visible. Ask the
          Owner to flip it on for cross-team views.
        </ArcadeCard>
      )}
    </div>
  );
}

/* ============ CANVASSER ============ */
function CanvasserDashboard({
  displayName,
  teamId,
  userId,
  visibility: _v,
}: {
  displayName: string | null;
  teamId: string | null;
  userId?: string;
  visibility: boolean;
}) {
  const teamQuery = useQuery({
    enabled: !!teamId,
    queryKey: ["canvasser_team", teamId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("teams")
        .select("id, name, color")
        .eq("id", teamId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const myTeam = teamQuery.data ?? { id: "", name: "Unassigned", color: "#10b981" };

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Player
        </div>
        <h1 className="font-display text-2xl text-foreground mt-1">
          {(displayName ?? "You").toUpperCase()}
        </h1>
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
      <div className="text-[9px] font-display uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-medium mt-1">{value}</div>
    </div>
  );
}

type RosterRow = {
  id: string;
  name: string;
  level: number;
  doorsKnocked: number;
  salesClosed: number;
  revenueGenerated: number;
};

function RosterTable({ members }: { members: RosterRow[] }) {
  const { data: statuses } = useCanvasserStatuses();
  return (
    <>
      <MobileCardList>
        {members.map((m, i) => {
          const suspended = isSuspendedStatus(statuses?.[m.id]);
          return (
            <MobileCard key={m.id}>
              <MobileCardHeader
                left={
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="font-display text-xs text-muted-foreground shrink-0">
                      #{String(i + 1).padStart(2, "0")}
                    </span>
                    <Link
                      to="/canvassers/$canvasserId"
                      params={{ canvasserId: m.id }}
                      className="hover:text-neon font-medium truncate"
                    >
                      {m.name}
                    </Link>
                    {suspended && <SuspendedBadge />}
                  </span>
                }
                right={
                  <span className={metricText(m.revenueGenerated, "text-victory")}>
                    {formatCurrency(m.revenueGenerated)}
                  </span>
                }
              />
              <MobileStatGrid cols={3}>
                <MobileStat label="Lvl" value={m.level} className="text-victory font-display" />
                <MobileStat label="Doors" value={m.doorsKnocked} lit="text-foreground" />
                <MobileStat label="Sales" value={m.salesClosed} lit="text-victory" />
              </MobileStatGrid>
            </MobileCard>
          );
        })}
      </MobileCardList>
      <div className="hidden md:block overflow-x-auto">
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
              const suspended = isSuspendedStatus(statuses?.[m.id]);
              return (
                <tr
                  key={m.id}
                  className="border-b border-border/40 transition-colors duration-200 hover:bg-surface-elevated"
                >
                  <td className="py-2.5 font-display text-xs text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </td>
                  <td className="py-2.5">
                    <div className="flex items-center gap-2">
                      <Link
                        to="/canvassers/$canvasserId"
                        params={{ canvasserId: m.id }}
                        className="transition-colors duration-200 hover:text-neon font-medium"
                      >
                        {m.name}
                      </Link>
                      {suspended && <SuspendedBadge />}
                    </div>
                  </td>
                  <td className="py-2.5 text-right text-victory font-display text-xs">{m.level}</td>
                  <td
                    className={`py-2.5 text-right ${metricText(m.doorsKnocked, "text-foreground")}`}
                  >
                    {m.doorsKnocked}
                  </td>
                  <td className={`py-2.5 text-right ${metricText(m.salesClosed, "text-victory")}`}>
                    {m.salesClosed}
                  </td>
                  <td
                    className={`py-2.5 text-right ${metricText(m.revenueGenerated, "text-victory")}`}
                  >
                    {formatCurrency(m.revenueGenerated)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}