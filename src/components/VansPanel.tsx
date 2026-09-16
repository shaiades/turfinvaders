import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, TeamBadge } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Building2, Check, Pencil, Plus, Trash2, Truck, X } from "lucide-react";
import { deleteVan } from "@/lib/fleet.functions";
import { DEFAULT_OFFICE, OFFICE_LOCATIONS, type OfficeLocation } from "@/lib/offices";
import type { RosterProfile, Van } from "@/hooks/useFleetRoster";
import { normalizeName } from "@/lib/utils";

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
 * Van create/edit/delete — lived inside Fleet Dispatch's Manage Fleet until
 * 2026-09-16, now on Manage Players where the rest of the org admin is.
 * Admin tier (teams RLS: "Admins manage teams"); the page's beforeLoad
 * already guarantees that. Editing an office cascades it onto the roster,
 * matching the old Manage Fleet behavior.
 */
export function VansPanel({
  vans,
  profiles,
  rolesByUser,
}: {
  vans: Van[];
  profiles: RosterProfile[];
  rolesByUser: Map<string, string[]>;
}) {
  const qc = useQueryClient();
  const deleteVanFn = useServerFn(deleteVan);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newLoc, setNewLoc] = useState<OfficeLocation>(DEFAULT_OFFICE);
  const [newColor, setNewColor] = useState(VAN_COLORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(VAN_COLORS[0]);
  const [editLoc, setEditLoc] = useState<OfficeLocation>(DEFAULT_OFFICE);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["fleet_dispatch"] });
    qc.invalidateQueries({ queryKey: ["manage_users"] });
    qc.invalidateQueries({ queryKey: ["weekly_results"] });
    qc.invalidateQueries({ queryKey: ["payroll-ledger"] });
  };

  const createVan = useMutation({
    mutationFn: async () => {
      if (!newName.trim()) throw new Error("Van name required");
      const { error } = await supabase.from("teams").insert({
        name: newName.trim(),
        color: newColor,
        office_location: newLoc,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Van created");
      setNewName("");
      setCreating(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
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
      // Cascade office to roster (same rule as van moves).
      await supabase.from("profiles").update({ office_location }).eq("team_id", id);
    },
    onSuccess: () => {
      toast.success("Van updated");
      setEditingId(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeVan = useMutation({
    mutationFn: async (id: string) => {
      await deleteVanFn({ data: { id } });
    },
    onSuccess: () => {
      toast.success("Van deleted — members moved to Free Agents");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to delete van"),
  });

  const active = profiles.filter((p) => p.is_active !== false);
  const memberCount = (vanId: string) => {
    const seen = new Set<string>();
    for (const p of active) {
      if (p.team_id !== vanId) continue;
      seen.add(normalizeName(p.display_name) || `id:${p.id}`);
    }
    return seen.size;
  };
  const captainNames = (vanId: string) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of active) {
      if (p.team_id !== vanId) continue;
      if (!(rolesByUser.get(p.id) ?? []).includes("captain")) continue;
      const key = normalizeName(p.display_name) || `id:${p.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (p.display_name) out.push(p.display_name);
    }
    return out;
  };

  const colorDots = (value: string, onPick: (c: string) => void) => (
    <div className="flex gap-1.5 mt-1 flex-wrap">
      {VAN_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onPick(c)}
          className={`w-8 h-8 md:w-6 md:h-6 rounded ${value === c ? "ring-2 ring-offset-1 ring-offset-background ring-foreground" : ""}`}
          style={{ background: c }}
          aria-label={`color ${c}`}
        />
      ))}
    </div>
  );

  return (
    <ArcadePanel
      title={`Vans (${vans.length})`}
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => setCreating((c) => !c)}
          className="gap-1.5 font-display uppercase tracking-widest text-[10px]"
        >
          <Plus className="w-3.5 h-3.5" /> New Van
        </Button>
      }
    >
      {creating && (
        <div className="mb-4 p-3 rounded border border-neon/40 bg-neon/5 space-y-2">
          <div className="grid gap-2 md:grid-cols-[1fr_180px]">
            <div>
              <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                Van Name
              </label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Phoenix Strike"
                autoFocus
              />
            </div>
            <div>
              <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                Office
              </label>
              <Select value={newLoc} onValueChange={(v) => setNewLoc(v as OfficeLocation)}>
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
          {colorDots(newColor, setNewColor)}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={createVan.isPending || !newName.trim()}
              onClick={() => createVan.mutate()}
              className="bg-neon text-background hover:bg-neon/90"
            >
              <Plus className="w-3.5 h-3.5 mr-1" /> Create Van
            </Button>
          </div>
        </div>
      )}

      {vans.length === 0 ? (
        <div className="text-sm text-muted-foreground italic">No vans yet.</div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {vans.map((v) => {
            const caps = captainNames(v.id);
            return editingId === v.id ? (
              <div key={v.id} className="p-3 rounded border border-neon/40 bg-neon/5 space-y-2">
                <div className="grid gap-2">
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                  <Select value={editLoc} onValueChange={(v2) => setEditLoc(v2 as OfficeLocation)}>
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
                {colorDots(editColor, setEditColor)}
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                    <X className="w-3.5 h-3.5 mr-1" /> Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={updateVan.isPending}
                    onClick={() =>
                      updateVan.mutate({
                        id: v.id,
                        name: editName,
                        color: editColor,
                        office_location: editLoc,
                      })
                    }
                    className="bg-neon text-background hover:bg-neon/90"
                  >
                    <Check className="w-3.5 h-3.5 mr-1" /> Save
                  </Button>
                </div>
              </div>
            ) : (
              <div
                key={v.id}
                className="flex items-center gap-2 px-3 py-2.5 rounded border border-border bg-surface min-w-0"
              >
                <Truck className="w-4 h-4 shrink-0" style={{ color: v.color ?? "#888" }} />
                <div className="min-w-0 flex-1">
                  <TeamBadge name={v.name} color={v.color ?? "#888"} />
                  <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                    <span className="inline-flex items-center gap-1">
                      <Building2 className="w-3 h-3" /> {v.office_location ?? DEFAULT_OFFICE}
                    </span>
                    <span>· {memberCount(v.id)} players</span>
                    {caps.length > 0 && <span className="truncate">· ⭐ {caps.join(" · ")}</span>}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(v.id);
                    setEditName(v.name);
                    setEditColor(v.color ?? VAN_COLORS[0]);
                    setEditLoc((v.office_location as OfficeLocation) ?? DEFAULT_OFFICE);
                  }}
                  className="p-2 min-h-9 min-w-9 inline-flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                  title="Edit van"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      confirm(
                        `Delete van "${v.name}"? Members move to Free Agents. Vans with production history can't be deleted — rename them instead.`,
                      )
                    ) {
                      removeVan.mutate(v.id);
                    }
                  }}
                  className="p-2 min-h-9 min-w-9 inline-flex items-center justify-center rounded hover:bg-destructive/20 text-destructive"
                  title="Delete van"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground mt-3">
        Changing a van's office moves its whole roster to that office. Monday.com's Van column keeps
        final say over who rides where — a move here can be overridden by the next card.
      </p>
    </ArcadePanel>
  );
}
