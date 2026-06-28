import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { ArcadePanel } from "@/components/arcade";
import { NeonMap, type Territory, type LatLng } from "@/components/NeonMap";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Plus, Trash2, MapPin } from "lucide-react";

export const Route = createFileRoute("/_authenticated/territories")({
  head: () => ({ meta: [{ title: "Territories — Knockout" }] }),
  component: TerritoriesPage,
});

const PALETTE = ["#39ff14", "#00e5ff", "#ff2d55", "#ffd60a", "#bf5af2", "#ff9f0a"];

function TerritoriesPage() {
  const { user, role } = useAuth();
  const qc = useQueryClient();
  const [drawing, setDrawing] = useState(false);
  const [name, setName] = useState("");
  const [assignTeam, setAssignTeam] = useState<string>("");
  const [color, setColor] = useState(PALETTE[0]);

  const canManage = role === "owner" || role === "captain";

  const teamsQuery = useQuery({
    queryKey: ["teams_for_territory"],
    queryFn: async () => {
      const { data, error } = await supabase.from("teams").select("id, name").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const territoriesQuery = useQuery({
    queryKey: ["territories"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("territories")
        .select("id, name, color, polygon, team_id, canvasser_id, teams:team_id(name), profiles:canvasser_id(display_name)");
      if (error) throw error;
      return data ?? [];
    },
  });

  const territories: Territory[] = useMemo(() => {
    return (territoriesQuery.data ?? []).map((t) => {
      const teamObj = (t as { teams?: { name?: string } | null }).teams;
      const profObj = (t as { profiles?: { display_name?: string } | null }).profiles;
      return {
        id: t.id as string,
        name: t.name as string,
        color: (t.color as string) ?? "#39ff14",
        polygon: t.polygon as LatLng[],
        assignmentLabel: teamObj?.name ?? profObj?.display_name ?? "—",
      };
    });
  }, [territoriesQuery.data]);

  const createTerritory = useMutation({
    mutationFn: async (polygon: LatLng[]) => {
      if (!name.trim()) throw new Error("Name the territory first");
      if (!assignTeam) throw new Error("Choose a Van to assign");
      const { error } = await supabase.from("territories").insert({
        name: name.trim(),
        color,
        team_id: assignTeam,
        polygon: polygon as unknown as object,
        created_by: user?.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Territory saved");
      setName(""); setDrawing(false);
      qc.invalidateQueries({ queryKey: ["territories"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteTerritory = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("territories").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Territory removed");
      qc.invalidateQueries({ queryKey: ["territories"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="font-display text-2xl text-neon">TERRITORIES</h1>
        {canManage && !drawing && (
          <Button onClick={() => setDrawing(true)} className="bg-victory text-black hover:bg-victory/90">
            <Plus className="w-4 h-4 mr-1" /> Draw New
          </Button>
        )}
        {drawing && (
          <Button variant="outline" onClick={() => setDrawing(false)}>Cancel</Button>
        )}
      </div>

      {drawing && (
        <ArcadePanel title="New Territory">
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Northgate Block A" />
            </div>
            <div>
              <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Assign to Van</label>
              <Select value={assignTeam} onValueChange={setAssignTeam}>
                <SelectTrigger><SelectValue placeholder="Pick a Van" /></SelectTrigger>
                <SelectContent>
                  {(teamsQuery.data ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Color</label>
              <div className="flex gap-2 mt-1">
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className="w-7 h-7 rounded-full border-2"
                    style={{ background: c, borderColor: color === c ? "#fff" : "transparent", boxShadow: `0 0 10px ${c}` }}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>
          </div>
        </ArcadePanel>
      )}

      <NeonMap
        territories={territories}
        height={520}
        mode={drawing ? { kind: "draw", onComplete: (poly) => createTerritory.mutate(poly) } : { kind: "view" }}
      />

      <ArcadePanel title={`Active Territories · ${territories.length}`}>
        {territories.length === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center">
            <MapPin className="w-8 h-8 mx-auto mb-2 opacity-50" />
            No territories drawn yet. Hit "Draw New" to start.
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {territories.map((t) => (
              <div key={t.id} className="rounded border border-border bg-surface/60 p-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-3 h-3 rounded-full shrink-0" style={{ background: t.color, boxShadow: `0 0 8px ${t.color}` }} />
                  <div className="min-w-0">
                    <div className="font-display text-sm truncate">{t.name}</div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground truncate">{t.assignmentLabel}</div>
                  </div>
                </div>
                {canManage && (
                  <button
                    onClick={() => deleteTerritory.mutate(t.id)}
                    className="p-1.5 rounded hover:bg-destructive/15 text-muted-foreground hover:text-destructive"
                    aria-label="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </ArcadePanel>
    </div>
  );
}
