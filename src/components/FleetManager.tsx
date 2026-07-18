import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, TeamBadge } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Truck, Plus, Building2, Trash2, UserMinus, Pencil, Check, X, ChevronLeft, ChevronRight, CalendarRange, UserPlus, Lock, AlertTriangle } from "lucide-react";
import { deleteProfile, deleteVan, setVanCaptain, demoteStrandedCaptain } from "@/lib/fleet.functions";
import { addTeamMember } from "@/lib/users.functions";
import { useAuth } from "@/hooks/useAuth";
import { isManagerRole } from "@/lib/roles";

// Week helpers — ISO week, Monday..Sunday.
function startOfWeekMonday(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  x.setDate(x.getDate() + diff);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function toStrictIsoDayBoundary(d: Date, endOfDay = false): string {
  return new Date(Date.UTC(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  )).toISOString();
}
function formatRange(start: Date, end: Date): string {
  const sameMonth = start.getMonth() === end.getMonth();
  const sameYear = start.getFullYear() === end.getFullYear();
  const monthFmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });
  const sM = monthFmt(start);
  const eM = monthFmt(end);
  const sD = start.getDate();
  const eD = end.getDate();
  if (sameMonth && sameYear) return `${sM} ${sD} – ${eD}, ${end.getFullYear()}`;
  if (sameYear) return `${sM} ${sD} – ${eM} ${eD}, ${end.getFullYear()}`;
  return `${sM} ${sD}, ${start.getFullYear()} – ${eM} ${eD}, ${end.getFullYear()}`;
}

function outcomePointValue(outcomeOrStatus: unknown): number {
  const normalized = String(outcomeOrStatus ?? "").trim().toLowerCase();
  if (normalized === "pm") return 1;
  if (normalized === "sale" || normalized === "$$") return 2;
  return 0;
}

function addMappedPoints(pointsByUser: Map<string, number>, canvasserId: string | null | undefined, outcomeOrStatus: unknown, count = 1) {
  if (!canvasserId || count <= 0) return;
  const pointValue = outcomePointValue(outcomeOrStatus);
  if (pointValue <= 0) return;
  pointsByUser.set(canvasserId, (pointsByUser.get(canvasserId) ?? 0) + pointValue * count);
}

function webhookStatusForPointMapping(raw: unknown): string {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (normalized === "pitch_missed") return "PM";
  if (normalized === "sales") return "Sale";
  return String(raw ?? "");
}


const VAN_COLORS = ["#ff007a", "#00f0ff", "#a855f7", "#f59e0b", "#22c55e", "#ef4444", "#3b82f6", "#eab308"];
export const OFFICE_LOCATIONS = ["San Diego", "Orange County"] as const;
export type OfficeLocation = (typeof OFFICE_LOCATIONS)[number];



