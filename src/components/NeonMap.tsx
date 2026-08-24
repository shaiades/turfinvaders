import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Polygon, Polyline, Marker, useMapEvents, useMap } from "react-leaflet";
import L from "leaflet";
import { LocateFixed } from "lucide-react";
import { PIN_COLORS, type PinType } from "@/lib/pin-results";

// Canonical copy lives in lib/pin-results (SSR-safe); re-exported here so map
// consumers keep a single import site.
export { PIN_COLORS, PIN_LABELS } from "@/lib/pin-results";

export type LatLng = { lat: number; lng: number };

export type Territory = {
  id: string;
  name: string;
  color: string;
  polygon: LatLng[];
  assignmentLabel?: string;
  /** Unassigned turfs render gray + dashed. */
  dashed?: boolean;
};

export type FieldPin = {
  id: string;
  pin_type: PinType;
  lat: number;
  lng: number;
  is_remote_drop?: boolean;
  distance_m?: number | null;
  created_at?: string;
  /** Optimistic row awaiting server truth — rendered dimmed, not tappable. */
  pending?: boolean;
};

const REMOTE_DROP_COLOR = "#8a8f99";

// `hit` grows the tappable box past the visual dot (interactive pins need a
// finger-sized target; an 18px dot alone is a dead zone on a phone).
function glowingDotIcon(color: string, size = 18, hit = size) {
  const html = `
    <div style="width:${hit}px;height:${hit}px;display:flex;align-items:center;justify-content:center;">
      <div style="
        width:${size}px;height:${size}px;border-radius:9999px;
        background:${color};
        border:2px solid rgba(255,255,255,0.85);
        box-shadow:0 0 12px ${color},0 0 22px ${color}88,inset 0 0 6px rgba(255,255,255,0.6);
      "></div>
    </div>`;
  return L.divIcon({
    html,
    className: "neon-pin",
    iconSize: [hit, hit],
    iconAnchor: [hit / 2, hit / 2],
  });
}

function leadStarIcon(size = 34) {
  const color = "#39ff14";
  const half = size / 2;
  const html = `
    <div style="position:relative;width:${size}px;height:${size}px;">
      <div style="position:absolute;inset:-4px;border-radius:9999px;background:${color};opacity:.25;filter:blur(6px);animation:nm-star-pulse 1.8s ease-in-out infinite;"></div>
      <svg width="${size}" height="${size}" viewBox="0 0 24 24" style="position:absolute;inset:0;filter:drop-shadow(0 0 6px ${color}) drop-shadow(0 0 12px ${color}aa);">
        <polygon points="12,1.6 15.09,8.86 22.9,9.55 16.95,14.7 18.82,22.4 12,18.27 5.18,22.4 7.05,14.7 1.1,9.55 8.91,8.86"
          fill="${color}" stroke="#ffffff" stroke-width="1.2" stroke-linejoin="round" />
      </svg>
    </div>`;
  return L.divIcon({
    html,
    className: "neon-lead-star",
    iconSize: [size, size],
    iconAnchor: [half, half],
  });
}

function flaggedPinIcon(size = 22, hit = size) {
  const color = REMOTE_DROP_COLOR;
  const html = `
    <div style="width:${hit}px;height:${hit}px;display:flex;align-items:center;justify-content:center;">
      <div style="position:relative;width:${size}px;height:${size}px;">
        <div style="position:absolute;inset:0;border-radius:9999px;background:${color};border:2px dashed #fff;box-shadow:0 0 10px ${color},0 0 0 2px #ff2d5588;animation:nm-flag 1.6s ease-in-out infinite;"></div>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font:700 11px/1 ui-sans-serif,system-ui;text-shadow:0 0 4px #000;">!</div>
      </div>
    </div>`;
  return L.divIcon({ html, className: "neon-pin-flag", iconSize: [hit, hit], iconAnchor: [hit / 2, hit / 2] });
}

