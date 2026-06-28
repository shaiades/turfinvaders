import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { ArcadePanel } from "@/components/arcade";
import { NeonMap, type Territory, type FieldPin, type LatLng } from "@/components/NeonMap";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Home, MessageSquare, Sparkles, Crosshair } from "lucide-react";

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

type ActivePin = FieldPin["pin_type"];

function MyTerritoryPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [me, setMe] = useState<LatLng | null>(null);
  const [active, setActive] = useState<ActivePin>("lead");

  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => setMe({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => console.warn("geo err", err.message),
      { enableHighAccuracy: true, maximumAge: 15000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  const territoriesQuery = useQuery({
    enabled: !!user?.id,
    queryKey: ["my_territories", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("territories").select("id, name, color, polygon");
      if (error) throw error;
      return data ?? [];
    },
  });

  const pinsQuery = useQuery({
    enabled: !!user?.id,
    queryKey: ["my_pins_today", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("field_pins")
        .select("id, pin_type, lat, lng")
        .eq("canvasser_id", user!.id)
        .eq("log_date", todayISO());
      if (error) throw error;
      return (data ?? []) as FieldPin[];
    },
  });

  const territories: Territory[] = useMemo(
    () => (territoriesQuery.data ?? []).map((t) => ({
      id: t.id as string,
      name: t.name as string,
      color: (t.color as string) ?? "#39ff14",
      polygon: t.polygon as LatLng[],
    })),
    [territoriesQuery.data],
  );

  const dropPin = useMutation({
    mutationFn: async (ll: LatLng) => {
      // Capture a FRESH device fix at drop time (don't trust stale watch state)
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
      const is_remote_drop = distance_m == null ? true : distance_m > 18; // 20 yards ≈ 18.288m

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="font-display text-2xl text-neon">MY TERRITORY</h1>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground flex items-center gap-2">
          <Crosshair className="w-3 h-3 text-[#00e5ff]" />
          {me ? `LIVE · ${me.lat.toFixed(4)}, ${me.lng.toFixed(4)}` : "Acquiring GPS…"}
        </div>
      </div>

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

      <NeonMap
        territories={territories}
        pins={pinsQuery.data ?? []}
        me={me}
        height={560}
        mode={{ kind: "pin", onDrop: (ll) => dropPin.mutate(ll) }}
      />

      <ArcadePanel title="How it works">
        <ul className="text-sm text-muted-foreground space-y-1.5">
          <li>• Pick a pin type above, then tap the map where you knocked.</li>
          <li>• <span className="text-[#ffd60a]">Yellow (Talked To)</span> auto-adds to your <span className="text-foreground">People Talked To</span> counter.</li>
          <li>• <span className="text-[#39ff14]">Green (Lead Generated)</span> auto-adds to your <span className="text-foreground">Leads Called In</span> counter.</li>
          <li>• <span className="text-[#ff2d55]">Red (Not Home)</span> is tracked for territory coverage but doesn't bump counters.</li>
        </ul>
      </ArcadePanel>
    </div>
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