export function FleetManager() {
  const qc = useQueryClient();
  const { realRole } = useAuth();
  const canManage = isManagerRole(realRole);
  const isOwnerRole = realRole === "owner";
  const [newVanName, setNewVanName] = useState("");
  const [newVanLoc, setNewVanLoc] = useState<OfficeLocation>("San Diego");
  const [newVanColor, setNewVanColor] = useState(VAN_COLORS[0]);
  const deleteProfileFn = useServerFn(deleteProfile);
  const deleteVanFn = useServerFn(deleteVan);
  const addTeamMemberFn = useServerFn(addTeamMember);
  const setVanCaptainFn = useServerFn(setVanCaptain);
  const demoteStrandedFn = useServerFn(demoteStrandedCaptain);
  const [editingVanId, setEditingVanId] = useState<string | null>(null);
  const [editVanName, setEditVanName] = useState("");
  const [editVanColor, setEditVanColor] = useState(VAN_COLORS[0]);
  const [editVanLoc, setEditVanLoc] = useState<OfficeLocation>("San Diego");
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentOffice, setNewAgentOffice] = useState<OfficeLocation>("San Diego");
  const [archivedOpen, setArchivedOpen] = useState(false);

  const reactivateAgent = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("reactivate_agent", { _user_id: userId });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Agent reactivated");
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to reactivate"),
  });

  // Week selector — default to current Monday-anchored week.
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeekMonday(new Date()));
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);
  const weekStartISO = useMemo(() => toISODate(weekStart), [weekStart]);
  const weekEndISO = useMemo(() => toISODate(weekEnd), [weekEnd]);
  const selectedDateRange = useMemo(
    () => ({
      startDate: toStrictIsoDayBoundary(weekStart),
      endDate: toStrictIsoDayBoundary(weekEnd, true),
    }),
    [weekStart, weekEnd],
  );
  const isCurrentWeek = useMemo(
    () => toISODate(startOfWeekMonday(new Date())) === weekStartISO,
    [weekStartISO],
  );

  const fleet = useQuery({
    queryKey: ["fleet_manager", weekStartISO, weekEndISO, selectedDateRange.startDate, selectedDateRange.endDate],
    queryFn: async () => {
      const { startDate, endDate } = selectedDateRange;
      const [vansR, profilesR, rolesR, metricsByCreatedR, metricsByDateR, logsByCreatedR, logsByDateR, webhookOutcomeLogsR] = await Promise.all([
        supabase.from("teams").select("id, name, color, captain_id, office_location").order("name"),
        supabase.from("profiles").select("id, display_name, team_id, office_location, is_active, is_placeholder").order("display_name"),
        supabase.from("user_roles").select("user_id, role"),
        // Monday.com webhooks save schedule outcomes into daily_metrics.
        supabase
          .from("daily_metrics")
          .select("id, canvasser_id, pitch_missed, sales, leads_submitted, leads_confirmed, no_answers, killed, pending, metric_date, created_at")
          .gte("created_at", startDate)
          .lte("created_at", endDate),
        supabase
          .from("daily_metrics")
          .select("id, canvasser_id, pitch_missed, sales, leads_submitted, leads_confirmed, no_answers, killed, pending, metric_date, created_at")
          .gte("metric_date", weekStartISO)
          .lte("metric_date", weekEndISO),

        supabase
          .from("daily_logs")
          .select("id, canvasser_id, demos_sits, sales, log_date, created_at")
          .gte("created_at", startDate)
          .lte("created_at", endDate),
        supabase
          .from("daily_logs")
          .select("id, canvasser_id, demos_sits, sales, log_date, created_at")
          .gte("log_date", weekStartISO)
          .lte("log_date", weekEndISO),
        supabase
          .from("webhook_logs")
          .select("id, data, created_at")
          .eq("step", "Schedule_Outcome_Processed")
          .filter("data->>metric_date", "gte", weekStartISO)
          .filter("data->>metric_date", "lte", weekEndISO),
      ]);
      if (vansR.error) throw vansR.error;
      if (profilesR.error) throw profilesR.error;
      if (rolesR.error) throw rolesR.error;
      if (metricsByCreatedR.error) throw metricsByCreatedR.error;
      if (metricsByDateR.error) throw metricsByDateR.error;
      if (logsByCreatedR.error) throw logsByCreatedR.error;
      if (logsByDateR.error) throw logsByDateR.error;
      if (webhookOutcomeLogsR.error) console.warn("[FleetManager] webhook_logs fallback unavailable", webhookOutcomeLogsR.error);
      const rolesByUser = new Map<string, string[]>();
      for (const r of rolesR.data ?? []) {
        const arr = rolesByUser.get(r.user_id) ?? [];
        arr.push(r.role);
        rolesByUser.set(r.user_id, arr);
      }
      const metricRows = Array.from(
        new Map([...(metricsByCreatedR.data ?? []), ...(metricsByDateR.data ?? [])].map((row) => [row.id, row])).values(),
      );
      const logRows = Array.from(
        new Map([...(logsByCreatedR.data ?? []), ...(logsByDateR.data ?? [])].map((row) => [row.id, row])).values(),
      );
      const outcomeLogRows = webhookOutcomeLogsR.error ? [] : webhookOutcomeLogsR.data ?? [];
      // Weekly points: PM/sit = 1 pt, Sale = 2 pts. BO/RS/basic leads = 0.
      // Merge live daily_metrics (Monday webhook target table) with historical daily_logs (CSV import).
      const metricPointsByUser = new Map<string, number>();
      const logPointsByUser = new Map<string, number>();
      const webhookFallbackPointsByUser = new Map<string, number>();
      const pointsByUser = new Map<string, number>();
      const submitsByUser = new Map<string, number>();
      const confirmedByUser = new Map<string, number>();
      for (const m of metricRows) {
        addMappedPoints(metricPointsByUser, m.canvasser_id, "PM", m.pitch_missed ?? 0);
        addMappedPoints(metricPointsByUser, m.canvasser_id, "Sale", m.sales ?? 0);
        if (!m.canvasser_id) continue;
        const conf = m.leads_confirmed ?? 0;
        const kil = (m as { killed?: number | null }).killed ?? 0;
        const pen = (m as { pending?: number | null }).pending ?? 0;
        const na = (m as { no_answers?: number | null }).no_answers ?? 0;
        const sub = conf + kil + pen + na;
        submitsByUser.set(m.canvasser_id, (submitsByUser.get(m.canvasser_id) ?? 0) + sub);
        confirmedByUser.set(m.canvasser_id, (confirmedByUser.get(m.canvasser_id) ?? 0) + conf);
      }
      for (const l of logRows) {
        addMappedPoints(logPointsByUser, l.canvasser_id, "PM", l.demos_sits ?? 0);
        addMappedPoints(logPointsByUser, l.canvasser_id, "Sale", l.sales ?? 0);
      }
      for (const row of outcomeLogRows) {
        const payload = row.data && typeof row.data === "object" && !Array.isArray(row.data)
          ? row.data as Record<string, unknown>
          : {};
        const canvasserId = typeof payload.canvasser_id === "string" ? payload.canvasser_id : null;
        const rawOutcome = payload.changedValue ?? payload.status ?? payload.recordedAs;
        addMappedPoints(webhookFallbackPointsByUser, canvasserId, webhookStatusForPointMapping(rawOutcome), 1);
      }
      const allPointUserIds = new Set([
        ...metricPointsByUser.keys(),
        ...logPointsByUser.keys(),
        ...webhookFallbackPointsByUser.keys(),
      ]);
      for (const userId of allPointUserIds) {
        const webhookPoints = Math.max(
          metricPointsByUser.get(userId) ?? 0,
          webhookFallbackPointsByUser.get(userId) ?? 0,
        );
        pointsByUser.set(userId, webhookPoints + (logPointsByUser.get(userId) ?? 0));
      }
      return {
        vans: vansR.data ?? [],
        profiles: profilesR.data ?? [],
        rolesByUser,
        pointsByUser,
        submitsByUser,
        confirmedByUser,
        debugRecordCount: metricRows.length + logRows.length + outcomeLogRows.length,
      };

    },
  });

  // Live updates — refresh weekly points as Monday webhooks arrive.
  useEffect(() => {
    const ch = supabase
      .channel("fleet-live-metrics")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "daily_metrics" },
        () => qc.invalidateQueries({ queryKey: ["fleet_manager"] }),
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc]);




  const createVan = useMutation({
    mutationFn: async () => {
      if (!newVanName.trim()) throw new Error("Van name required");
      const { error } = await supabase.from("teams").insert({
        name: newVanName.trim(), color: newVanColor, office_location: newVanLoc,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Van created");
      setNewVanName("");
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Server fn keeps user_roles in sync: promotes the incoming captain and
  // returns the outgoing one to canvasser when they lead no other van.
  const setCaptain = useMutation({
    mutationFn: async ({ vanId, captainId }: { vanId: string; captainId: string | null }) =>
      await setVanCaptainFn({ data: { van_id: vanId, captain_id: captainId } }),
    onSuccess: (res) => {
      toast.success(
        res?.demoted_previous
          ? "Captain assigned — previous captain is now a canvasser"
          : "Captain assigned",
      );
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
      qc.invalidateQueries({ queryKey: ["manage_users"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to assign captain"),
  });

  const demoteStranded = useMutation({
    mutationFn: async (userId: string) => { await demoteStrandedFn({ data: { id: userId } }); },
    onSuccess: () => {
      toast.success("Captain demoted to canvasser");
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
      qc.invalidateQueries({ queryKey: ["manage_users"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to demote"),
  });

  const assignCanvasser = useMutation({
    mutationFn: async ({ canvasserId, vanId }: { canvasserId: string; vanId: string | null }) => {
      const patch: { team_id: string | null; office_location?: string } = { team_id: vanId };
      if (vanId) {
        const van = fleet.data?.vans.find((v) => v.id === vanId);
        if (van?.office_location) patch.office_location = van.office_location;
      }
      const { error } = await supabase.from("profiles").update(patch).eq("id", canvasserId);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success(vars.vanId ? "Assigned to van" : "Moved to Unassigned");
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
      qc.invalidateQueries({ queryKey: ["performance-matrix"] });
      qc.invalidateQueries({ queryKey: ["weekly_results"] });
      qc.invalidateQueries({ queryKey: ["payroll-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeProfile = useMutation({
    mutationFn: async (id: string) => { await deleteProfileFn({ data: { id } }); },
    onSuccess: () => {
      toast.success("Ghost profile deleted");
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
      qc.invalidateQueries({ queryKey: ["performance-matrix"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to delete"),
  });

  const updateVan = useMutation({
    mutationFn: async ({ id, name, color, office_location }: { id: string; name: string; color: string; office_location: OfficeLocation }) => {
      if (!name.trim()) throw new Error("Van name required");
      const { error } = await supabase.from("teams")
        .update({ name: name.trim(), color, office_location })
        .eq("id", id);
      if (error) throw error;
      // Cascade office to roster.
      await supabase.from("profiles").update({ office_location }).eq("team_id", id);
    },
    onSuccess: () => {
      toast.success("Van updated");
      setEditingVanId(null);
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
      qc.invalidateQueries({ queryKey: ["weekly_results"] });
      qc.invalidateQueries({ queryKey: ["payroll-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeVan = useMutation({
    mutationFn: async (id: string) => { await deleteVanFn({ data: { id } }); },
    onSuccess: () => {
      toast.success("Van deleted — members moved to Unassigned");
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
      qc.invalidateQueries({ queryKey: ["performance-matrix"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to delete van"),
  });

  const addAgent = useMutation({
    mutationFn: async () => {
      const name = newAgentName.trim();
      if (!name) throw new Error("Full Name required");
      await addTeamMemberFn({
        data: { full_name: name, office_location: newAgentOffice, role: "canvasser" },
      });
    },
    onSuccess: () => {
      toast.success(`${newAgentName.trim()} added to Free Agents`);
      setNewAgentName("");
      setAddAgentOpen(false);
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
      qc.invalidateQueries({ queryKey: ["manage_users"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to add agent"),
  });

  function startEditVan(v: { id: string; name: string; color: string; office_location: string | null }) {
    setEditingVanId(v.id);
    setEditVanName(v.name);
    setEditVanColor(v.color);
    setEditVanLoc((v.office_location as OfficeLocation) ?? "San Diego");
  }

  if (fleet.isLoading || !fleet.data) {
    return <div className="text-sm text-muted-foreground">Loading fleet…</div>;
  }

  const { vans, profiles: allProfiles, rolesByUser, pointsByUser, submitsByUser, confirmedByUser, debugRecordCount } = fleet.data;
  const profiles = allProfiles.filter((p) => p.is_active !== false);
  const archivedProfiles = allProfiles.filter((p) => p.is_active === false);
  const profileNameById = new Map(allProfiles.map((p) => [p.id, p.display_name]));
  const hasProtectedRole = (id: string) => {
    const rs = rolesByUser.get(id) ?? [];
    return rs.includes("owner") || rs.includes("office_staff");
  };
  // Anyone on the active roster can be picked as captain — the server fn
  // promotes/demotes user_roles to match teams.captain_id.
  const captainCandidates = profiles.filter((p) => !hasProtectedRole(p.id) && !p.is_placeholder);
  // Data hygiene from before the server fn existed: captain role, but captain
  // of no van — RLS gives them no team access, so surface them for the owner.
  const strandedCaptains = profiles.filter(
    (p) =>
      (rolesByUser.get(p.id) ?? []).includes("captain") &&
      !hasProtectedRole(p.id) &&
      !vans.some((v) => v.captain_id === p.id),
  );
  const unassigned = profiles.filter((p) => !p.team_id && !(rolesByUser.get(p.id) ?? []).includes("owner"));

  // Group vans by office location.
  const vansByOffice = new Map<string, typeof vans>();
  for (const loc of OFFICE_LOCATIONS) vansByOffice.set(loc, []);
  for (const v of vans) {
    const loc = (v.office_location as string) || "San Diego";
    if (!vansByOffice.has(loc)) vansByOffice.set(loc, []);
    vansByOffice.get(loc)!.push(v);
  }

  // Total team stats — sum every point across the fleet for the selected week.
  const totalFleetPoints = Array.from(pointsByUser.values()).reduce((a, b) => a + b, 0);
  const totalSubmits = Array.from(submitsByUser.values()).reduce((a, b) => a + b, 0);
  const totalConfirmed = Array.from(confirmedByUser.values()).reduce((a, b) => a + b, 0);
  const activeAgentCount = profiles.filter((p) => (pointsByUser.get(p.id) ?? 0) > 0).length;

  // Van-level aggregate helpers.
  const vanTotalPoints = (vanId: string) =>
    profiles
      .filter((p) => p.team_id === vanId)
      .reduce((sum, p) => sum + (pointsByUser.get(p.id) ?? 0), 0);




  return (
    <div className="space-y-6">
      {/* Week Selector */}
      <ArcadePanel title="Leaderboard Week">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setWeekStart((w) => addDays(w, -7))}
              title="Previous week"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <div className="px-3 py-1.5 rounded border border-neon/40 bg-neon/5 flex items-center gap-2 min-w-[240px] justify-center">
              <CalendarRange className="w-4 h-4 text-neon" />
              <div className="flex flex-col leading-tight">
                <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  {isCurrentWeek ? "Current Week" : "Selected Week"}
                </span>
                <span className="text-sm font-display">{formatRange(weekStart, weekEnd)}</span>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setWeekStart((w) => addDays(w, 7))}
              title="Next week"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
          {!isCurrentWeek && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setWeekStart(startOfWeekMonday(new Date()))}
            >
              Jump to current week
            </Button>
          )}
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          Points below reflect Mon–Sun of the selected week (PM = 1 pt, Sale = 2 pts; BO/RS = 0).
        </p>
        <p className="mt-1 text-[10px] text-muted-foreground/60">
          Records found: {debugRecordCount}
        </p>
      </ArcadePanel>

      {/* Tier 1 — Global Fleet Scoreboard (sticky on scroll) */}
      <div className="sticky top-0 z-20 -mx-2 md:mx-0 px-2 md:px-0 py-2 bg-background/85 backdrop-blur border-b border-neon/20">
        <div className="grid grid-cols-3 gap-2 md:gap-3">
          <ScoreTile label="Submits" value={totalSubmits} color="neon" />
          <ScoreTile label="Confirmed" value={totalConfirmed} color="victory" />
          <ScoreTile label="Fleet Points" value={totalFleetPoints} color="accent" />
        </div>
        <div className="mt-1.5 text-[9px] text-muted-foreground text-center uppercase tracking-widest font-display">
          {isCurrentWeek ? "Live · this week" : formatRange(weekStart, weekEnd)}
          <span className="mx-1.5 opacity-40">·</span>
          {activeAgentCount} active · {vans.length} vans
        </div>
      </div>





      {/* Read-only banner for canvassers */}
      {!canManage && (
        <div className="arcade-card p-3 flex items-center gap-2 text-xs text-muted-foreground border border-border">
          <Lock className="w-3.5 h-3.5" /> Read-only view. Van assignments and roster edits are limited to Captains, Admins, and Owners.
        </div>
      )}

      {/* Create New Van — managers only */}
      {canManage && (
        <ArcadePanel title="Create New Van">
          <div className="grid gap-3 md:grid-cols-[1fr_180px_140px_auto] items-end">
            <div>
              <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Van Name</label>
              <Input value={newVanName} onChange={(e) => setNewVanName(e.target.value)} placeholder="e.g. Phoenix Strike" />
            </div>
            <div>
              <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Office Location</label>
              <Select value={newVanLoc} onValueChange={(v) => setNewVanLoc(v as OfficeLocation)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OFFICE_LOCATIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Color</label>
              <div className="flex gap-1 mt-1">
                {VAN_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setNewVanColor(c)}
                    className={`w-6 h-6 rounded ${newVanColor === c ? "ring-2 ring-offset-1 ring-offset-background ring-foreground" : ""}`}
                    style={{ background: c }}
                    aria-label={`color ${c}`}
                  />
                ))}
              </div>
            </div>
            <Button onClick={() => createVan.mutate()} disabled={createVan.isPending} className="bg-neon text-background hover:bg-neon/90">
              <Plus className="w-4 h-4 mr-1" /> Create Van
            </Button>
          </div>
        </ArcadePanel>
      )}

      {/* Captains whose role outlived their van assignment — RLS gives them no
          team access, so either re-assign them a van or return them to canvasser. */}
      {isOwnerRole && strandedCaptains.length > 0 && (
        <div className="arcade-card p-4 border border-[var(--warning)]/50">
          <div className="flex items-center gap-2 text-[10px] font-display uppercase tracking-widest text-warning">
            <AlertTriangle className="w-3.5 h-3.5" /> Captains without a van
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            These players hold the Captain role but aren't the captain of any van, so they can't see
            their team's logs or leads. Pick them as a van's captain above, or demote them to
            canvasser.
          </p>
          <div className="mt-3 space-y-1.5">
            {strandedCaptains.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-2 rounded border border-border bg-surface px-2 py-1.5"
              >
                <span className="text-sm truncate">{p.display_name}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={demoteStranded.isPending}
                  onClick={() => demoteStranded.mutate(p.id)}
                >
                  <UserMinus className="w-3.5 h-3.5 mr-1" /> Demote to canvasser
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Vans grouped by office */}
        <div className="space-y-4">
          {Array.from(vansByOffice.entries()).map(([office, list]) => (
            <ArcadePanel
              key={office}
              title={`${office} · ${list.length} ${list.length === 1 ? "Van" : "Vans"}`}
            >
              {list.length === 0 ? (
                <div className="text-sm text-muted-foreground italic">No vans in {office} yet.</div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  {list.map((v) => {
                    // Dedupe roster by normalized display name — if a person exists as
                    // both Captain and Canvasser under the same van, show one row.
                    const rosterRaw = profiles.filter((p) => p.team_id === v.id);
                    const rosterMap = new Map<string, typeof rosterRaw[number]>();
                    for (const p of rosterRaw) {
                      const key = (p.display_name ?? "").trim().toLowerCase().replace(/\s+/g, " ") || `id:${p.id}`;
                      const prev = rosterMap.get(key);
                      if (!prev) rosterMap.set(key, p);
                      else if ((rolesByUser.get(p.id) ?? []).includes("captain") && !(rolesByUser.get(prev.id) ?? []).includes("captain")) {
                        // Prefer the captain profile as the representative row.
                        rosterMap.set(key, p);
                      }
                    }
                    const roster = Array.from(rosterMap.values());

                    // Current captain stays selectable even if archived/placeholder.
                    const captainOptions =
                      v.captain_id && !captainCandidates.some((c) => c.id === v.captain_id)
                        ? [
                            ...allProfiles.filter((p) => p.id === v.captain_id),
                            ...captainCandidates,
                          ]
                        : captainCandidates;

                    return (
                      <div key={v.id} className="van-card p-4 space-y-3">

                        {editingVanId === v.id ? (
                          <div className="space-y-2 p-2 rounded border border-neon/40 bg-neon/5">
                            <div className="grid gap-2 md:grid-cols-[1fr_160px]">
                              <div>
                                <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Van Name</label>
                                <Input value={editVanName} onChange={(e) => setEditVanName(e.target.value)} />
                              </div>
                              <div>
                                <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Office Location</label>
                                <Select value={editVanLoc} onValueChange={(val) => setEditVanLoc(val as OfficeLocation)}>
                                  <SelectTrigger><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    {OFFICE_LOCATIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                            <div>
                              <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Color</label>
                              <div className="flex gap-1 mt-1">
                                {VAN_COLORS.map((c) => (
                                  <button
                                    key={c}
                                    onClick={() => setEditVanColor(c)}
                                    className={`w-6 h-6 rounded ${editVanColor === c ? "ring-2 ring-offset-1 ring-offset-background ring-foreground" : ""}`}
                                    style={{ background: c }}
                                    aria-label={`color ${c}`}
                                  />
                                ))}
                              </div>
                            </div>
                            <div className="flex gap-2 justify-end">
                              <Button size="sm" variant="ghost" onClick={() => setEditingVanId(null)}>
                                <X className="w-3.5 h-3.5 mr-1" /> Cancel
                              </Button>
                              <Button
                                size="sm"
                                disabled={updateVan.isPending}
                                onClick={() => updateVan.mutate({ id: v.id, name: editVanName, color: editVanColor, office_location: editVanLoc })}
                                className="bg-neon text-background hover:bg-neon/90"
                              >
                                <Check className="w-3.5 h-3.5 mr-1" /> Save
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <Truck className="w-4 h-4 shrink-0" style={{ color: v.color }} />
                              <TeamBadge name={v.name} color={v.color} />
                              <span
                                className="shrink-0 text-[10px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-neon/50 text-neon bg-neon/10"
                                title="Total van points this week"
                              >
                                {vanTotalPoints(v.id)}p
                              </span>
                              {v.captain_id && (
                                <span className="hidden sm:inline text-[10px] text-muted-foreground truncate min-w-0">
                                  · {profileNameById.get(v.captain_id) ?? ""}
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-1">
                              <span className="text-[10px] font-display uppercase tracking-widest flex items-center gap-1 mr-1 text-muted-foreground">
                                <Building2 className="w-3 h-3" /> {v.office_location ?? "San Diego"}
                              </span>
                              {canManage && (
                                <button
                                  onClick={() => startEditVan(v)}
                                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                                  title="Edit van"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {isOwnerRole && (
                                <button
                                  onClick={() => {
                                    if (confirm(`Delete van "${v.name}"? Members will be moved to Unassigned. This cannot be undone.`)) {
                                      removeVan.mutate(v.id);
                                    }
                                  }}
                                  className="p-1 rounded hover:bg-destructive/20 text-destructive"
                                  title="Delete van (Owner only)"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                        )}

                        <div>
                          <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Captain</label>
                          {/* Owner-only: teams/user_roles RLS rejects captain
                              changes from anyone else, so don't offer a control
                              that can't take effect. */}
                          {isOwnerRole ? (
                            <Select
                              value={v.captain_id ?? "none"}
                              onValueChange={(val) => setCaptain.mutate({ vanId: v.id, captainId: val === "none" ? null : val })}
                            >
                              <SelectTrigger><SelectValue placeholder="No captain" /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">— No captain —</SelectItem>
                                {captainOptions.map((c) => (
                                  <SelectItem key={c.id} value={c.id}>
                                    {c.display_name}
                                    {(rolesByUser.get(c.id) ?? []).includes("captain") ? " · Captain" : ""}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <div className="text-sm px-2 py-1.5 rounded border border-border bg-surface">
                              {(v.captain_id ? profileNameById.get(v.captain_id) : null) ?? "— No captain —"}
                            </div>
                          )}
                        </div>

                        <div>
                          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-1">
                            Roster ({roster.length}) <span className="opacity-60">· drop agents here</span>
                          </div>
                          <div className="space-y-1.5 min-h-[40px]">
                            {roster.map((r) => {
                              const targetIsOwner = (rolesByUser.get(r.id) ?? []).includes("owner");
                              const canModify = canManage && (isOwnerRole || !targetIsOwner);
                              // Sum points across every profile with the same display name in this van.
                              const nameKey = (r.display_name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
                              const aggregatedPoints = rosterRaw
                                .filter((p) => ((p.display_name ?? "").trim().toLowerCase().replace(/\s+/g, " ")) === nameKey)
                                .reduce((sum, p) => sum + (pointsByUser.get(p.id) ?? 0), 0);
                              const rIsCaptain =
                                v.captain_id === r.id ||
                                (rolesByUser.get(r.id) ?? []).includes("captain");
                              return (
                                <RosterRow
                                  key={r.id}
                                  id={r.id}
                                  name={r.display_name ?? "Unknown"}
                                  points={aggregatedPoints}
                                  isCaptain={rIsCaptain}
                                  canManage={canModify}
                                  onUnassign={canModify ? () => assignCanvasser.mutate({ canvasserId: r.id, vanId: null }) : undefined}
                                  onDelete={isOwnerRole ? () => {
                                    if (confirm(`Delete profile "${r.display_name}"? This removes the user permanently.`)) {
                                      removeProfile.mutate(r.id);
                                    }
                                  } : undefined}
                                />
                              );
                            })}

                            {roster.length === 0 && (
                              <div className="text-xs text-muted-foreground italic px-2 py-3 border border-dashed border-border rounded">
                                Drop agents here
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </ArcadePanel>
          ))}
        </div>

        {/* Free Agents holding pen */}
        <div className="free-agents-panel bg-surface p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <h3 className="font-display uppercase tracking-widest text-sm" style={{ color: "var(--neon-orange)" }}>
                ⚠ Free Agents (Needs Van)
              </h3>
              <span
                className="text-[10px] font-display px-2 py-0.5 rounded-full"
                style={{
                  color: "var(--neon-orange)",
                  background: "color-mix(in oklab, var(--neon-orange) 12%, transparent)",
                  border: "1px solid color-mix(in oklab, var(--neon-orange) 45%, transparent)",
                }}
              >
                {unassigned.length}
              </span>
            </div>
            {canManage && (
              <Button
                size="sm"
                onClick={() => setAddAgentOpen(true)}
                className="gap-1 font-display uppercase tracking-widest text-[10px] bg-background border text-foreground hover:bg-[color:var(--neon-blue)]/10"
                style={{
                  borderColor: "var(--neon-blue)",
                  color: "var(--neon-blue)",
                  boxShadow: "0 0 12px -4px color-mix(in oklab, var(--neon-blue) 70%, transparent)",
                }}
              >
                <UserPlus className="w-3.5 h-3.5" /> + Add Agent
              </Button>
            )}
          </div>
          <div className="min-h-[120px] rounded-lg border border-dashed p-2 space-y-1.5 border-border">
            {unassigned.length === 0 ? (
              <div className="text-xs text-muted-foreground italic px-2 py-6 text-center">
                All agents assigned to a van. New Monday.com canvassers land here automatically.
              </div>
            ) : (
              unassigned.map((p) => {
                const targetIsOwner = (rolesByUser.get(p.id) ?? []).includes("owner");
                const canModify = canManage && (isOwnerRole || !targetIsOwner);
                return (
                  <RosterRow
                    key={p.id}
                    id={p.id}
                    name={p.display_name ?? "Unknown"}
                    points={pointsByUser.get(p.id) ?? 0}
                    canManage={canModify}
                    vans={canModify ? vans.map((v) => ({ id: v.id, name: v.name, color: v.color })) : undefined}
                    currentVanId={p.team_id}
                    onAssign={canModify ? (vanId) => assignCanvasser.mutate({ canvasserId: p.id, vanId }) : undefined}
                    onDelete={isOwnerRole ? () => {
                      if (confirm(`Delete profile "${p.display_name}"? This removes the user permanently.`)) {
                        removeProfile.mutate(p.id);
                      }
                    } : undefined}
                  />
                );
              })
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {canManage
              ? "Tap “Assign Van” to place an agent on a roster. Auto-created from Monday.com webhooks."
              : "Free Agents auto-populate from Monday.com webhooks."}
          </p>
        </div>
      </div>

      {/* Archived Agents link — managers/owners only */}
      {canManage && (
        <div className="pt-2 text-center">
          <button
            onClick={() => setArchivedOpen(true)}
            className="text-[11px] text-muted-foreground/70 hover:text-muted-foreground underline underline-offset-4"
          >
            View Archived Agents ({archivedProfiles.length})
          </button>
        </div>
      )}

      {/* Archived Agents modal */}
      <Dialog open={archivedOpen} onOpenChange={setArchivedOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display uppercase tracking-widest">Archived Agents</DialogTitle>
            <DialogDescription>
              Canvassers auto-archived after 14 days of inactivity. Historical data is preserved.
              Reactivate to bring them back to Free Agents.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[420px] overflow-y-auto space-y-1.5 py-2">
            {archivedProfiles.length === 0 ? (
              <div className="text-xs text-muted-foreground italic px-2 py-6 text-center">
                No archived agents.
              </div>
            ) : (
              archivedProfiles.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded border border-border bg-surface"
                >
                  <span className="text-sm truncate flex-1">{p.display_name ?? "Unknown"}</span>
                  <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                    {p.office_location ?? "—"}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={reactivateAgent.isPending}
                    onClick={() => reactivateAgent.mutate(p.id)}
                    className="h-7 text-[11px] font-display uppercase tracking-wider"
                  >
                    Reactivate
                  </Button>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setArchivedOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Agent modal */}
      <Dialog open={addAgentOpen} onOpenChange={setAddAgentOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display uppercase tracking-widest">Add Agent</DialogTitle>
            <DialogDescription>
              Creates a placeholder Canvasser in Free Agents. They can be assigned to a van right after.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label htmlFor="agent-name" className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                Full Name
              </Label>
              <Input
                id="agent-name"
                autoFocus
                value={newAgentName}
                onChange={(e) => setNewAgentName(e.target.value)}
                placeholder="e.g. Alex Morgan"
                onKeyDown={(e) => { if (e.key === "Enter") addAgent.mutate(); }}
              />
            </div>
            <div>
              <Label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Office</Label>
              <Select value={newAgentOffice} onValueChange={(v) => setNewAgentOffice(v as OfficeLocation)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OFFICE_LOCATIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddAgentOpen(false)}>Cancel</Button>
            <Button
              onClick={() => addAgent.mutate()}
              disabled={addAgent.isPending || !newAgentName.trim()}
              className="bg-neon text-background hover:bg-neon/90"
            >
              <UserPlus className="w-4 h-4 mr-1" /> Add to Free Agents
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type VanOption = { id: string; name: string; color: string };

function RosterRow({
  id, name, points, vans, currentVanId, onAssign, onUnassign, onDelete, canManage = true, isCaptain = false,
}: {
  id: string;
  name: string;
  points: number;
  vans?: VanOption[];
  currentVanId?: string | null;
  onAssign?: (vanId: string) => void;
  onUnassign?: () => void;
  onDelete?: () => void;
  canManage?: boolean;
  isCaptain?: boolean;
}) {
  const isGhost = points === 0;
  return (
    <div
      data-profile-id={id}
      className="flex items-center gap-2 px-2 py-1.5 rounded border border-border bg-surface hover:border-neon/60"
    >
      <span className="text-sm truncate flex-1 flex items-center gap-2 min-w-0">
        <span className="truncate">{name}</span>
        {isCaptain && (
          <span className="shrink-0 text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-accent/60 text-accent bg-accent/10">
            Captain
          </span>
        )}
      </span>
      <span className={`text-[10px] font-display ${isGhost ? "text-muted-foreground px-1.5" : "points-badge-glow"}`}>
        {points}p
      </span>

      {vans && onAssign && (
        <Select
          value={currentVanId ?? "none"}
          onValueChange={(val) => { if (val && val !== "none") onAssign(val); }}
        >
          <SelectTrigger
            className="h-7 min-w-[120px] text-[11px] font-display uppercase tracking-wider bg-background border-[color:var(--neon-blue)]/50 hover:border-[color:var(--neon-blue)]"
          >
            <SelectValue placeholder="Assign Van…" />
          </SelectTrigger>
          <SelectContent className="bg-background border-[color:var(--neon-blue)]/50">
            <SelectItem value="none" disabled>— Assign Van —</SelectItem>
            {vans.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                <span className="inline-flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ background: v.color }} />
                  {v.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {onUnassign && (
        <button
          onClick={onUnassign}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          title="Move to Free Agents"
        >
          <UserMinus className="w-3.5 h-3.5" />
        </button>
      )}
      {onDelete && (
        <button
          onClick={onDelete}
          className="p-1 rounded hover:bg-destructive/20 text-destructive"
          title={isGhost ? "Delete ghost profile" : "Delete profile (has data)"}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

function ScoreTile({ label, value, color }: { label: string; value: number; color: "neon" | "victory" | "accent" }) {
  const textClass =
    color === "neon" ? "text-neon" : color === "victory" ? "text-victory" : "text-accent";
  const borderClass =
    color === "neon" ? "border-neon/40" : color === "victory" ? "border-victory/40" : "border-accent/40";
  return (
    <div className={`arcade-card px-2 py-1.5 md:px-3 md:py-2 border ${borderClass} bg-background/60 text-center min-w-0`}>
      <div className="text-[9px] md:text-[10px] font-display uppercase tracking-widest text-muted-foreground truncate">
        {label}
      </div>
      <div className={`font-display text-lg md:text-2xl leading-tight ${textClass}`}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}


