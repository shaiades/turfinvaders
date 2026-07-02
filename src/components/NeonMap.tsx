import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Polygon, Marker, useMapEvents, useMap } from "react-leaflet";
import L from "leaflet";

export type LatLng = { lat: number; lng: number };

export type Territory = {
  id: string;
  name: string;
  color: string;
  polygon: LatLng[];
  assignmentLabel?: string;
};

export type FieldPin = {
  id: string;
  pin_type: "not_home" | "talked_to" | "lead";
  lat: number;
  lng: number;
  is_remote_drop?: boolean;
  distance_m?: number | null;
};

const PIN_COLORS: Record<FieldPin["pin_type"], string> = {
  not_home: "#ff2d55",
  talked_to: "#ffd60a",
  lead: "#39ff14",
};
const REMOTE_DROP_COLOR = "#8a8f99";

function glowingDotIcon(color: string, size = 18) {
  const html = `
    <div style="
      width:${size}px;height:${size}px;border-radius:9999px;
      background:${color};
      border:2px solid rgba(255,255,255,0.85);
      box-shadow:0 0 12px ${color},0 0 22px ${color}88,inset 0 0 6px rgba(255,255,255,0.6);
    "></div>`;
  return L.divIcon({
    html,
    className: "neon-pin",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function flaggedPinIcon(size = 22) {
  const color = REMOTE_DROP_COLOR;
  const html = `
    <div style="position:relative;width:${size}px;height:${size}px;">
      <div style="position:absolute;inset:0;border-radius:9999px;background:${color};border:2px dashed #fff;box-shadow:0 0 10px ${color},0 0 0 2px #ff2d5588;animation:nm-flag 1.6s ease-in-out infinite;"></div>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font:700 11px/1 ui-sans-serif,system-ui;text-shadow:0 0 4px #000;">!</div>
    </div>
    <style>@keyframes nm-flag{0%,100%{box-shadow:0 0 10px ${color},0 0 0 2px #ff2d5588}50%{box-shadow:0 0 18px ${color},0 0 0 4px #ff2d55cc}}</style>`;
  return L.divIcon({ html, className: "neon-pin-flag", iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function pulseDotIcon(color: string) {
  const html = `
    <div style="position:relative;width:22px;height:22px;">
      <div style="position:absolute;inset:0;border-radius:9999px;background:${color};opacity:.35;animation:nm-pulse 1.4s ease-out infinite;"></div>
      <div style="position:absolute;inset:5px;border-radius:9999px;background:${color};border:2px solid #fff;box-shadow:0 0 14px ${color};"></div>
    </div>
    <style>@keyframes nm-pulse{0%{transform:scale(.6);opacity:.6}100%{transform:scale(2.6);opacity:0}}</style>`;
  return L.divIcon({
    html, className: "neon-pin-me", iconSize: [22, 22], iconAnchor: [11, 11],
  });
}

function ClickCapture({ onClick }: { onClick: (ll: LatLng) => void }) {
  useMapEvents({
    click(e) { onClick({ lat: e.latlng.lat, lng: e.latlng.lng }); },
  });
  return null;
}

function FitBounds({ points }: { points: LatLng[] }) {
  const map = useMap();
  const didFit = useRef(false);
  useEffect(() => {
    if (didFit.current || points.length === 0) return;
    const b = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]));
    map.fitBounds(b, { padding: [40, 40], maxZoom: 16 });
    didFit.current = true;
  }, [map, points]);
  return null;
}

function FollowMe({ me, zoom = 17 }: { me: LatLng | null | undefined; zoom?: number }) {
  const map = useMap();
  const didInitial = useRef(false);
  useEffect(() => {
    if (!me) return;
    if (!didInitial.current) {
      map.setView([me.lat, me.lng], zoom, { animate: false });
      didInitial.current = true;
    } else {
      map.panTo([me.lat, me.lng], { animate: true });
    }
  }, [map, me?.lat, me?.lng, zoom]);
  return null;
}

function InvalidateOnMount() {
  const map = useMap();
  useEffect(() => {
    const run = () => map.invalidateSize();
    run();
    const t1 = setTimeout(run, 100);
    const t2 = setTimeout(run, 400);
    const t3 = setTimeout(run, 1000);
    window.addEventListener("resize", run);
    return () => {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
      window.removeEventListener("resize", run);
    };
  }, [map]);
  return null;
}


type Mode =
  | { kind: "view" }
  | { kind: "draw"; onComplete: (polygon: LatLng[]) => void }
  | { kind: "pin"; onDrop: (ll: LatLng) => void };

export function NeonMap({
  territories,
  pins = [],
  me,
  mode = { kind: "view" },
  center,
  height = 480,
  follow = false,
}: {
  territories: Territory[];
  pins?: FieldPin[];
  me?: LatLng | null;
  mode?: Mode;
  center?: LatLng;
  height?: number;
  follow?: boolean;
}) {
  const [draft, setDraft] = useState<LatLng[]>([]);
  const mapRef = useRef<L.Map | null>(null);

  const fallbackCenter = useMemo<LatLng>(() => {
    if (center) return center;
    if (me) return me;
    if (territories[0]?.polygon[0]) return territories[0].polygon[0];
    if (pins[0]) return { lat: pins[0].lat, lng: pins[0].lng };
    return { lat: 39.8283, lng: -98.5795 }; // continental US center
  }, [center, me, territories, pins]);

  const allPoints = useMemo<LatLng[]>(() => {
    const pts: LatLng[] = [];
    territories.forEach((t) => pts.push(...t.polygon));
    pins.forEach((p) => pts.push({ lat: p.lat, lng: p.lng }));
    if (me) pts.push(me);
    return pts;
  }, [territories, pins, me]);

  function handleClick(ll: LatLng) {
    if (mode.kind === "draw") setDraft((d) => [...d, ll]);
    if (mode.kind === "pin") mode.onDrop(ll);
  }

  function finishDraft() {
    if (mode.kind !== "draw" || draft.length < 3) return;
    mode.onComplete(draft);
    setDraft([]);
  }

  return (
    <div
      className="relative rounded-lg overflow-hidden border border-[color-mix(in_oklab,var(--neon)_35%,var(--border))]"
      style={{
        height,
        boxShadow: "0 0 24px -8px color-mix(in oklab, var(--neon) 50%, transparent), inset 0 0 80px -20px color-mix(in oklab, var(--neon) 25%, transparent)",
      }}
    >
      <MapContainer
        center={[fallbackCenter.lat, fallbackCenter.lng]}
        zoom={follow ? 17 : 13}
        scrollWheelZoom
        style={{ height: "100%", width: "100%", background: "#0b0f1a" }}
        ref={(instance) => { mapRef.current = instance; }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />
        <InvalidateOnMount />
        <ClickCapture onClick={handleClick} />
        {follow ? <FollowMe me={me} /> : allPoints.length > 0 && <FitBounds points={allPoints} />}

        {territories.map((t) => (
          <Polygon
            key={t.id}
            positions={t.polygon.map((p) => [p.lat, p.lng] as [number, number])}
            pathOptions={{
              color: t.color,
              weight: 2,
              fillColor: t.color,
              fillOpacity: 0.15,
            }}
          />
        ))}

        {mode.kind === "draw" && draft.length > 0 && (
          <>
            <Polygon
              positions={draft.map((p) => [p.lat, p.lng] as [number, number])}
              pathOptions={{
                color: "var(--neon)" as unknown as string,
                weight: 2,
                dashArray: "4 6",
                fillColor: "#39ff14",
                fillOpacity: 0.1,
              }}
            />
            {draft.map((p, i) => (
              <Marker key={i} position={[p.lat, p.lng]} icon={glowingDotIcon("#39ff14", 12)} />
            ))}
          </>
        )}

        {pins.map((p) => (
          <Marker key={p.id} position={[p.lat, p.lng]} icon={p.is_remote_drop ? flaggedPinIcon() : glowingDotIcon(PIN_COLORS[p.pin_type])} />
        ))}

        {me && <Marker position={[me.lat, me.lng]} icon={pulseDotIcon("#00e5ff")} />}
      </MapContainer>

      {/* Draw mode controls */}
      {mode.kind === "draw" && (
        <div className="absolute top-3 right-3 z-[1000] flex flex-col gap-2 text-xs">
          <div className="rounded border border-neon/60 bg-surface/90 backdrop-blur px-3 py-2 font-display text-[10px] uppercase tracking-widest text-neon">
            Click map to add vertices · {draft.length} pts
          </div>
          <div className="flex gap-2">
            <button
              onClick={finishDraft}
              disabled={draft.length < 3}
              className="flex-1 rounded bg-victory text-black font-display text-[10px] uppercase tracking-widest px-3 py-2 disabled:opacity-40"
            >
              Save Polygon
            </button>
            <button
              onClick={() => setDraft([])}
              className="rounded border border-border bg-surface/90 px-3 py-2 font-display text-[10px] uppercase tracking-widest"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Pin mode legend */}
      {mode.kind === "pin" && (
        <div className="absolute top-3 right-3 z-[1000] rounded border border-neon/60 bg-surface/90 backdrop-blur px-3 py-2 font-display text-[10px] uppercase tracking-widest text-neon">
          Tap map to drop pin
        </div>
      )}
    </div>
  );
}
