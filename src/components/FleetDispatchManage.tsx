import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, TeamBadge } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Truck,
  Plus,
  Building2,
  Trash2,
  UserMinus,
  Pencil,
  Check,
  X,
  UserPlus,
  Lock,
} from "lucide-react";
import { deleteProfile, deleteVan } from "@/lib/fleet.functions";
import { addTeamMember } from "@/lib/users.functions";
import { useAuth } from "@/hooks/useAuth";
import { isManagerRole } from "@/lib/roles";
import { formatCurrency, normalizeName } from "@/lib/utils";
import { DEFAULT_OFFICE, OFFICE_LOCATIONS, type OfficeLocation } from "@/lib/offices";
import type { RosterProfile, Van } from "@/components/FleetDispatch";

const VAN_COLORS = [
  "#ff007a",
  "#00f0ff",
  "#a855f7",
  "#f59e0b",
  "#22c55e",
  "#ef4444",
  "#3b82f6",
  "#eab308",
];

/**
 * The Manage Fleet section of the Fleet Dispatch board — vans, rosters,
 * free agents, and the archive. Receives all data as props from the board's
 * queries (one roster fetch serves both views); mutations invalidate the
 * shared ["fleet_dispatch"] key family.
 *
 * Membership here deliberately differs from the board: null is_active counts
 * as active (legacy Fleet Manager semantics), archived profiles get the
 * Reactivate dialog, and rosters dedupe per-van (first wins, captain
 * promoted) rather than globally.
 */
