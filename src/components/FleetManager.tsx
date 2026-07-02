import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, TeamBadge } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Truck, Plus, Building2, Trash2, UserMinus, GripVertical, Pencil, Check, X, ChevronLeft, ChevronRight, CalendarRange } from "lucide-react";
import { deleteProfile, deleteVan } from "@/lib/fleet.functions";

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

type DragPayload = { id: string; name: string };

export function FleetManager() {
  const qc = useQueryClient();
  const [newVanName, setNewVanName] = useState("");
  const [newVanLoc, setNewVanLoc] = useState<OfficeLocation>("San Diego");
  const [newVanColor, setNewVanColor] = useState(VAN_COLORS[0]);
  const [dragOverVan, setDragOverVan] = useState<string | null>(null);
  const [dragOverUnassigned, setDragOverUnassigned] = useState(false);
  const deleteProfileFn = useServerFn(deleteProfile);
  const deleteVanFn = useServerFn(deleteVan);
  const [editingVanId, setEditingVanId] = useState<string | null>(null);
  const [editVanName, setEditVanName] = useState("");
  const [editVanColor, setEditVanColor] = useState(VAN_COLORS[0]);
  const [editVanLoc, setEditVanLoc] = useState<OfficeLocation>("San Diego");

  // Week selector — default to current Monday-anchored week.
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeekMonday(new Date()));
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);
  const weekStartISO = useMemo(() => toISODate(weekStart), [weekStart]);
  const weekEndISO = useMemo(() => toISODate(weekEnd), [weekEnd]);
  const isCurrentWeek = useMemo(
    () => toISODate(startOfWeekMonday(new Date())) === weekStartISO,
    [weekStartISO],
  );

  const fleet = useQuery({
    queryKey: ["fleet_manager", weekStartISO, weekEndISO],
    queryFn: async () => {
      const [vansR, profilesR, rolesR, metricsR] = await Promise.all([
        supabase.from("teams").select("id, name, color, captain_id, office_location").order("name"),
        supabase.from("profiles").select("id, display_name, team_id, office_location").order("display_name"),
        supabase.from("user_roles").select("user_id, role"),
        supabase
          .from("daily_metrics")
          .select("canvasser_id, pitch_missed, sales, metric_date")
          .gte("metric_date", weekStartISO)
          .lte("metric_date", weekEndISO),
      ]);
      if (vansR.error) throw vansR.error;
      if (profilesR.error) throw profilesR.error;
      if (rolesR.error) throw rolesR.error;
      if (metricsR.error) throw metricsR.error;
      const rolesByUser = new Map<string, string[]>();
      for (const r of rolesR.data ?? []) {
        const arr = rolesByUser.get(r.user_id) ?? [];
        arr.push(r.role);
        rolesByUser.set(r.user_id, arr);
      }
      // Weekly points: PM = 1 pt, Sale = 2 pts. BO/RS/basic leads = 0.
      const pointsByUser = new Map<string, number>();
      for (const m of metricsR.data ?? []) {
        const pts = (m.pitch_missed ?? 0) * 1 + (m.sales ?? 0) * 2;
        pointsByUser.set(m.canvasser_id, (pointsByUser.get(m.canvasser_id) ?? 0) + pts);
      }
      return {
        vans: vansR.data ?? [],
        profiles: profilesR.data ?? [],
        rolesByUser,
        pointsByUser,
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

  function startEditVan(v: { id: string; name: string; color: string; office_location: string | null }) {
    setEditingVanId(v.id);
    setEditVanName(v.name);
    setEditVanColor(v.color);
    setEditVanLoc((v.office_location as OfficeLocation) ?? "San Diego");
  }

  if (fleet.isLoading || !fleet.data) {
    return <div className="text-sm text-muted-foreground">Loading fleet…</div>;
  }

  const { vans, profiles, rolesByUser, pointsByUser } = fleet.data;
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

  function onDragStart(e: React.DragEvent, payload: DragPayload) {
    e.dataTransfer.setData("application/json", JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "move";
  }
  function onVanDragOver(e: React.DragEvent, vanId: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverVan(vanId);
  }
  function onVanDrop(e: React.DragEvent, vanId: string) {
    e.preventDefault();
    setDragOverVan(null);
    try {
      const p = JSON.parse(e.dataTransfer.getData("application/json")) as DragPayload;
      if (p.id) assignCanvasser.mutate({ canvasserId: p.id, vanId });
    } catch {/* noop */}
  }
  function onUnassignedDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOverUnassigned(false);
    try {
      const p = JSON.parse(e.dataTransfer.getData("application/json")) as DragPayload;
      if (p.id) assignCanvasser.mutate({ canvasserId: p.id, vanId: null });
    } catch {/* noop */}
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
      </ArcadePanel>

      {/* Create New Van */}
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
                    const isOver = dragOverVan === v.id;
                    return (
                      <div
                        key={v.id}
                        onDragOver={(e) => onVanDragOver(e, v.id)}
                        onDragLeave={() => setDragOverVan((cur) => (cur === v.id ? null : cur))}
                        onDrop={(e) => onVanDrop(e, v.id)}
                        className={`arcade-card p-4 space-y-3 transition-all ${
                          isOver ? "ring-2 ring-neon shadow-[0_0_24px_color-mix(in_oklab,var(--neon)_50%,transparent)]" : ""
                        }`}
                        style={isOver ? { borderColor: v.color } : undefined}
                      >
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
                              <button
                                onClick={() => startEditVan(v)}
                                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                                title="Edit van"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => {
                                  if (confirm(`Delete van "${v.name}"? Members will be moved to Unassigned. This cannot be undone.`)) {
                                    removeVan.mutate(v.id);
                                  }
                                }}
                                className="p-1 rounded hover:bg-destructive/20 text-destructive"
                                title="Delete van"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        )}

                        <div>
                          <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Captain</label>
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
                        </div>

                        <div>
                          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-1">
                            Roster ({roster.length}) <span className="opacity-60">· drop agents here</span>
                          </div>
                          <div className="space-y-1.5 min-h-[40px]">
                            {roster.map((r) => (
                              <RosterRow
                                key={r.id}
                                id={r.id}
                                name={r.display_name ?? "Unknown"}
                                points={pointsByUser.get(r.id) ?? 0}
                                onDragStart={(e) => onDragStart(e, { id: r.id, name: r.display_name ?? "" })}
                                onUnassign={() => assignCanvasser.mutate({ canvasserId: r.id, vanId: null })}
                                onDelete={() => {
                                  if (confirm(`Delete profile "${r.display_name}"? This removes the user permanently.`)) {
                                    removeProfile.mutate(r.id);
                                  }
                                }}
                              />
                            ))}
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

        {/* Unassigned holding pen */}
        <ArcadePanel title={`Unassigned Agents (${unassigned.length})`}>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOverUnassigned(true); }}
            onDragLeave={() => setDragOverUnassigned(false)}
            onDrop={onUnassignedDrop}
            className={`min-h-[200px] rounded-lg border border-dashed p-2 space-y-1.5 transition-colors ${
              dragOverUnassigned ? "border-neon bg-neon/5" : "border-border"
            }`}
          >
            {unassigned.length === 0 ? (
              <div className="text-xs text-muted-foreground italic px-2 py-6 text-center">
                All profiles assigned. CSV-imported ghosts will appear here.
              </div>
            ) : (
              unassigned.map((p) => (
                <RosterRow
                  key={p.id}
                  id={p.id}
                  name={p.display_name ?? "Unknown"}
                  points={pointsByUser.get(p.id) ?? 0}
                  onDragStart={(e) => onDragStart(e, { id: p.id, name: p.display_name ?? "" })}
                  onDelete={() => {
                    if (confirm(`Delete profile "${p.display_name}"? This removes the user permanently.`)) {
                      removeProfile.mutate(p.id);
                    }
                  }}
                />
              ))
            )}
          </div>
          <p className="mt-3 text-[10px] text-muted-foreground">
            Drag a name onto a Van to assign. New CSV agents default to San Diego.
          </p>
        </ArcadePanel>
      </div>
    </div>
  );
}

function RosterRow({
  id, name, points, onDragStart, onUnassign, onDelete,
}: {
  id: string;
  name: string;
  points: number;
  onDragStart: (e: React.DragEvent) => void;
  onUnassign?: () => void;
  onDelete: () => void;
}) {
  const isGhost = points === 0;
  return (
    <div
      draggable
      onDragStart={onDragStart}
      data-profile-id={id}
      className="flex items-center gap-2 px-2 py-1.5 rounded border border-border bg-surface hover:border-neon/60 cursor-grab active:cursor-grabbing"
    >
      <GripVertical className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <span className="text-sm truncate flex-1">{name}</span>
      <span className={`text-[10px] font-display ${isGhost ? "text-muted-foreground" : "text-victory"}`}>
        {points}p
      </span>
      {onUnassign && (
        <button
          onClick={onUnassign}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          title="Move to Unassigned"
        >
          <UserMinus className="w-3.5 h-3.5" />
        </button>
      )}
      <button
        onClick={onDelete}
        className="p-1 rounded hover:bg-destructive/20 text-destructive"
        title={isGhost ? "Delete ghost profile" : "Delete profile (has data)"}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
