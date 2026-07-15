import { useMemo, useState } from "react";
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
import { Truck, Plus, Building2, Trash2, UserMinus, Pencil, Check, X, ChevronLeft, ChevronRight, CalendarRange, UserPlus, Lock } from "lucide-react";
import { deleteProfile, deleteVan } from "@/lib/fleet.functions";
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
        supabase.from("profiles").select("id, display_name, team_id, office_location, is_active").order("display_name"),
        supabase.from("user_roles").select("user_id, role"),
        // Monday.com webhooks save schedule outcomes into daily_metrics.
        supabase
          .from("daily_metrics")
          .select("id, canvasser_id, pitch_missed, sales, metric_date, created_at")
          .gte("created_at", startDate)
          .lte("created_at", endDate),
        supabase
          .from("daily_metrics")
          .select("id, canvasser_id, pitch_missed, sales, metric_date, created_at")
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
      for (const m of metricRows) {
        addMappedPoints(metricPointsByUser, m.canvasser_id, "PM", m.pitch_missed ?? 0);
        addMappedPoints(metricPointsByUser, m.canvasser_id, "Sale", m.sales ?? 0);
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
      console.log("[FleetManager] fetched weekly points", {
        selectedDateRange: { startDate, endDate, weekStartISO, weekEndISO },
        targetTables: ["daily_metrics", "daily_logs", "webhook_logs"],
        recordCount: metricRows.length + logRows.length + outcomeLogRows.length,
        dailyMetrics: metricRows,
        dailyLogs: logRows,
        webhookOutcomeLogs: outcomeLogRows,
        metricPointsByUser: Object.fromEntries(metricPointsByUser),
        logPointsByUser: Object.fromEntries(logPointsByUser),
        webhookFallbackPointsByUser: Object.fromEntries(webhookFallbackPointsByUser),
        pointsByUser: Object.fromEntries(pointsByUser),
      });
      return {
        vans: vansR.data ?? [],
        profiles: profilesR.data ?? [],
        rolesByUser,
        pointsByUser,
        debugRecordCount: metricRows.length + logRows.length + outcomeLogRows.length,
      };
    },
  });


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

  const setCaptain = useMutation({
    mutationFn: async ({ vanId, captainId }: { vanId: string; captainId: string | null }) => {
      const { error } = await supabase.from("teams").update({ captain_id: captainId }).eq("id", vanId);
      if (error) throw error;
      if (captainId) {
        // Captain inherits van's office.
        const van = fleet.data?.vans.find((v) => v.id === vanId);
        const patch: { team_id: string; office_location?: string } = { team_id: vanId };
        if (van?.office_location) patch.office_location = van.office_location;
        await supabase.from("profiles").update(patch).eq("id", captainId);
      }
    },
    onSuccess: () => { toast.success("Captain assigned"); qc.invalidateQueries({ queryKey: ["fleet_manager"] }); },
    onError: (e: Error) => toast.error(e.message),
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

  const { vans, profiles: allProfiles, rolesByUser, pointsByUser, debugRecordCount } = fleet.data;
  const profiles = allProfiles.filter((p) => p.is_active !== false);
  const archivedProfiles = allProfiles.filter((p) => p.is_active === false);
  const captains = profiles.filter((p) => (rolesByUser.get(p.id) ?? []).includes("captain"));
  const unassigned = profiles.filter((p) => !p.team_id && !(rolesByUser.get(p.id) ?? []).includes("owner"));

  // Group vans by office location.
  const vansByOffice = new Map<string, typeof vans>();
  for (const loc of OFFICE_LOCATIONS) vansByOffice.set(loc, []);
  for (const v of vans) {
    const loc = (v.office_location as string) || "San Diego";
    if (!vansByOffice.has(loc)) vansByOffice.set(loc, []);
    vansByOffice.get(loc)!.push(v);
  }


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
                    const roster = profiles.filter((p) => p.team_id === v.id);
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
                            <div className="flex items-center gap-2 min-w-0">
                              <Truck className="w-4 h-4 shrink-0" style={{ color: v.color }} />
                              <TeamBadge name={v.name} color={v.color} />
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
                          {canManage ? (
                            <Select
                              value={v.captain_id ?? "none"}
                              onValueChange={(val) => setCaptain.mutate({ vanId: v.id, captainId: val === "none" ? null : val })}
                            >
                              <SelectTrigger><SelectValue placeholder="No captain" /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">— No captain —</SelectItem>
                                {captains.map((c) => (
                                  <SelectItem key={c.id} value={c.id}>{c.display_name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <div className="text-sm px-2 py-1.5 rounded border border-border bg-surface">
                              {captains.find((c) => c.id === v.captain_id)?.display_name ?? "— No captain —"}
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
                              return (
                                <RosterRow
                                  key={r.id}
                                  id={r.id}
                                  name={r.display_name ?? "Unknown"}
                                  points={pointsByUser.get(r.id) ?? 0}
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
  id, name, points, vans, currentVanId, onAssign, onUnassign, onDelete, canManage = true,
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
}) {
  const isGhost = points === 0;
  return (
    <div
      data-profile-id={id}
      className="flex items-center gap-2 px-2 py-1.5 rounded border border-border bg-surface hover:border-neon/60"
    >
      <span className="text-sm truncate flex-1">{name}</span>
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