export function FleetDispatchManage({
  vans,
  profiles: allProfiles,
  rolesByUser,
  pointsByUser,
  volumeByUser,
}: {
  vans: Van[];
  profiles: RosterProfile[];
  rolesByUser: Map<string, string[]>;
  pointsByUser: Map<string, number>;
  volumeByUser: Map<string, number>;
}) {
  const qc = useQueryClient();
  const { realRole } = useAuth();
  const canManage = isManagerRole(realRole);
  const isOwnerRole = realRole === "owner";
  const [newVanName, setNewVanName] = useState("");
  const [newVanLoc, setNewVanLoc] = useState<OfficeLocation>(DEFAULT_OFFICE);
  const [newVanColor, setNewVanColor] = useState(VAN_COLORS[0]);
  const deleteProfileFn = useServerFn(deleteProfile);
  const deleteVanFn = useServerFn(deleteVan);
  const addTeamMemberFn = useServerFn(addTeamMember);
  const [editingVanId, setEditingVanId] = useState<string | null>(null);
  const [editVanName, setEditVanName] = useState("");
  const [editVanColor, setEditVanColor] = useState(VAN_COLORS[0]);
  const [editVanLoc, setEditVanLoc] = useState<OfficeLocation>(DEFAULT_OFFICE);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentOffice, setNewAgentOffice] = useState<OfficeLocation>(DEFAULT_OFFICE);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const reactivateAgent = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("reactivate_agent", { _user_id: userId });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Agent reactivated");
      qc.invalidateQueries({ queryKey: ["fleet_dispatch"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to reactivate"),
  });

  const createVan = useMutation({
    mutationFn: async () => {
      if (!newVanName.trim()) throw new Error("Van name required");
      const { error } = await supabase.from("teams").insert({
        name: newVanName.trim(),
        color: newVanColor,
        office_location: newVanLoc,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Van created");
      setNewVanName("");
      qc.invalidateQueries({ queryKey: ["fleet_dispatch"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const assignCanvasser = useMutation({
    mutationFn: async ({ canvasserId, vanId }: { canvasserId: string; vanId: string | null }) => {
      const patch: { team_id: string | null; office_location?: string } = { team_id: vanId };
      if (vanId) {
        const van = vans.find((v) => v.id === vanId);
        if (van?.office_location) patch.office_location = van.office_location;
      }
      const { error } = await supabase.from("profiles").update(patch).eq("id", canvasserId);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success(vars.vanId ? "Assigned to van" : "Moved to Unassigned");
      qc.invalidateQueries({ queryKey: ["fleet_dispatch"] });
      qc.invalidateQueries({ queryKey: ["weekly_results"] });
      qc.invalidateQueries({ queryKey: ["payroll-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeProfile = useMutation({
    mutationFn: async (id: string) => {
      await deleteProfileFn({ data: { id } });
    },
    onSuccess: () => {
      toast.success("Ghost profile deleted");
      qc.invalidateQueries({ queryKey: ["fleet_dispatch"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to delete"),
  });

  const updateVan = useMutation({
    mutationFn: async ({
      id,
      name,
      color,
      office_location,
    }: {
      id: string;
      name: string;
      color: string;
      office_location: OfficeLocation;
    }) => {
      if (!name.trim()) throw new Error("Van name required");
      const { error } = await supabase
        .from("teams")
        .update({ name: name.trim(), color, office_location })
        .eq("id", id);
      if (error) throw error;
      // Cascade office to roster.
      await supabase.from("profiles").update({ office_location }).eq("team_id", id);
    },
    onSuccess: () => {
      toast.success("Van updated");
      setEditingVanId(null);
      qc.invalidateQueries({ queryKey: ["fleet_dispatch"] });
      qc.invalidateQueries({ queryKey: ["weekly_results"] });
      qc.invalidateQueries({ queryKey: ["payroll-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeVan = useMutation({
    mutationFn: async (id: string) => {
      await deleteVanFn({ data: { id } });
    },
    onSuccess: () => {
      toast.success("Van deleted — members moved to Unassigned");
      qc.invalidateQueries({ queryKey: ["fleet_dispatch"] });
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
      qc.invalidateQueries({ queryKey: ["fleet_dispatch"] });
      qc.invalidateQueries({ queryKey: ["manage_users"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to add agent"),
  });

  function startEditVan(v: Van) {
    setEditingVanId(v.id);
    setEditVanName(v.name);
    setEditVanColor(v.color ?? VAN_COLORS[0]);
    setEditVanLoc((v.office_location as OfficeLocation) ?? DEFAULT_OFFICE);
  }

  // Legacy Fleet Manager semantics: null is_active counts as active here.
  const profiles = allProfiles.filter((p) => p.is_active !== false);
  const archivedProfiles = allProfiles.filter((p) => p.is_active === false);
  const captains = profiles.filter((p) => (rolesByUser.get(p.id) ?? []).includes("captain"));
  const unassigned = profiles.filter(
    (p) => !p.team_id && !(rolesByUser.get(p.id) ?? []).includes("owner"),
  );

  // Group vans by office location.
  const vansByOffice = new Map<string, Van[]>();
  for (const loc of OFFICE_LOCATIONS) vansByOffice.set(loc, []);
  for (const v of vans) {
    const loc = (v.office_location as string) || DEFAULT_OFFICE;
    if (!vansByOffice.has(loc)) vansByOffice.set(loc, []);
    vansByOffice.get(loc)!.push(v);
  }

  return (
    <div className="space-y-6">
      {!canManage && (
        <div className="arcade-card p-3 flex items-center gap-2 text-xs text-muted-foreground border border-border">
          <Lock className="w-3.5 h-3.5" /> Read-only view. Van assignments and roster edits are
          limited to Captains, Admins, and Owners.
        </div>
      )}

      {/* Create New Van — managers only */}
      {canManage && (
        <ArcadePanel title="Create New Van">
          <div className="grid gap-3 md:grid-cols-[1fr_180px_140px_auto] items-end">
            <div>
              <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                Van Name
              </label>
              <Input
                value={newVanName}
                onChange={(e) => setNewVanName(e.target.value)}
                placeholder="e.g. Phoenix Strike"
              />
            </div>
            <div>
              <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                Office Location
              </label>
              <Select value={newVanLoc} onValueChange={(v) => setNewVanLoc(v as OfficeLocation)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OFFICE_LOCATIONS.map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                Color
              </label>
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
            <Button
              onClick={() => createVan.mutate()}
              disabled={createVan.isPending}
              className="bg-neon text-background hover:bg-neon/90"
            >
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
                    const rosterMap = new Map<string, (typeof rosterRaw)[number]>();
                    for (const p of rosterRaw) {
                      const key = normalizeName(p.display_name) || `id:${p.id}`;
                      const prev = rosterMap.get(key);
                      if (!prev) rosterMap.set(key, p);
                      else if (
                        (rolesByUser.get(p.id) ?? []).includes("captain") &&
                        !(rolesByUser.get(prev.id) ?? []).includes("captain")
                      ) {
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
                                <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                                  Van Name
                                </label>
                                <Input
                                  value={editVanName}
                                  onChange={(e) => setEditVanName(e.target.value)}
                                />
                              </div>
                              <div>
                                <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                                  Office Location
                                </label>
                                <Select
                                  value={editVanLoc}
                                  onValueChange={(val) => setEditVanLoc(val as OfficeLocation)}
                                >
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {OFFICE_LOCATIONS.map((o) => (
                                      <SelectItem key={o} value={o}>
                                        {o}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                            <div>
                              <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                                Color
                              </label>
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
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditingVanId(null)}
                              >
                                <X className="w-3.5 h-3.5 mr-1" /> Cancel
                              </Button>
                              <Button
                                size="sm"
                                disabled={updateVan.isPending}
                                onClick={() =>
                                  updateVan.mutate({
                                    id: v.id,
                                    name: editVanName,
                                    color: editVanColor,
                                    office_location: editVanLoc,
                                  })
                                }
                                className="bg-neon text-background hover:bg-neon/90"
                              >
                                <Check className="w-3.5 h-3.5 mr-1" /> Save
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <Truck
                                className="w-4 h-4 shrink-0"
                                style={{ color: v.color ?? "#888" }}
                              />
                              <span className="min-w-0 truncate">
                                <TeamBadge name={v.name} color={v.color ?? "#888"} />
                              </span>
                              {v.captain_id && (
                                <span className="hidden sm:inline text-[10px] text-muted-foreground truncate min-w-0">
                                  ·{" "}
                                  {captains.find((c) => c.id === v.captain_id)?.display_name ?? ""}
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-1">
                              <span className="text-[10px] font-display uppercase tracking-widest hidden sm:flex items-center gap-1 mr-1 text-muted-foreground">
                                <Building2 className="w-3 h-3" />{" "}
                                {v.office_location ?? DEFAULT_OFFICE}
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
                                    if (
                                      confirm(
                                        `Delete van "${v.name}"? Members will be moved to Unassigned. This cannot be undone.`,
                                      )
                                    ) {
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
                            Roster ({roster.length}){" "}
                            <span className="opacity-60">· drop agents here</span>
                          </div>
                          <div className="space-y-1.5 min-h-[40px]">
                            {roster.map((r) => {
                              const targetIsOwner = (rolesByUser.get(r.id) ?? []).includes("owner");
                              const canModify = canManage && (isOwnerRole || !targetIsOwner);
                              // Sum points and sale volume across every profile with the same display name in this van.
                              const nameKey = normalizeName(r.display_name);
                              const sameNameProfiles = rosterRaw.filter(
                                (p) => normalizeName(p.display_name) === nameKey,
                              );
                              const aggregatedPoints = sameNameProfiles.reduce(
                                (sum, p) => sum + (pointsByUser.get(p.id) ?? 0),
                                0,
                              );
                              const aggregatedVolume = sameNameProfiles.reduce(
                                (sum, p) => sum + (volumeByUser.get(p.id) ?? 0),
                                0,
                              );
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
                                  onUnassign={
                                    canModify
                                      ? () =>
                                          assignCanvasser.mutate({ canvasserId: r.id, vanId: null })
                                      : undefined
                                  }
                                  onDelete={
                                    isOwnerRole
                                      ? () => {
                                          if (
                                            confirm(
                                              `Delete profile "${r.display_name}"? This removes the user permanently.`,
                                            )
                                          ) {
                                            removeProfile.mutate(r.id);
                                          }
                                        }
                                      : undefined
                                  }
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
              <h3
                className="font-display uppercase tracking-widest text-sm"
                style={{ color: "var(--neon-orange)" }}
              >
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
                    vans={
                      canModify
                        ? vans.map((v) => ({ id: v.id, name: v.name, color: v.color ?? "#888" }))
                        : undefined
                    }
                    currentVanId={p.team_id}
                    onAssign={
                      canModify
                        ? (vanId) => assignCanvasser.mutate({ canvasserId: p.id, vanId })
                        : undefined
                    }
                    onDelete={
                      isOwnerRole
                        ? () => {
                            if (
                              confirm(
                                `Delete profile "${p.display_name}"? This removes the user permanently.`,
                              )
                            ) {
                              removeProfile.mutate(p.id);
                            }
                          }
                        : undefined
                    }
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
            <DialogTitle className="font-display uppercase tracking-widest">
              Archived Agents
            </DialogTitle>
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
            <Button variant="ghost" onClick={() => setArchivedOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Agent modal */}
      <Dialog open={addAgentOpen} onOpenChange={setAddAgentOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display uppercase tracking-widest">Add Agent</DialogTitle>
            <DialogDescription>
              Creates a placeholder Canvasser in Free Agents. They can be assigned to a van right
              after.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label
                htmlFor="agent-name"
                className="text-[10px] font-display uppercase tracking-widest text-muted-foreground"
              >
                Full Name
              </Label>
              <Input
                id="agent-name"
                autoFocus
                value={newAgentName}
                onChange={(e) => setNewAgentName(e.target.value)}
                placeholder="e.g. Alex Morgan"
                onKeyDown={(e) => {
                  if (e.key === "Enter") addAgent.mutate();
                }}
              />
            </div>
            <div>
              <Label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                Office
              </Label>
              <Select
                value={newAgentOffice}
                onValueChange={(v) => setNewAgentOffice(v as OfficeLocation)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OFFICE_LOCATIONS.map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddAgentOpen(false)}>
              Cancel
            </Button>
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
  id,
  name,
  points,
  volume = 0,
  vans,
  currentVanId,
  onAssign,
  onUnassign,
  onDelete,
  isCaptain = false,
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
      <span
        className={`text-[10px] font-display ${isGhost ? "text-muted-foreground px-1.5" : "points-badge-glow"}`}
      >
        {points}p
      </span>

      {vans && onAssign && (
        <Select
          value={currentVanId ?? "none"}
          onValueChange={(val) => {
            if (val && val !== "none") onAssign(val);
          }}
        >
          <SelectTrigger className="h-9 md:h-7 w-full sm:w-auto sm:min-w-[120px] text-[11px] font-display uppercase tracking-wider bg-background border-[color:var(--neon-blue)]/50 hover:border-[color:var(--neon-blue)]">
            <SelectValue placeholder="Assign Van…" />
          </SelectTrigger>
          <SelectContent className="bg-background border-[color:var(--neon-blue)]/50">
            <SelectItem value="none" disabled>
              — Assign Van —
            </SelectItem>
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
      {/* Far right (owner, 2026-08-04): the person's sale volume — the
          Mon–Sat week in progress on Day/Week, the calendar month in
          Month view (follows the board's selected range). */}
      <span
        className={`shrink-0 min-w-[4.5rem] text-right text-[10px] font-display ${volume > 0 ? "text-victory" : "text-muted-foreground"} px-1.5`}
        title="Sale volume — Mon–Sat week in progress (calendar month in Month view)"
      >
        {formatCurrency(volume)}
      </span>
    </div>
  );
}