function pulseDotIcon(color: string) {
  const html = `
    <div style="position:relative;width:22px;height:22px;">
      <div style="position:absolute;inset:0;border-radius:9999px;background:${color};opacity:.35;animation:nm-pulse 1.4s ease-out infinite;"></div>
      <div style="position:absolute;inset:5px;border-radius:9999px;background:${color};border:2px solid #fff;box-shadow:0 0 14px ${color};"></div>
    </div>`;
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

function FollowMe({ me, zoom = 18, lockRadiusKm = 2, disableLock = false, paused = false }: { me: LatLng | null | undefined; zoom?: number; lockRadiusKm?: number; disableLock?: boolean; paused?: boolean }) {
  const map = useMap();
  const didInitial = useRef(false);
  useEffect(() => {
    if (paused) return; // never pan the map under a drawing finger
    if (!me) return;
    if (!didInitial.current) {
      if (!disableLock) {
        map.setView([me.lat, me.lng], zoom, { animate: false });
        const dLat = lockRadiusKm / 111;
        const dLng = lockRadiusKm / (111 * Math.cos((me.lat * Math.PI) / 180));
        const bounds = L.latLngBounds(
          [me.lat - dLat, me.lng - dLng],
          [me.lat + dLat, me.lng + dLng],
        );
        map.setMaxBounds(bounds);
        map.setMinZoom(15);
      }
      didInitial.current = true;
    } else {
      const mb = map.options.maxBounds as L.LatLngBounds | undefined;
      if (mb && !mb.contains([me.lat, me.lng])) return;
      map.panTo([me.lat, me.lng], { animate: true });
    }
  }, [map, me?.lat, me?.lng, zoom, lockRadiusKm, disableLock, paused]);
  return null;
}

function LockToPolygon({ polygons, me, paddingRatio = 0.08 }: { polygons: LatLng[][]; me?: LatLng | null; paddingRatio?: number }) {
  const map = useMap();
  const sigRef = useRef("");
  // Last turf-union clamp, kept so the out-of-bounds widening below is always
  // "turf union + current position", never cumulative drift.
  const paddedRef = useRef<L.LatLngBounds | null>(null);
  useEffect(() => {
    const rings = polygons.filter((p) => p.length >= 3);
    if (rings.length === 0) return;
    // Re-fit when the locked turf set actually changes (live reassignment
    // swaps the canvasser's polygons without a remount).
    const sig = rings
      .map((ring) => ring.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join(";"))
      .join("|");
    if (sigRef.current === sig) return;
    sigRef.current = sig;
    // Clear the previous clamp first, or fitBounds gets constrained by it.
    map.setMaxBounds(null as unknown as L.LatLngBoundsExpression);
    map.setMinZoom(0);
    // One bounds over every assigned turf — a canvasser with two areas can
    // pan between both instead of being clamped inside the newest.
    const b = L.latLngBounds([]);
    rings.forEach((ring) => ring.forEach((p) => b.extend([p.lat, p.lng])));
    const padded = b.pad(paddingRatio);
    paddedRef.current = padded;
    map.fitBounds(padded, { padding: [20, 20], animate: false });
    map.setMaxBounds(padded);
    map.setMinZoom(map.getZoom());
    map.setMaxZoom(20);
  }, [map, polygons, paddingRatio]);

  // Standing just outside the turf: widen the clamp so the "me" dot stays
  // reachable (and FollowMe's in-bounds pan check passes again).
  useEffect(() => {
    const padded = paddedRef.current;
    if (!padded || !me) return;
    if (padded.contains([me.lat, me.lng])) {
      map.setMaxBounds(padded);
      return;
    }
    const widened = L.latLngBounds(padded.getSouthWest(), padded.getNorthEast())
      .extend(L.latLng(me.lat, me.lng).toBounds(120));
    map.setMaxBounds(widened);
  }, [map, me?.lat, me?.lng]);
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
  | {
      kind: "pin";
      onDrop: (ll: LatLng) => void;
      /** Currently armed knock result — shown in the on-map badge. */
      armed?: { label: string; color: string };
      /** True while a drop is in flight — map taps are ignored. */
      disabled?: boolean;
    };

export type HouseMarker = { id: string; lat: number; lng: number; name: string };

export type LeadStatus = "pending" | "confirmed" | "na" | "killed";
export type LeadPin = { id: string; lat: number; lng: number; status: LeadStatus; label?: string };

export const LEAD_STATUS_COLORS: Record<LeadStatus, string> = {
  pending: "#8a8f99",
  confirmed: "#39ff14",
  na: "#ffd60a",
  killed: "#ff2d55",
};

function leadPinIcon(color: string, solid: boolean, size = 20) {
  const html = solid
    ? `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:${color};border:2px solid #fff;box-shadow:0 0 14px ${color},0 0 22px ${color}88;"></div>`
    : `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:transparent;border:3px solid ${color};box-shadow:0 0 10px ${color}aa, inset 0 0 6px ${color}55;"></div>`;
  return L.divIcon({
    html, className: "neon-lead-pin",
    iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  });
}

function haversineM(a: LatLng, b: LatLng) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function houseIcon(name: string) {
  const safe = name.replace(/[<>&"']/g, "");
  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-8px);">
      <div style="background:rgba(11,15,26,0.85);border:1px solid #39ff14;color:#39ff14;font:700 10px/1 ui-sans-serif,system-ui;padding:3px 6px;border-radius:4px;white-space:nowrap;text-shadow:0 0 6px #39ff1488;box-shadow:0 0 8px #39ff1466;margin-bottom:2px;">${safe}</div>
      <div style="width:14px;height:14px;background:#39ff14;border:2px solid #fff;border-radius:2px;box-shadow:0 0 10px #39ff14;transform:rotate(45deg);"></div>
    </div>`;
  return L.divIcon({ html, className: "neon-house", iconSize: [80, 34], iconAnchor: [40, 30] });
}

/** Assignee name pill centered on a turf (video-style "JN · Jorge Najera").
 *  color may be hsl() (assignee colors) — alpha via color-mix, never hex suffix. */
function territoryLabelIcon(label: string, color: string) {
  const safe = label.replace(/[<>&"']/g, "");
  const html = `
    <div style="transform:translate(-50%,-50%);display:inline-flex;align-items:center;background:rgba(11,15,26,0.85);border:1px solid ${color};color:${color};font:700 11px/1 ui-sans-serif,system-ui;padding:4px 9px;border-radius:9999px;white-space:nowrap;box-shadow:0 0 10px color-mix(in srgb, ${color} 40%, transparent);">${safe}</div>`;
  return L.divIcon({ html, className: "neon-territory-label", iconSize: [0, 0], iconAnchor: [0, 0] });
}

/** Ray-cast point-in-polygon (lng as x, lat as y). */
function pointInPolygon(pt: LatLng, poly: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (
      a.lat > pt.lat !== b.lat > pt.lat &&
      pt.lng < ((b.lng - a.lng) * (pt.lat - a.lat)) / (b.lat - a.lat) + a.lng
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Anchor for the label pill: bbox center when inside the ring, else the
 *  polygon centroid — freehand shapes are often concave enough that the bbox
 *  center lands outside them. */
function labelAnchor(polygon: LatLng[]): [number, number] {
  const c = L.latLngBounds(polygon.map((p) => [p.lat, p.lng] as [number, number])).getCenter();
  const center = { lat: c.lat, lng: c.lng };
  if (pointInPolygon(center, polygon)) return [center.lat, center.lng];
  let area = 0, cx = 0, cy = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const cross = polygon[j].lng * polygon[i].lat - polygon[i].lng * polygon[j].lat;
    area += cross;
    cx += (polygon[j].lng + polygon[i].lng) * cross;
    cy += (polygon[j].lat + polygon[i].lat) * cross;
  }
  if (area === 0) return [center.lat, center.lng];
  const centroid = { lng: cx / (3 * area), lat: cy / (3 * area) };
  return pointInPolygon(centroid, polygon)
    ? [centroid.lat, centroid.lng]
    : [center.lat, center.lng];
}

/**
 * Freehand area drawing (SalesRabbit-style): one finger/mouse drags a white
 * stroke; on release the ring is simplified (Douglas-Peucker, pixel space)
 * and handed up as a closed polygon. Taps (<10px travel) fall through to the
 * map click so the tap-to-add-vertex path keeps working. A second touch
 * aborts the stroke so pinch-zoom stays available.
 */
function FreehandCapture({
  onComplete,
  onStrokeEnd,
}: {
  onComplete: (polygon: LatLng[]) => void;
  onStrokeEnd: () => void;
}) {
  const map = useMap();
  const [stroke, setStroke] = useState<LatLng[]>([]);
  // Callbacks live in refs so the pointer listeners bind once per map.
  const cbRef = useRef({ onComplete, onStrokeEnd });
  cbRef.current = { onComplete, onStrokeEnd };

  useEffect(() => {
    const el = map.getContainer();
    map.dragging.disable();
    const prevTouchAction = el.style.touchAction;
    const prevCursor = el.style.cursor;
    el.style.touchAction = "none"; // stop browser scroll/pull-to-refresh while drawing
    el.style.cursor = "crosshair";

    let activeId: number | null = null;
    let isStroke = false;
    // Ground truth is captured at event time (lls) — the map can pan/zoom
    // mid-stroke (GPS FollowMe, wheel zoom) and pixel→latlng conversion at
    // commit time would displace every earlier point. Pixels (pts) exist only
    // for the sampling gate and Douglas-Peucker tolerance; each carries the
    // index of its captured latlng so simplify() maps back losslessly.
    type IdxPoint = L.Point & { _i?: number };
    let pts: IdxPoint[] = [];
    let lls: LatLng[] = [];

    const toPoint = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      return L.point(e.clientX - rect.left, e.clientY - rect.top);
    };
    const capture = (e: PointerEvent) => {
      const p = toPoint(e) as IdxPoint;
      const ll = map.containerPointToLatLng(p);
      p._i = lls.length;
      pts.push(p);
      lls.push({ lat: ll.lat, lng: ll.lng });
    };
    const reset = () => {
      activeId = null;
      isStroke = false;
      pts = [];
      lls = [];
      setStroke([]);
    };

    const onDown = (e: PointerEvent) => {
      if (activeId !== null) {
        // Second finger joins → abort the stroke; Leaflet touchZoom takes over.
        reset();
        return;
      }
      if (!e.isPrimary) return;
      if (e.button !== 0) return; // right/middle mouse never starts a stroke
      activeId = e.pointerId;
      isStroke = false;
      pts = [];
      lls = [];
      capture(e);
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* older browsers */
      }
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== activeId) return;
      const p = toPoint(e);
      const last = pts[pts.length - 1];
      if (last && p.distanceTo(last) < 6) return; // sample every ≥6px
      capture(e);
      if (!isStroke && p.distanceTo(pts[0]) >= 10) isStroke = true;
      if (isStroke) {
        e.preventDefault();
        setStroke([...lls]);
      }
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== activeId) return;
      const wasStroke = isStroke;
      const drawnPts = pts;
      const drawnLls = lls;
      reset();
      if (!wasStroke) return; // tap → the map click adds a vertex instead
      cbRef.current.onStrokeEnd(); // suppress Leaflet's trailing synthetic click
      const simplified = L.LineUtil.simplify(drawnPts, 2.5) as IdxPoint[];
      if (simplified.length < 3) return;
      // Discard degenerate scribbles: the auto-closed ring must enclose a
      // real area (~30×30px), or a stray swipe becomes a sliver turf.
      let areaPx = 0;
      for (let i = 0; i < simplified.length; i++) {
        const a = simplified[i];
        const b = simplified[(i + 1) % simplified.length];
        areaPx += a.x * b.y - b.x * a.y;
      }
      if (Math.abs(areaPx) / 2 < 900) return;
      const ring = simplified
        .map((p) => (p._i != null ? drawnLls[p._i] : null))
        .filter((p): p is LatLng => p != null);
      if (ring.length < 3) return;
      cbRef.current.onComplete(ring);
    };

    const onCancel = (e: PointerEvent) => {
      if (e.pointerId === activeId) reset();
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove, { passive: false });
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    return () => {
      map.dragging.enable();
      el.style.touchAction = prevTouchAction;
      el.style.cursor = prevCursor;
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
    };
  }, [map]);

  if (stroke.length < 2) return null;
  return (
    <Polyline
      positions={stroke.map((p) => [p.lat, p.lng] as [number, number])}
      pathOptions={{ color: "#ffffff", weight: 3, opacity: 0.9 }}
    />
  );
}

export function NeonMap({
  territories,
  pins = [],
  houses = [],
  leads = [],
  proximityMeters = 30,
  me,
  mode = { kind: "view" },
  center,
  height = 480,
  follow = false,
  lockPolygons,
  onTerritoryClick,
  onPinClick,
  pendingPolygon,
}: {
  territories: Territory[];
  pins?: FieldPin[];
  houses?: HouseMarker[];
  leads?: LeadPin[];
  proximityMeters?: number;
  me?: LatLng | null;
  mode?: Mode;
  center?: LatLng;
  height?: number;
  follow?: boolean;
  /** Clamp pan/zoom to the union of these rings (all of a canvasser's turfs). */
  lockPolygons?: LatLng[][];
  onTerritoryClick?: (id: string) => void;
  /** Makes field pins tappable (own-pin corrections). Omit = inert markers. */
  onPinClick?: (id: string) => void;
  /** A drawn-but-unsaved ring, previewed dashed white until saved/discarded. */
  pendingPolygon?: LatLng[] | null;
}) {
  const [draft, setDraft] = useState<LatLng[]>([]);
  const mapRef = useRef<L.Map | null>(null);
  // Set when a freehand stroke just committed — swallows the synthetic click
  // some browsers fire after pointerup so it doesn't become a stray vertex/pin.
  const justDrewRef = useRef(0);

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

  const hasLock = !!lockPolygons?.some((p) => p.length >= 3);

  function handleClick(ll: LatLng) {
    if (Date.now() - justDrewRef.current < 400) return;
    if (mode.kind === "draw") setDraft((d) => [...d, ll]);
    if (mode.kind === "pin" && !mode.disabled) mode.onDrop(ll);
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
        // Cap at 65vh so short phones keep room for controls below the map
        height: `min(${height}px, 65vh)`,
        boxShadow: "0 0 24px -8px color-mix(in oklab, var(--neon) 50%, transparent), inset 0 0 80px -20px color-mix(in oklab, var(--neon) 25%, transparent)",
      }}
    >
      <MapContainer
        center={[fallbackCenter.lat, fallbackCenter.lng]}
        zoom={follow ? 17 : 13}
        zoomControl={false}
        scrollWheelZoom
        style={{ height: "100%", width: "100%", background: "#0b0f1a" }}
        ref={(instance) => { mapRef.current = instance; }}
      >
        <TileLayer
          attribution='&copy; Esri'
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          maxNativeZoom={19}
          maxZoom={20}
        />
        <TileLayer
          url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
          maxNativeZoom={19}
          maxZoom={20}
        />
        <InvalidateOnMount />
        <ClickCapture onClick={handleClick} />
        {hasLock && <LockToPolygon polygons={lockPolygons!} me={me} />}
        {follow ? <FollowMe me={me} disableLock={hasLock} paused={mode.kind === "draw"} /> : allPoints.length > 0 && !hasLock && <FitBounds points={allPoints} />}

        {territories.map((t) => (
          <Polygon
            key={t.id}
            positions={t.polygon.map((p) => [p.lat, p.lng] as [number, number])}
            pathOptions={{
              color: t.color,
              weight: 2,
              fillColor: t.color,
              ...(t.dashed
                ? { dashArray: "6 8", fillOpacity: 0.06 }
                : { fillOpacity: 0.15 }),
            }}
            eventHandlers={onTerritoryClick ? { click: () => onTerritoryClick(t.id) } : undefined}
          />
        ))}

        {territories.map((t) => {
          if (!t.assignmentLabel || t.polygon.length < 3) return null;
          return (
            <Marker
              key={`${t.id}-label`}
              position={labelAnchor(t.polygon)}
              icon={territoryLabelIcon(t.assignmentLabel, t.color)}
              interactive={false}
            />
          );
        })}

        {pendingPolygon && pendingPolygon.length >= 3 && (
          <Polygon
            positions={pendingPolygon.map((p) => [p.lat, p.lng] as [number, number])}
            pathOptions={{
              color: "#ffffff",
              weight: 2,
              dashArray: "6 6",
              fillColor: "#ffffff",
              fillOpacity: 0.08,
              interactive: false,
            }}
          />
        )}

        {mode.kind === "draw" && (
          <FreehandCapture
            onStrokeEnd={() => {
              justDrewRef.current = Date.now();
            }}
            onComplete={(poly) => {
              setDraft([]); // a committed stroke supersedes any tapped vertices
              mode.onComplete(poly);
            }}
          />
        )}

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

        {houses.map((h) => (
          <Marker key={h.id} position={[h.lat, h.lng]} icon={houseIcon(h.name)} />
        ))}

        {pins.map((p) => {
          const tappable = !!onPinClick && !p.pending;
          return (
            <Marker
              key={p.id}
              position={[p.lat, p.lng]}
              opacity={p.pending ? 0.6 : 1}
              // Inert markers must not swallow map taps — an untappable pin
              // would otherwise be a dead zone over the door next to it.
              interactive={tappable}
              eventHandlers={tappable ? { click: () => onPinClick(p.id) } : undefined}
              icon={
                p.is_remote_drop
                  ? flaggedPinIcon(22, tappable ? 30 : 22)
                  : p.pin_type === "lead"
                    ? leadStarIcon()
                    : glowingDotIcon(PIN_COLORS[p.pin_type], 18, tappable ? 30 : 18)
              }
            />
          );
        })}

        {leads.map((l) => {
          const color = LEAD_STATUS_COLORS[l.status];
          const dist = me ? haversineM(me, { lat: l.lat, lng: l.lng }) : Infinity;
          const solid = dist <= proximityMeters;
          return (
            <Marker
              key={`${l.id}:${solid ? "s" : "h"}:${l.status}`}
              position={[l.lat, l.lng]}
              icon={leadPinIcon(color, solid)}
            />
          );
        })}

        {me && <Marker position={[me.lat, me.lng]} icon={pulseDotIcon("#00e5ff")} />}
      </MapContainer>

      {/* Draw mode controls */}
      {mode.kind === "draw" && (
        <div className="absolute top-3 right-3 z-[1000] flex flex-col gap-2 text-xs">
          <div className="rounded border border-neon/60 bg-surface/90 backdrop-blur px-3 py-2 font-display text-[10px] uppercase tracking-widest text-neon">
            Drag to draw an area · tap for points{draft.length > 0 ? ` · ${draft.length} pts` : ""}
          </div>
          <div className="flex gap-2">
            <button
              onClick={finishDraft}
              disabled={draft.length < 3}
              className="flex-1 min-h-[40px] rounded bg-victory text-black font-display text-[10px] uppercase tracking-widest px-3 py-2 disabled:opacity-40"
            >
              Save Polygon
            </button>
            <button
              onClick={() => setDraft([])}
              className="min-h-[40px] rounded border border-border bg-surface/90 px-3 py-2 font-display text-[10px] uppercase tracking-widest"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Pin mode legend — shows the armed result so a scrolled-away picker
          can't silently mislabel a street of doors */}
      {mode.kind === "pin" && (
        <div className="absolute top-3 right-3 z-[1000] flex items-center gap-2 rounded border border-neon/60 bg-surface/90 backdrop-blur px-3 py-2 font-display text-[10px] uppercase tracking-widest text-neon">
          {mode.armed ? (
            <>
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: mode.armed.color, boxShadow: `0 0 8px ${mode.armed.color}` }}
              />
              Dropping: {mode.armed.label}
            </>
          ) : (
            "Tap map to drop pin"
          )}
        </div>
      )}

      {/* Recenter on my location (Leaflet clamps the jump inside maxBounds) */}
      {me && mode.kind !== "draw" && (
        <button
          type="button"
          aria-label="Center map on my location"
          onClick={() => {
            const m = mapRef.current;
            if (!m) return;
            m.setView([me.lat, me.lng], Math.max(m.getZoom(), 17), { animate: true });
          }}
          className="absolute bottom-16 right-3 z-[1000] flex h-11 w-11 items-center justify-center rounded-full border border-neon/60 bg-surface/90 backdrop-blur text-neon"
        >
          <LocateFixed className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}
