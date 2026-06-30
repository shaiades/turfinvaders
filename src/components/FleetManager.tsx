import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, TeamBadge } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Truck, Plus, Building2, Trash2, UserMinus, GripVertical, Pencil, Check, X } from "lucide-react";
import { deleteProfile, deleteVan } from "@/lib/fleet.functions";

const VAN_COLORS = ["#ff007a", "#00f0ff", "#a855f7", "#f59e0b", "#22c55e", "#ef4444", "#3b82f6", "#eab308"];

type DragPayload = { id: string; name: string };

export function FleetManager() {
  const qc = useQueryClient();
  const [newVanName, setNewVanName] = useState("");
  const [newVanOffice, setNewVanOffice] = useState<string | null>(null);
  const [newVanColor, setNewVanColor] = useState(VAN_COLORS[0]);
  const [dragOverVan, setDragOverVan] = useState<string | null>(null);
  const [dragOverUnassigned, setDragOverUnassigned] = useState(false);
  const deleteProfileFn = useServerFn(deleteProfile);
  const deleteVanFn = useServerFn(deleteVan);
  const [editingVanId, setEditingVanId] = useState<string | null>(null);
  const [editVanName, setEditVanName] = useState("");
  const [editVanColor, setEditVanColor] = useState(VAN_COLORS[0]);
  const [editVanOffice, setEditVanOffice] = useState<string | null>(null);

  const fleet = useQuery({
    queryKey: ["fleet_manager"],
    queryFn: async () => {
      const [vansR, profilesR, rolesR, officesR, logsR] = await Promise.all([
        supabase.from("teams").select("id, name, color, captain_id, office_id").order("name"),
        supabase.from("profiles").select("id, display_name, team_id").order("display_name"),
        supabase.from("user_roles").select("user_id, role"),
        supabase.from("offices").select("id, name, color").order("name"),
        supabase.from("daily_logs").select("canvasser_id, demos_sits, sales"),
      ]);
      if (vansR.error) throw vansR.error;
      if (profilesR.error) throw profilesR.error;
      if (rolesR.error) throw rolesR.error;
      if (officesR.error) throw officesR.error;
      if (logsR.error) throw logsR.error;
      const rolesByUser = new Map<string, string[]>();
      for (const r of rolesR.data ?? []) {
        const arr = rolesByUser.get(r.user_id) ?? [];
        arr.push(r.role);
        rolesByUser.set(r.user_id, arr);
      }
      const pointsByUser = new Map<string, number>();
      for (const l of logsR.data ?? []) {
        pointsByUser.set(
          l.canvasser_id,
          (pointsByUser.get(l.canvasser_id) ?? 0) + (l.demos_sits ?? 0) + (l.sales ?? 0),
        );
      }
      return {
        vans: vansR.data ?? [],
        profiles: profilesR.data ?? [],
        offices: officesR.data ?? [],
        rolesByUser,
        pointsByUser,
      };
    },
  });

  const createVan = useMutation({
    mutationFn: async () => {
      if (!newVanName.trim()) throw new Error("Van name required");
      const { error } = await supabase.from("teams").insert({
        name: newVanName.trim(), color: newVanColor, office_id: newVanOffice,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Van created");
      setNewVanName("");
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
      qc.invalidateQueries({ queryKey: ["offices"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setCaptain = useMutation({
    mutationFn: async ({ vanId, captainId }: { vanId: string; captainId: string | null }) => {
      const { error } = await supabase.from("teams").update({ captain_id: captainId }).eq("id", vanId);
      if (error) throw error;
      if (captainId) await supabase.from("profiles").update({ team_id: vanId }).eq("id", captainId);
    },
    onSuccess: () => { toast.success("Captain assigned"); qc.invalidateQueries({ queryKey: ["fleet_manager"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const assignCanvasser = useMutation({
    mutationFn: async ({ canvasserId, vanId }: { canvasserId: string; vanId: string | null }) => {
      const { error } = await supabase.from("profiles").update({ team_id: vanId }).eq("id", canvasserId);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success(vars.vanId ? "Assigned to van" : "Moved to Unassigned");
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
      qc.invalidateQueries({ queryKey: ["performance-matrix"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeProfile = useMutation({
    mutationFn: async (id: string) => {
      await deleteProfileFn({ data: { id } });
    },
    onSuccess: () => {
      toast.success("Ghost profile deleted");
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
      qc.invalidateQueries({ queryKey: ["performance-matrix"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to delete"),
  });

  const updateVan = useMutation({
    mutationFn: async ({ id, name, color, office_id }: { id: string; name: string; color: string; office_id: string | null }) => {
      if (!name.trim()) throw new Error("Van name required");
      const { error } = await supabase.from("teams")
        .update({ name: name.trim(), color, office_id })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Van updated");
      setEditingVanId(null);
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
      qc.invalidateQueries({ queryKey: ["offices"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeVan = useMutation({
    mutationFn: async (id: string) => { await deleteVanFn({ data: { id } }); },
    onSuccess: () => {
      toast.success("Van deleted — members moved to Unassigned");
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
      qc.invalidateQueries({ queryKey: ["offices"] });
      qc.invalidateQueries({ queryKey: ["performance-matrix"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to delete van"),
  });

  function startEditVan(v: { id: string; name: string; color: string; office_id: string | null }) {
    setEditingVanId(v.id);
    setEditVanName(v.name);
    setEditVanColor(v.color);
    setEditVanOffice(v.office_id);
  }

  if (fleet.isLoading || !fleet.data) {
    return <div className="text-sm text-muted-foreground">Loading fleet…</div>;
  }

  const { vans, profiles, offices, rolesByUser, pointsByUser } = fleet.data;
  const captains = profiles.filter((p) => (rolesByUser.get(p.id) ?? []).includes("captain"));
  const unassigned = profiles.filter((p) => !p.team_id && !(rolesByUser.get(p.id) ?? []).includes("owner"));

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
      {/* Create Van */}
      <ArcadePanel title="Create New Van">
        <div className="grid gap-3 md:grid-cols-[1fr_180px_140px_auto] items-end">
          <div>
            <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Van Name</label>
            <Input value={newVanName} onChange={(e) => setNewVanName(e.target.value)} placeholder="e.g. Phoenix Strike" />
          </div>
          <div>
            <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Office</label>
            <Select value={newVanOffice ?? "none"} onValueChange={(v) => setNewVanOffice(v === "none" ? null : v)}>
              <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unassigned</SelectItem>
                {offices.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
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
        {/* Vans */}
        <ArcadePanel title={`Fleet (${vans.length} Vans)`}>
          {vans.length === 0 ? (
            <div className="text-sm text-muted-foreground">No vans yet. Create your first one above.</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {vans.map((v) => {
                const office = offices.find((o) => o.id === v.office_id);
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
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 min-w-0">
                        <Truck className="w-4 h-4 shrink-0" style={{ color: v.color }} />
                        <TeamBadge name={v.name} color={v.color} />
                      </div>
                      {office && (
                        <span className="text-[10px] font-display uppercase tracking-widest flex items-center gap-1" style={{ color: office.color }}>
                          <Building2 className="w-3 h-3" /> {office.name}
                        </span>
                      )}
                    </div>

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
            Drag a name onto a Van to assign. Use the trash icon to delete ghost profiles (0 points = safe to remove).
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
