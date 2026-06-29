import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, TeamBadge } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Truck, Plus, UserPlus, Building2 } from "lucide-react";

const VAN_COLORS = ["#ff007a", "#00f0ff", "#a855f7", "#f59e0b", "#22c55e", "#ef4444", "#3b82f6", "#eab308"];

export function FleetManager() {
  const qc = useQueryClient();
  const [newVanName, setNewVanName] = useState("");
  const [newVanOffice, setNewVanOffice] = useState<string | null>(null);
  const [newVanColor, setNewVanColor] = useState(VAN_COLORS[0]);

  const fleet = useQuery({
    queryKey: ["fleet_manager"],
    queryFn: async () => {
      const [vansR, profilesR, rolesR, officesR] = await Promise.all([
        supabase.from("teams").select("id, name, color, captain_id, office_id").order("name"),
        supabase.from("profiles").select("id, display_name, team_id").order("display_name"),
        supabase.from("user_roles").select("user_id, role"),
        supabase.from("offices").select("id, name, color").order("name"),
      ]);
      if (vansR.error) throw vansR.error;
      if (profilesR.error) throw profilesR.error;
      if (rolesR.error) throw rolesR.error;
      if (officesR.error) throw officesR.error;
      const rolesByUser = new Map<string, string[]>();
      for (const r of rolesR.data ?? []) {
        const arr = rolesByUser.get(r.user_id) ?? [];
        arr.push(r.role);
        rolesByUser.set(r.user_id, arr);
      }
      return {
        vans: vansR.data ?? [],
        profiles: profilesR.data ?? [],
        offices: officesR.data ?? [],
        rolesByUser,
      };
    },
  });

  const createVan = useMutation({
    mutationFn: async () => {
      if (!newVanName.trim()) throw new Error("Van name required");
      const { error } = await supabase.from("teams").insert({
        name: newVanName.trim(),
        color: newVanColor,
        office_id: newVanOffice,
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
      if (captainId) {
        await supabase.from("profiles").update({ team_id: vanId }).eq("id", captainId);
      }
    },
    onSuccess: () => { toast.success("Captain assigned"); qc.invalidateQueries({ queryKey: ["fleet_manager"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const assignCanvasser = useMutation({
    mutationFn: async ({ canvasserId, vanId }: { canvasserId: string; vanId: string | null }) => {
      const { error } = await supabase.from("profiles").update({ team_id: vanId }).eq("id", canvasserId);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Canvasser assigned"); qc.invalidateQueries({ queryKey: ["fleet_manager"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (fleet.isLoading || !fleet.data) {
    return <div className="text-sm text-muted-foreground">Loading fleet…</div>;
  }

  const { vans, profiles, offices, rolesByUser } = fleet.data;
  const captains = profiles.filter((p) => (rolesByUser.get(p.id) ?? []).includes("captain"));
  const canvassers = profiles.filter((p) => (rolesByUser.get(p.id) ?? []).includes("canvasser"));

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
                {offices.map((o) => (
                  <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
                ))}
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

      {/* Vans + roster */}
      <ArcadePanel title={`Fleet (${vans.length} Vans)`}>
        {vans.length === 0 ? (
          <div className="text-sm text-muted-foreground">No vans yet. Create your first one above.</div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {vans.map((v) => {
              const office = offices.find((o) => o.id === v.office_id);
              const roster = profiles.filter((p) => p.team_id === v.id);
              return (
                <div key={v.id} className="arcade-card p-4 space-y-3">
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
                      Roster ({roster.length})
                    </div>
                    {roster.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {roster.map((r) => (
                          <button
                            key={r.id}
                            onClick={() => assignCanvasser.mutate({ canvasserId: r.id, vanId: null })}
                            className="text-[11px] px-2 py-1 rounded border border-border hover:border-destructive hover:text-destructive"
                            title="Click to remove from van"
                          >
                            {r.display_name} ×
                          </button>
                        ))}
                      </div>
                    )}
                    <Select
                      value="none"
                      onValueChange={(val) => { if (val !== "none") assignCanvasser.mutate({ canvasserId: val, vanId: v.id }); }}
                    >
                      <SelectTrigger>
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <UserPlus className="w-3.5 h-3.5" /> Add canvasser…
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">—</SelectItem>
                        {canvassers
                          .filter((c) => c.team_id !== v.id)
                          .map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.display_name}{c.team_id ? " · (reassign)" : ""}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ArcadePanel>
    </div>
  );
}
