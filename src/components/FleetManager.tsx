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
import { Truck, Plus, Building2, Trash2, UserMinus, Pencil, Check, X, ChevronLeft, ChevronRight, CalendarRange, UserPlus, Lock } from "lucide-react";
import { deleteProfile, deleteVan } from "@/lib/fleet.functions";
import { addTeamMember } from "@/lib/users.functions";
import { useAuth } from "@/hooks/useAuth";
import { isManagerRole } from "@/lib/roles";
import { formatCurrency } from "@/lib/utils";
import { weekStartMonday, toISODate, addDays, addDaysISO, laMidnightUtcISO } from "@/lib/dates";

// Week helpers — ISO week, Monday..Sunday. The fleet week is anchored to
// America/Los_Angeles via the shared helpers in @/lib/dates: all stats reset
// at midnight PT on Monday morning, regardless of the viewer's device timezone.
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

  // Week selector — default to current Monday-anchored week (Pacific time).
  const [weekStart, setWeekStart] = useState<Date>(() => weekStartMonday());
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);
  const weekStartISO = useMemo(() => toISODate(weekStart), [weekStart]);
  const weekEndISO = useMemo(() => toISODate(weekEnd), [weekEnd]);
  // created_at window: LA-midnight Monday → LA-midnight next Monday (exclusive).
  const selectedDateRange = useMemo(
    () => ({
      startDate: laMidnightUtcISO(weekStartISO),
      endDate: laMidnightUtcISO(addDaysISO(weekStartISO, 7)),
    }),
    [weekStartISO],
  );
  const isCurrentWeek = useMemo(
    () => toISODate(weekStartMonday()) === weekStartISO,
    [weekStartISO],
  );

  const fleet = useQuery({
    queryKey: ["fleet_manager", weekStartISO, weekEndISO, selectedDateRange.startDate, selectedDateRange.endDate],
    queryFn: async () => {
      const { startDate, endDate } = selectedDateRange;
      // Van Volume window: Monday 00:00 → next Monday 00:00, Pacific time.
      const volStartISO = startDate;
      const volEndISO = endDate;
      const [vansR, profilesR, rolesR, metricsByCreatedR, metricsByDateR, logsByDateR, leadsR] = await Promise.all([
        supabase.from("teams").select("id, name, color, captain_id, office_location").order("name"),
        supabase.from("profiles").select("id, display_name, team_id, office_location, is_active").order("display_name"),
        supabase.from("user_roles").select("user_id, role"),
        // Monday.com webhooks save schedule outcomes into daily_metrics.
        supabase
          .from("daily_metrics")
          .select("id, canvasser_id, pitch_missed, sales, leads_submitted, leads_confirmed, no_answers, killed, pending, metric_date, created_at")
          .gte("created_at", startDate)
          .lt("created_at", endDate),
        supabase
          .from("daily_metrics")
          .select("id, canvasser_id, pitch_missed, sales, leads_submitted, leads_confirmed, no_answers, killed, pending, metric_date, created_at")
          .gte("metric_date", weekStartISO)
          .lte("metric_date", weekEndISO),

        supabase
          .from("daily_logs")
          .select("id, canvasser_id, demos_sits, sales, log_date, created_at")
          .gte("log_date", weekStartISO)
          .lte("log_date", weekEndISO),
        // Confirmed sale dollars for Van Volume — same attribution as the pay
        // engine (COALESCE(reviewed_at, created_at)), windowed to the PT week.
        supabase
          .from("leads")
          .select("canvasser_id, sale_amount, created_at, reviewed_at")
          .eq("status", "confirmed")
          .or(
            `and(created_at.gte.${volStartISO},created_at.lt.${volEndISO}),and(reviewed_at.gte.${volStartISO},reviewed_at.lt.${volEndISO})`,
          ),
      ]);
      if (vansR.error) throw vansR.error;
      if (profilesR.error) throw profilesR.error;
      if (rolesR.error) throw rolesR.error;
      if (metricsByCreatedR.error) throw metricsByCreatedR.error;
      if (metricsByDateR.error) throw metricsByDateR.error;
      if (logsByDateR.error) throw logsByDateR.error;
      if (leadsR.error) throw leadsR.error;
      const rolesByUser = new Map<string, string[]>();
      for (const r of rolesR.data ?? []) {
        const arr = rolesByUser.get(r.user_id) ?? [];
        arr.push(r.role);
        rolesByUser.set(r.user_id, arr);
      }
      const metricRows = Array.from(
        new Map([...(metricsByCreatedR.data ?? []), ...(metricsByDateR.data ?? [])].map((row) => [row.id, row])).values(),
      );
      const logRows = logsByDateR.data ?? [];
      const pointsByUser = new Map<string, number>();
      const submitsByUser = new Map<string, number>();
      const confirmedByUser = new Map<string, number>();
      for (const m of metricRows) {
        if (!m.canvasser_id) continue;
        const conf = m.leads_confirmed ?? 0;
        const kil = (m as { killed?: number | null }).killed ?? 0;
        const pen = (m as { pending?: number | null }).pending ?? 0;
        const na = (m as { no_answers?: number | null }).no_answers ?? 0;
        const sub = conf + kil + pen + na;
        submitsByUser.set(m.canvasser_id, (submitsByUser.get(m.canvasser_id) ?? 0) + sub);
        confirmedByUser.set(m.canvasser_id, (confirmedByUser.get(m.canvasser_id) ?? 0) + conf);
      }
      // Points must mirror calc_weekly_paycheck (the Payroll pay engine):
      // SUM(demos_sits + sales) from daily_logs, log_date Mon–Sat. demos_sits
      // already includes sales, so this is sit = 1 pt, sale = 2 pts.
      const engineWeekEndISO = toISODate(addDays(weekStart, 5));
      for (const l of logRows) {
        if (!l.canvasser_id || l.log_date > engineWeekEndISO) continue;
        const pts = (l.demos_sits ?? 0) + (l.sales ?? 0);
        if (pts > 0) pointsByUser.set(l.canvasser_id, (pointsByUser.get(l.canvasser_id) ?? 0) + pts);
      }
      // Van Volume: confirmed sale dollars per canvasser, attributed to the
      // week containing COALESCE(reviewed_at, created_at) in Pacific time.
      const volumeByUser = new Map<string, number>();
      const volStartMs = Date.parse(volStartISO);
      const volEndMs = Date.parse(volEndISO);
      for (const l of leadsR.data ?? []) {
        if (!l.canvasser_id) continue;
        const at = Date.parse(l.reviewed_at ?? l.created_at ?? "");
        if (Number.isNaN(at) || at < volStartMs || at >= volEndMs) continue;
        volumeByUser.set(l.canvasser_id, (volumeByUser.get(l.canvasser_id) ?? 0) + Number(l.sale_amount ?? 0));
      }
      return {
        vans: vansR.data ?? [],
        profiles: profilesR.data ?? [],
        rolesByUser,
        pointsByUser,
        submitsByUser,
        confirmedByUser,
        volumeByUser,
        debugRecordCount: metricRows.length + logRows.length,
      };

    },
  });

  // Live updates — refresh as Monday webhooks arrive: daily_logs feeds the
  // points badges, daily_metrics feeds submits/confirmed.
  useEffect(() => {
    const ch = supabase
      .channel("fleet-live-metrics")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "daily_metrics" },
        () => qc.invalidateQueries({ queryKey: ["fleet_manager"] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "daily_logs" },
        () => qc.invalidateQueries({ queryKey: ["fleet_manager"] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "leads" },
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

  const { vans, profiles: allProfiles, rolesByUser, pointsByUser, submitsByUser, confirmedByUser, volumeByUser, debugRecordCount } = fleet.data;
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

  const vanVolume = (vanId: string) =>
    profiles
      .filter((p) => p.team_id === vanId)
      .reduce((sum, p) => sum + (volumeByUser.get(p.id) ?? 0), 0);




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
            <div className="px-3 py-1.5 rounded border border-neon/40 bg-neon/5 flex items-center gap-2 min-w-0 flex-1 text-center sm:min-w-[240px] justify-center">
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
              onClick={() => setWeekStart(weekStartMonday())}
            >
              Jump to current week
            </Button>
          )}
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          Points below reflect Mon–Sat of the selected week, Pacific time (PM = 1 pt, Sale = 2 pts; BO/RS = 0).
        </p>
        <p className="mt-1 text-[10px] text-muted-foreground/60">
          Records found: {debugRecordCount}
        </p>
      </ArcadePanel>

      {/* Tier 1 — Global Fleet Scoreboard (sticky on scroll) */}
      {/* top-14 clears AppShell's 56px sticky mobile header; z-10 keeps it under it. */}
      <div className="sticky top-14 md:top-16 z-10 -mx-2 md:mx-0 px-2 md:px-0 py-2 bg-background/85 backdrop-blur border-b border-neon/20">
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
              <div className="flex gap-1.5 md:gap-1 mt-1">
                {VAN_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setNewVanColor(c)}
                    className={`w-9 h-9 md:w-6 md:h-6 rounded ${newVanColor === c ? "ring-2 ring-offset-1 ring-offset-background ring-foreground" : ""}`}
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
                              <div className="flex gap-1.5 md:gap-1 mt-1">
                                {VAN_COLORS.map((c) => (
                                  <button
                                    key={c}
                                    onClick={() => setEditVanColor(c)}
                                    className={`w-9 h-9 md:w-6 md:h-6 rounded ${editVanColor === c ? "ring-2 ring-offset-1 ring-offset-background ring-foreground" : ""}`}
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
                              <span className="min-w-0 truncate">
                                <TeamBadge name={v.name} color={v.color} />
                              </span>
                              <span
                                className="shrink-0 text-[10px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-neon/50 text-neon bg-neon/10"
                                title="Total van points this week"
                              >
                                {vanTotalPoints(v.id)}p
                              </span>
                              <span
                                className="shrink-0 text-[10px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-victory/50 text-victory bg-victory/10"
                                title="Van Volume — confirmed sale dollars this week (resets Monday 12:01 AM PT)"
                              >
                                {formatCurrency(vanVolume(v.id))}
                              </span>
                              {v.captain_id && (
                                <span className="hidden sm:inline text-[10px] text-muted-foreground truncate min-w-0">
                                  · {captains.find((c) => c.id === v.captain_id)?.display_name ?? ""}
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-1">
                              <span className="text-[10px] font-display uppercase tracking-widest hidden sm:flex items-center gap-1 mr-1 text-muted-foreground">
                                <Building2 className="w-3 h-3" /> {v.office_location ?? "San Diego"}
                              </span>
                              {canManage && (
                                <button
                                  onClick={() => startEditVan(v)}
                                  className="p-2 md:p-1 min-h-9 min-w-9 md:min-h-0 md:min-w-0 inline-flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
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
                                  className="p-2 md:p-1 min-h-9 min-w-9 md:min-h-0 md:min-w-0 inline-flex items-center justify-center rounded hover:bg-destructive/20 text-destructive"
                                  title="Delete van (Owner only)"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                        )}

                        <div>
                          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-1">
                            Roster ({roster.length}) <span className="opacity-60">· drop agents here</span>
                          </div>
                          <div className="space-y-1.5 min-h-[40px]">
                            {roster.map((r) => {
                              const targetIsOwner = (rolesByUser.get(r.id) ?? []).includes("owner");
                              const canModify = canManage && (isOwnerRole || !targetIsOwner);
                              // Sum points and sale volume across every profile with the same display name in this van.
                              const nameKey = (r.display_name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
                              const sameNameProfiles = rosterRaw.filter(
                                (p) => ((p.display_name ?? "").trim().toLowerCase().replace(/\s+/g, " ")) === nameKey,
                              );
                              const aggregatedPoints = sameNameProfiles.reduce((sum, p) => sum + (pointsByUser.get(p.id) ?? 0), 0);
                              const aggregatedVolume = sameNameProfiles.reduce((sum, p) => sum + (volumeByUser.get(p.id) ?? 0), 0);
                              const rIsCaptain =
                                v.captain_id === r.id ||
                                (rolesByUser.get(r.id) ?? []).includes("captain");
                              return (
                                <RosterRow
                                  key={r.id}
                                  id={r.id}
                                  name={r.display_name ?? "Unknown"}
                                  points={aggregatedPoints}
                                  volume={aggregatedVolume}
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
                    volume={volumeByUser.get(p.id) ?? 0}
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
  id, name, points, volume = 0, vans, currentVanId, onAssign, onUnassign, onDelete, canManage = true, isCaptain = false,
}: {
  id: string;
  name: string;
  points: number;
  volume?: number;
  vans?: VanOption[];
  currentVanId?: string | null;
  onAssign?: (vanId: string) => void;
  onUnassign?: () => void;
  onDelete?: () => void;
  canManage?: boolean;
  isCaptain?: boolean;
}) {
  const isGhost = points === 0 && volume === 0;
  return (
    <div
      data-profile-id={id}
      className="flex flex-wrap sm:flex-nowrap items-center gap-2 px-2 py-1.5 rounded border border-border bg-surface hover:border-neon/60"
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
      <span
        className={`shrink-0 text-[10px] font-display ${volume > 0 ? "text-victory" : "text-muted-foreground"} px-1.5`}
        title="Weekly sale volume (resets Monday 12:01 AM PT)"
      >
        {formatCurrency(volume)}
      </span>

      {vans && onAssign && (
        <Select
          value={currentVanId ?? "none"}
          onValueChange={(val) => { if (val && val !== "none") onAssign(val); }}
        >
          <SelectTrigger
            className="h-9 md:h-7 w-full sm:w-auto sm:min-w-[120px] text-[11px] font-display uppercase tracking-wider bg-background border-[color:var(--neon-blue)]/50 hover:border-[color:var(--neon-blue)]"
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
          className="p-2 md:p-1 min-h-9 min-w-9 md:min-h-0 md:min-w-0 inline-flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          title="Move to Free Agents"
        >
          <UserMinus className="w-3.5 h-3.5" />
        </button>
      )}
      {onDelete && (
        <button
          onClick={onDelete}
          className="p-2 md:p-1 min-h-9 min-w-9 md:min-h-0 md:min-w-0 inline-flex items-center justify-center rounded hover:bg-destructive/20 text-destructive"
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


