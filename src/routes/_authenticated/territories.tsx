import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { isManagerRole } from "@/lib/roles";
import { ArcadePanel } from "@/components/arcade";
import { NeonMap, type Territory, type LatLng, type FieldPin } from "@/components/NeonMap";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "@/components/ui/sheet";
import { toast } from "sonner";
import { Plus, Trash2, MapPin, Crosshair } from "lucide-react";

export const Route = createFileRoute("/_authenticated/territories")({
  head: () => ({ meta: [{ title: "Territories — Turf Invaders" }] }),
  component: TerritoriesPage,
});

const PALETTE = ["#39ff14", "#00e5ff", "#ff9f0a", "#ff2d55", "#ffd60a", "#bf5af2"];

type AssignKind = "team" | "canvasser";

function TerritoriesPage() {
  const { user, role } = useAuth();
  const qc = useQueryClient();
  const [drawing, setDrawing] = useState(false);
  const [pendingPolygon, setPendingPolygon] = useState<LatLng[] | null>(null);
  const [name, setName] = useState("");
  const [assignKind, setAssignKind] = useState<AssignKind>("team");
  const [assignId, setAssignId] = useState<string>("");
  const [color, setColor] = useState(PALETTE[1]); // Arcade blue default

  const [locating, setLocating] = useState(false);
  const [follow, setFollow] = useState(false);
  const [me, setMe] = useState<LatLng | null>(null);
  const watchRef = useRef<number | null>(null);

  const canManage = isManagerRole(role);

  const teamsQuery = useQuery({
    queryKey: ["teams_for_territory"],
    queryFn: async () => {
      const { data, error } = await supabase.from("teams").select("id, name").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const canvassersQuery = useQuery({
    queryKey: ["canvassers_for_territory"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, display_name, status")
        .eq("status", "active")
        .order("display_name");
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

  const pinsQuery = useQuery({
    queryKey: ["territory_pins_today"],
    queryFn: async () => {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const iso = today.toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from("field_pins")
        .select("id, pin_type, lat, lng, is_remote_drop, distance_m")
        .eq("log_date", iso);
      if (error) throw error;
      return (data ?? []) as FieldPin[];
    },
  });
  const remoteDropCount = (pinsQuery.data ?? []).filter((p) => p.is_remote_drop).length;

  const territories: Territory[] = useMemo(() => {
    return (territoriesQuery.data ?? []).map((t) => {
      const teamObj = (t as { teams?: { name?: string } | null }).teams;
      const profObj = (t as { profiles?: { display_name?: string } | null }).profiles;
      return {
        id: t.id as string,
        name: t.name as string,
        color: (t.color as string) ?? "#39ff14",
        polygon: t.polygon as LatLng[],
        assignmentLabel: profObj?.display_name ?? teamObj?.name ?? "—",
      };
    });
  }, [territoriesQuery.data]);

  const createTerritory = useMutation({
    mutationFn: async () => {
      if (!pendingPolygon) throw new Error("No polygon drawn");
      if (!name.trim()) throw new Error("Name the territory first");
      if (!assignId) throw new Error(`Choose a ${assignKind === "team" ? "Van" : "Canvasser"}`);
      const payload = {
        name: name.trim(),
        color,
        polygon: pendingPolygon as unknown as never,
        created_by: user?.id,
        team_id: assignKind === "team" ? assignId : null,
        canvasser_id: assignKind === "canvasser" ? assignId : null,
      };
      const { error } = await supabase.from("territories").insert(payload);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Territory locked in");
      setName(""); setAssignId(""); setPendingPolygon(null); setDrawing(false);
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

  // Geolocation ("Locate Me")
  function stopWatch() {
    if (watchRef.current != null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(watchRef.current);
    }
    watchRef.current = null;
  }
  useEffect(() => () => stopWatch(), []);

  function handleLocateMe() {
    if (!("geolocation" in navigator)) {
      toast.error("Geolocation not available on this device");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setMe({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setFollow(true);
        setLocating(false);
        toast.success("Locked onto your position");
        // Start live watch
        stopWatch();
        watchRef.current = navigator.geolocation.watchPosition(
          (p) => setMe({ lat: p.coords.latitude, lng: p.coords.longitude }),
          () => {},
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
        );
      },
      (err) => {
        setLocating(false);
        toast.error(err.message || "Could not read GPS");
      },
      { enableHighAccuracy: true, timeout: 12000 },
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="font-display text-2xl text-neon">TERRITORIES</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={handleLocateMe}
            disabled={locating}
            className="border-[#00e5ff]/60 text-[#00e5ff] hover:bg-[#00e5ff]/10"
          >
            <Crosshair className="w-4 h-4 mr-1" />
            {locating ? "Locating…" : follow ? "Following" : "Locate Me"}
          </Button>
          {canManage && !drawing && (
            <Button onClick={() => setDrawing(true)} className="bg-victory text-black hover:bg-victory/90">
              <Plus className="w-4 h-4 mr-1" /> Draw New
            </Button>
          )}
          {drawing && (
            <Button variant="outline" onClick={() => { setDrawing(false); setPendingPolygon(null); }}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      {drawing && !pendingPolygon && (
        <div className="rounded border border-[#00e5ff]/60 bg-[#00e5ff]/10 px-3 py-2 font-display text-[10px] uppercase tracking-widest text-[#8ff5ff]">
          ▸ Tap the map to drop vertices, then hit "Save Polygon" to assign this turf
        </div>
      )}

      {remoteDropCount > 0 && (
        <div className="rounded border border-[#ff2d55]/60 bg-[#ff2d55]/10 px-3 py-2 font-display text-[10px] uppercase tracking-widest text-[#ff8fa3] flex items-center justify-between">
          <span>⚠ {remoteDropCount} Remote Drop{remoteDropCount === 1 ? "" : "s"} flagged today (grey pins)</span>
          <span className="opacity-70">Canvasser dropped pin &gt;20 yds from device</span>
        </div>
      )}

      <NeonMap
        territories={territories}
        pins={pinsQuery.data ?? []}
        me={me}
        follow={follow}
        height={560}
        mode={drawing ? { kind: "draw", onComplete: (poly) => setPendingPolygon(poly) } : { kind: "view" }}
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

      {/* Slide-up assignment modal */}
      <Sheet
        open={!!pendingPolygon}
        onOpenChange={(o) => { if (!o) setPendingPolygon(null); }}
      >
        <SheetContent
          side="bottom"
          className="bg-surface border-t-2 border-[#00e5ff]/70 rounded-t-2xl max-h-[90vh] overflow-y-auto"
          style={{ boxShadow: "0 -12px 60px -10px rgba(0,229,255,0.35)" }}
        >
          <SheetHeader>
            <SheetTitle className="font-display text-neon uppercase tracking-widest">
              ⚡ Assign New Turf
            </SheetTitle>
            <SheetDescription className="text-[11px] uppercase tracking-widest text-muted-foreground">
              {pendingPolygon?.length ?? 0} vertices · Lock this block onto a Van or a Canvasser
            </SheetDescription>
          </SheetHeader>

          <div className="mt-5 space-y-4">
            <div>
              <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Territory Name</label>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Northgate Block A"
                className="mt-1"
              />
            </div>

            <div>
              <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-1 block">Assign To</label>
              <div className="grid grid-cols-2 gap-2 mb-2">
                {(["team", "canvasser"] as AssignKind[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => { setAssignKind(k); setAssignId(""); }}
                    className={`h-10 rounded font-display text-[11px] uppercase tracking-widest border-2 transition ${
                      assignKind === k
                        ? "border-[#00e5ff] bg-[#00e5ff]/15 text-[#8ff5ff]"
                        : "border-border bg-surface/60 text-muted-foreground"
                    }`}
                  >
                    {k === "team" ? "🚐 Van / Team" : "👤 Canvasser"}
                  </button>
                ))}
              </div>
              <Select value={assignId} onValueChange={setAssignId}>
                <SelectTrigger>
                  <SelectValue placeholder={assignKind === "team" ? "Pick a Van" : "Pick a Canvasser"} />
                </SelectTrigger>
                <SelectContent>
                  {assignKind === "team"
                    ? (teamsQuery.data ?? []).map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                      ))
                    : (canvassersQuery.data ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.display_name}</SelectItem>
                      ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-1 block">Neon Color</label>
              <div className="flex gap-2 flex-wrap">
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className="w-9 h-9 rounded-full border-2 transition"
                    style={{
                      background: c,
                      borderColor: color === c ? "#fff" : "transparent",
                      boxShadow: `0 0 14px ${c}`,
                    }}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>
          </div>

          <SheetFooter className="mt-6 flex-row gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setPendingPolygon(null)}
            >
              Cancel
            </Button>
            <Button
              className="flex-1 bg-victory text-black hover:bg-victory/90 font-display uppercase tracking-widest"
              disabled={createTerritory.isPending || !name.trim() || !assignId}
              onClick={() => createTerritory.mutate()}
            >
              {createTerritory.isPending ? "Saving…" : "⚡ Lock In Turf"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
