import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { ArcadePanel } from "@/components/arcade";
import { NeonMap, type Territory, type FieldPin, type LatLng } from "@/components/NeonMap";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
  DialogOverlay, DialogPortal,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Home, MessageSquare, Sparkles, Crosshair, Pencil, MapPin, Trash2 } from "lucide-react";
import { GratitudeGate } from "@/components/GratitudeGate";

export const Route = createFileRoute("/_authenticated/my-territory")({
  head: () => ({ meta: [{ title: "My Territory — Knockout" }] }),
  component: MyTerritoryPage,
});

function todayISO() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function haversineMeters(a: LatLng, b: LatLng) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const TURF_COLORS = ["#39ff14", "#00e5ff", "#ffd60a", "#ff2d55", "#ff6b00", "#c77dff"];

type ActivePin = FieldPin["pin_type"];
type TurfRow = {
  id: string;
  name: string;
  color: string;
  polygon_coordinates: LatLng[];
  assigned_user_id: string | null;
  assignee_name?: string | null;
};

function MyTerritoryPage() {
  const { user, role } = useAuth();
  const qc = useQueryClient();
  const isManager = role === "owner" || role === "captain";
  const [me, setMe] = useState<LatLng | null>(null);
  const [active, setActive] = useState<ActivePin>("lead");
  const [drawing, setDrawing] = useState(false);
  const [pendingPolygon, setPendingPolygon] = useState<LatLng[] | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => setMe({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => console.warn("geo err", err.message),
      { enableHighAccuracy: true, maximumAge: 15000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // Turfs: managers see all, canvassers see only their assigned (enforced by RLS too)
  const turfsQuery = useQuery({
    enabled: !!user?.id,
    queryKey: ["turfs", user?.id, role],
    queryFn: async () => {
      let q = supabase
        .from("turfs")
        .select("id, name, color, polygon_coordinates, assigned_user_id");
      if (!isManager) q = q.eq("assigned_user_id", user!.id);
      const { data, error } = await q.order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TurfRow[];
    },
  });

  // Assignable users — canvassers, captains, and owners can all be assigned a turf
  const canvassersQuery = useQuery({
    enabled: isManager,
    queryKey: ["assignable_canvassers"],
    queryFn: async () => {
      const { data: roleRows, error: rErr } = await supabase
        .from("user_roles")
        .select("user_id, role")
        .in("role", ["canvasser", "captain", "owner"]);
      if (rErr) throw rErr;
      if ((roleRows ?? []).length === 0) return [] as Array<{ id: string; display_name: string; role: string }>;
      const ids = (roleRows ?? []).map((r) => r.user_id as string);
      const { data: profs, error: pErr } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", ids)
        .order("display_name", { ascending: true });
      if (pErr) throw pErr;
      const nameById = new Map((profs ?? []).map((p) => [p.id as string, p.display_name ?? p.id]));
      return (roleRows ?? [])
        .map((r) => ({
          id: r.user_id as string,
          display_name: nameById.get(r.user_id) ?? (r.user_id as string),
          role: r.role as string,
        }))
        .sort((a, b) => a.display_name.localeCompare(b.display_name));
    },
  });

  const pinsQuery = useQuery({
    enabled: !!user?.id,
    queryKey: ["my_pins_today", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("field_pins")
        .select("id, pin_type, lat, lng, is_remote_drop, distance_m")
        .eq("canvasser_id", user!.id)
        .eq("log_date", todayISO());
      if (error) throw error;
      return (data ?? []) as FieldPin[];
    },
  });

  const territories: Territory[] = useMemo(
    () => (turfsQuery.data ?? []).map((t, i) => ({
      id: t.id,
      name: t.name,
      color: t.color ?? TURF_COLORS[i % TURF_COLORS.length],
      polygon: (t.polygon_coordinates ?? []) as LatLng[],
    })),
    [turfsQuery.data],
  );

  const saveTurf = useMutation({
    mutationFn: async (payload: { name: string; assigned_user_id: string; polygon: LatLng[]; color: string }) => {
      const { data: authData } = await supabase.auth.getUser();
      const uid = authData.user?.id;
      if (!uid) throw new Error("Not signed in — please refresh and sign in again.");
      const insertRow = {
        name: payload.name,
        color: payload.color,
        polygon_coordinates: payload.polygon.map((p) => ({ lat: p.lat, lng: p.lng })),
        assigned_user_id: payload.assigned_user_id,
        created_by: uid,
      };
      const { data, error } = await supabase.from("turfs").insert(insertRow).select().single();
      if (error) {
        console.error("[turf insert failed]", error, "row:", insertRow);
        const parts = [error.message];
        if (error.code) parts.push(`(code ${error.code})`);
        if (error.hint) parts.push(`— ${error.hint}`);
        throw new Error(parts.join(" "));
      }
      return data;
    },
    onSuccess: () => {
      toast.success("🗺 Turf Assigned!");
      setPendingPolygon(null);
      setIsModalOpen(false);
      setDrawing(false);
      qc.invalidateQueries({ queryKey: ["turfs"] });
    },
    onError: (e: Error) => {
      toast.error(`Failed to assign turf: ${e.message}`, { duration: 8000 });
    },
  });


  const deleteTurf = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("turfs").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Turf deleted");
      qc.invalidateQueries({ queryKey: ["turfs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const dropPin = useMutation({
    mutationFn: async (ll: LatLng) => {
      const fix = await new Promise<GeolocationPosition | null>((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (p) => resolve(p),
          () => resolve(null),
          { enableHighAccuracy: true, maximumAge: 10000, timeout: 8000 },
        );
      });
      const device = fix ? { lat: fix.coords.latitude, lng: fix.coords.longitude } : me;
      const distance_m = device ? haversineMeters(device, ll) : null;
      const is_remote_drop = distance_m == null ? true : distance_m > 18;
      const { error } = await supabase.from("field_pins").insert({
        canvasser_id: user!.id,
        pin_type: active,
        lat: ll.lat,
        lng: ll.lng,
        log_date: todayISO(),
        device_lat: device?.lat ?? null,
        device_lng: device?.lng ?? null,
        distance_m,
        is_remote_drop,
      });
      if (error) throw error;
      return { is_remote_drop, distance_m };
    },
    onSuccess: ({ is_remote_drop, distance_m }) => {
      if (is_remote_drop) {
        const yds = distance_m != null ? Math.round(distance_m * 1.0936) : null;
        toast.warning(`⚠ Remote Drop flagged${yds != null ? ` · ${yds} yds from pin` : ""}`, {
          description: "Pin won't count toward your stats. Walk to the door and try again.",
        });
      } else {
        toast.success(active === "lead" ? "🟢 Lead pin dropped" : active === "talked_to" ? "🟡 Conversation logged" : "🔴 Not home");
      }
      qc.invalidateQueries({ queryKey: ["my_pins_today", user?.id] });
      qc.invalidateQueries({ queryKey: ["my_logs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const counts = useMemo(() => {
    const pins = pinsQuery.data ?? [];
    return {
      not_home: pins.filter((p) => p.pin_type === "not_home").length,
      talked_to: pins.filter((p) => p.pin_type === "talked_to").length,
      lead: pins.filter((p) => p.pin_type === "lead").length,
    };
  }, [pinsQuery.data]);

  const mapMode = drawing
    ? { kind: "draw" as const, onComplete: (poly: LatLng[]) => { setPendingPolygon(poly); setIsModalOpen(true); } }
    : { kind: "pin" as const, onDrop: (ll: LatLng) => dropPin.mutate(ll) };

  return (
    <GratitudeGate userId={user?.id}>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="font-display text-2xl text-neon">MY TERRITORY</h1>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground flex items-center gap-2">
            <Crosshair className="w-3 h-3 text-[#00e5ff]" />
            {me ? `LIVE · ${me.lat.toFixed(4)}, ${me.lng.toFixed(4)}` : "Acquiring GPS…"}
          </div>
        </div>

        {/* Manager toolbar */}
        {isManager && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-neon/40 bg-surface/60 p-3">
            <div className="font-display text-[10px] uppercase tracking-widest text-neon">Turf Tools</div>
            {!drawing ? (
              <Button size="sm" onClick={() => setDrawing(true)} className="gap-2">
                <Pencil className="w-3.5 h-3.5" /> Draw New Turf
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => { setDrawing(false); setPendingPolygon(null); }}>
                Cancel Drawing
              </Button>
            )}
            <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
              {drawing ? "Tap map to add vertices · Save when 3+ points" : `${territories.length} turf(s) drawn`}
            </span>
          </div>
        )}

        {/* Canvasser pin picker */}
        {!isManager && (
          <div className="grid sm:grid-cols-3 gap-3">
            <PinPicker
              label="Not Home" count={counts.not_home} color="#ff2d55" icon={<Home className="w-4 h-4" />}
              active={active === "not_home"} onClick={() => setActive("not_home")}
            />
            <PinPicker
              label="Talked To" count={counts.talked_to} color="#ffd60a" icon={<MessageSquare className="w-4 h-4" />}
              active={active === "talked_to"} onClick={() => setActive("talked_to")}
            />
            <PinPicker
              label="Lead Generated" count={counts.lead} color="#39ff14" icon={<Sparkles className="w-4 h-4" />}
              active={active === "lead"} onClick={() => setActive("lead")}
            />
          </div>
        )}

        <div className="relative">
          <NeonMap
            territories={territories}
            pins={isManager ? [] : (pinsQuery.data ?? [])}
            houses={[]}
            me={me}
            height={560}
            follow
            mode={mapMode}
          />
          {/* Floating fallback: always visible when a polygon is pending */}
          {isManager && pendingPolygon && pendingPolygon.length >= 3 && (
            <div className="absolute left-1/2 -translate-x-1/2 bottom-4 z-[1000] flex gap-2">
              <Button
                size="lg"
                onClick={() => setIsModalOpen(true)}
                className="font-display uppercase tracking-widest bg-victory text-black hover:bg-victory/90 shadow-[0_0_24px_rgba(57,255,20,0.6)] animate-pulse"
              >
                <MapPin className="w-4 h-4 mr-2" />
                Assign This Territory ({pendingPolygon.length} pts)
              </Button>
              <Button
                size="lg"
                variant="outline"
                onClick={() => { setPendingPolygon(null); setIsModalOpen(false); }}
              >
                Discard
              </Button>
            </div>
          )}
        </div>

        {/* Manager turf list */}
        {isManager && (
          <ArcadePanel title="Assigned Turfs">
            {territories.length === 0 ? (
              <div className="text-sm text-muted-foreground">No turfs yet. Click "Draw New Turf" to define one.</div>
            ) : (
              <ul className="space-y-2">
                {(turfsQuery.data ?? []).map((t) => {
                  const assignee = (canvassersQuery.data ?? []).find((c) => c.id === t.assigned_user_id);
                  return (
                    <li key={t.id} className="flex items-center justify-between gap-3 rounded border border-border bg-surface/60 p-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="inline-block w-3 h-3 rounded-full" style={{ background: t.color, boxShadow: `0 0 8px ${t.color}` }} />
                        <div className="min-w-0">
                          <div className="font-display text-sm text-foreground truncate">{t.name}</div>
                          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
                            <MapPin className="inline w-3 h-3 mr-1" />
                            {assignee ? formatAssignable(assignee) : (t.assigned_user_id ? "Unknown assignee" : "Unassigned")}
                            {" · "}{(t.polygon_coordinates ?? []).length} vertices
                          </div>
                        </div>
                      </div>
                      <Button
                        size="sm" variant="ghost"
                        onClick={() => { if (confirm(`Delete turf "${t.name}"?`)) deleteTurf.mutate(t.id); }}
                        className="text-destructive"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </ArcadePanel>
        )}

        {/* Canvasser help */}
        {!isManager && (
          <ArcadePanel title="How it works">
            <ul className="text-sm text-muted-foreground space-y-1.5">
              <li>• Your assigned turfs appear as colored boundaries on the map.</li>
              <li>• Pick a pin type above, then tap the map where you knocked.</li>
              <li>• <span className="text-[#39ff14]">Green</span> = Lead · <span className="text-[#ffd60a]">Yellow</span> = Talked To · <span className="text-[#ff2d55]">Red</span> = Not Home.</li>
              <li>• Pins &gt; 20 yards from your GPS location are flagged as Remote Drops.</li>
            </ul>
          </ArcadePanel>
        )}
      </div>

      {/* Assign modal (manager-only) */}
      <AssignTurfDialog
        open={isModalOpen && isManager}
        onOpenChange={(v) => {
          setIsModalOpen(v);
          if (!v) setPendingPolygon(null); // clicking cancel/away discards the drawn shape
        }}
        polygon={pendingPolygon ?? []}
        canvassers={canvassersQuery.data ?? []}
        saving={saveTurf.isPending}
        onSave={(name, assigneeId, color) => {
          if (!pendingPolygon) return;
          saveTurf.mutate({ name, assigned_user_id: assigneeId, polygon: pendingPolygon, color });
        }}
      />
    </GratitudeGate>
  );
}

function formatAssignable(c: { display_name: string; role: string }) {
  const title = c.role.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
  return `${c.display_name} (${title})`;
}

function AssignTurfDialog({
  open, onOpenChange, polygon, canvassers, onSave, saving,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  polygon: LatLng[];
  canvassers: Array<{ id: string; display_name: string; role: string }>;
  onSave: (name: string, assigneeId: string, color: string) => void;
  saving: boolean;
}) {
  const [name, setName] = useState("");
  const [assigneeId, setAssigneeId] = useState<string>("");
  const [color, setColor] = useState<string>(TURF_COLORS[0]);

  useEffect(() => {
    if (open) { setName(""); setAssigneeId(""); setColor(TURF_COLORS[0]); }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="fixed inset-0 z-[9999] bg-black/50" />
        <DialogContent className="z-[9999] max-w-md overflow-visible">
          <DialogHeader>
            <DialogTitle className="font-display text-neon">ASSIGN TURF</DialogTitle>
            <DialogDescription>
              {polygon.length} vertices drawn. Name the turf and assign a canvasser.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="turf-name">Turf Name</Label>
              <Input
                id="turf-name" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Maple Heights - North Loop"
              />
            </div>
            <div className="space-y-2">
              <Label>Assign to Canvasser</Label>
              <Select value={assigneeId} onValueChange={setAssigneeId}>
                <SelectTrigger><SelectValue placeholder="Select a canvasser…" /></SelectTrigger>
                <SelectContent className="z-[10000]">
                  {canvassers.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">No canvassers found</div>
                  )}
                  {canvassers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{formatAssignable(c)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Boundary Color</Label>
              <div className="flex gap-2">
                {TURF_COLORS.map((c) => (
                  <button
                    key={c} type="button" onClick={() => setColor(c)}
                    className="w-8 h-8 rounded-full border-2 transition-transform"
                    style={{
                      background: c,
                      borderColor: color === c ? "#fff" : "transparent",
                      boxShadow: color === c ? `0 0 12px ${c}` : "none",
                      transform: color === c ? "scale(1.15)" : "scale(1)",
                    }}
                    aria-label={`Pick ${c}`}
                  />
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              onClick={() => onSave(name.trim(), assigneeId, color)}
              disabled={saving || !name.trim() || !assigneeId || polygon.length < 3}
            >
              {saving ? "Saving…" : "Save & Assign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

function PinPicker({
  label, count, color, icon, active, onClick,
}: { label: string; count: number; color: string; icon: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="relative overflow-hidden rounded-lg border p-4 text-left transition-all"
      style={{
        borderColor: active ? color : "var(--border)",
        background: active ? `color-mix(in oklab, ${color} 14%, var(--surface))` : "var(--surface)",
        boxShadow: active ? `0 0 18px -4px ${color}` : "none",
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-display text-[10px] uppercase tracking-widest" style={{ color }}>
          {icon} {label}
        </div>
        <div className="font-display text-2xl" style={{ color, textShadow: `0 0 10px ${color}88` }}>
          {count}
        </div>
      </div>
      <div className="mt-2 text-[10px] uppercase tracking-widest text-muted-foreground">
        {active ? "ACTIVE · tap map" : "Tap to select"}
      </div>
    </button>
  );
}
