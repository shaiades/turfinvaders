import { Component, Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  MapContainer,
  TileLayer,
  Polygon,
  Polyline,
  Marker,
  Popup,
  useMapEvents,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "leaflet-rotate";
import { LocateFixed, Maximize2, Minimize2, Navigation2 } from "lucide-react";
import { viewBounds } from "@/lib/map-bounds";
import { PIN_COLORS, type PinType } from "@/lib/pin-results";
import { ZipBordersLayer, ZIP_MIN_ZOOM, type ZipTint } from "@/components/ZipBorders";
import { HouseBubblesLayer, HOUSE_MIN_ZOOM, type OsmHouse } from "@/components/HouseBubbles";
import { snapTapToHouse } from "@/lib/house-cache";
import { CustomerHomesLayer } from "@/components/CustomerHomes";

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
  /** Current assignee display name (drives the on-map popup); null = unassigned. */
  currentAssignee?: string | null;
  /** Past assignments newest-first, dates pre-formatted for the popup. */
  history?: Array<{ name: string; when: string }>;
  /** RepCard historical coverage — faint reference dashed area with no
   *  backing turf row. The popup still opens (it's real, tappable geometry)
   *  but must say so instead of offering "Assign / edit →": that button used
   *  to look identical to a real turf's and silently no-op on tap (the
   *  caller's onTerritoryClick short-circuits on the `repcard:` id prefix),
   *  which read as "I can't reassign this" with zero explanation. */
  readOnly?: boolean;
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
  /** Crew view: replaces the dot's white border with the owner's color so
   *  the result color (fill) still reads while pins attribute to a rep.
   *  hsl() strings welcome — alpha goes through color-mix, never hex tricks. */
  accent?: string | null;
};

/** A live crew position (Crew Map): pulsing avatar with initials + name pill. */
export type CrewMarker = {
  id: string;
  name: string;
  color: string;
  lat: number;
  lng: number;
};

const REMOTE_DROP_COLOR = "#8a8f99";

// Dashed-territory labels (RepCard history / unassigned) are the only
// unbounded label source — cull them to the viewport at neighborhood zoom
// and cap the count. Live assigned-turf labels always render.
const DASHED_LABEL_MIN_ZOOM = 13;
const DASHED_LABEL_CAP = 120;

// L.divIcon is a stateless descriptor, so instances are safely shared across
// markers. Caching keeps each marker's `icon` prop identity stable between
// renders — this page re-renders on every GPS tick, and a fresh identity per
// tick makes react-leaflet call setIcon and rebuild every marker's DOM.
// Key space is tiny (a handful of colors × two hit sizes).
const iconCache = new Map<string, L.DivIcon>();
function cachedIcon(key: string, make: () => L.DivIcon): L.DivIcon {
  let icon = iconCache.get(key);
  if (!icon) {
    icon = make();
    iconCache.set(key, icon);
  }
  return icon;
}

// `hit` grows the tappable box past the visual dot (interactive pins need a
// finger-sized target; an 18px dot alone is a dead zone on a phone).
// `ring` (crew view) swaps the white border for the owning rep's color —
// possibly an hsl() string, so its halo uses color-mix, not `${color}88`.
function glowingDotIcon(color: string, size = 18, hit = size, ring?: string) {
  return cachedIcon(`dot|${color}|${size}|${hit}|${ring ?? ""}`, () => {
    const border = ring ? `2.5px solid ${ring}` : "2px solid rgba(255,255,255,0.85)";
    const halo = ring ? `,0 0 0 2px color-mix(in srgb, ${ring} 45%, transparent)` : "";
    const html = `
    <div style="width:${hit}px;height:${hit}px;display:flex;align-items:center;justify-content:center;">
      <div style="
        width:${size}px;height:${size}px;border-radius:9999px;
        background:${color};
        border:${border};
        box-shadow:0 0 12px ${color},0 0 22px ${color}88,inset 0 0 6px rgba(255,255,255,0.6)${halo};
      "></div>
    </div>`;
    return L.divIcon({
      html,
      className: "neon-pin",
      iconSize: [hit, hit],
      iconAnchor: [hit / 2, hit / 2],
    });
  });
}

// Crew Map avatar: pulsing ring + initials core + name pill. Cached per
// (name, color) — bounded by roster size. divIcon html is raw innerHTML, so
// the display name is sanitized like every other label icon here.
function crewAvatarIcon(name: string, color: string) {
  return cachedIcon(`crew|${name}|${color}`, () => {
    const safe = name.replace(/[<>&"']/g, "");
    const inits =
      safe
        .trim()
        .split(/\s+/)
        .map((w) => w[0] ?? "")
        .join("")
        .slice(0, 2)
        .toUpperCase() || "?";
    const html = `
    <div style="position:relative;width:120px;height:52px;display:flex;flex-direction:column;align-items:center;">
      <div style="position:relative;width:32px;height:32px;">
        <div style="position:absolute;inset:0;border-radius:9999px;background:${color};opacity:.35;animation:nm-pulse 1.4s ease-out infinite;"></div>
        <div style="position:absolute;inset:4px;border-radius:9999px;background:color-mix(in srgb, ${color} 78%, #000);border:2px solid #fff;box-shadow:0 0 14px ${color};display:flex;align-items:center;justify-content:center;color:#fff;font:700 10px/1 ui-sans-serif,system-ui;text-shadow:0 0 4px #000;">${inits}</div>
      </div>
      <div style="margin-top:2px;max-width:118px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 6px;border-radius:9999px;background:rgba(11,15,26,.85);border:1px solid color-mix(in srgb, ${color} 60%, transparent);color:#fff;font:600 9px/1.4 ui-sans-serif,system-ui;">${safe}</div>
    </div>`;
    return L.divIcon({
      html,
      className: "neon-crew-avatar",
      iconSize: [120, 52],
      // Anchor on the avatar dot's center, not the box center — the pill hangs below.
      iconAnchor: [60, 16],
    });
  });
}

function leadStarIcon(size = 34) {
  return cachedIcon(`star|${size}`, () => {
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
  });
}

function flaggedPinIcon(size = 22, hit = size) {
  return cachedIcon(`flag|${size}|${hit}`, () => {
    const color = REMOTE_DROP_COLOR;
    const html = `
    <div style="width:${hit}px;height:${hit}px;display:flex;align-items:center;justify-content:center;">
      <div style="position:relative;width:${size}px;height:${size}px;">
        <div style="position:absolute;inset:0;border-radius:9999px;background:${color};border:2px dashed #fff;box-shadow:0 0 10px ${color},0 0 0 2px #ff2d5588;animation:nm-flag 1.6s ease-in-out infinite;"></div>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font:700 11px/1 ui-sans-serif,system-ui;text-shadow:0 0 4px #000;">!</div>
      </div>
    </div>`;
    return L.divIcon({
      html,
      className: "neon-pin-flag",
      iconSize: [hit, hit],
      iconAnchor: [hit / 2, hit / 2],
    });
  });
}

function pulseDotIcon(color: string) {
  return cachedIcon(`pulse|${color}`, () => {
    const html = `
    <div style="position:relative;width:22px;height:22px;">
      <div style="position:absolute;inset:0;border-radius:9999px;background:${color};opacity:.35;animation:nm-pulse 1.4s ease-out infinite;"></div>
      <div style="position:absolute;inset:5px;border-radius:9999px;background:${color};border:2px solid #fff;box-shadow:0 0 14px ${color};"></div>
    </div>`;
    return L.divIcon({
      html,
      className: "neon-pin-me",
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  });
}

function ClickCapture({ onClick }: { onClick: (ll: LatLng) => void }) {
  useMapEvents({
    click(e) {
      onClick({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

/** Drops Leaflet's own branding link from the attribution control (owner
 *  ask 2026-09-12). The tile provider's "© Esri" stays — Esri's basemap
 *  terms require attribution; styles.css shrinks it to a quiet chip. */
function AttributionPrefixOff() {
  const map = useMap();
  useEffect(() => {
    map.attributionControl?.setPrefix(false);
  }, [map]);
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

/**
 * Follow-my-dot, free-roam edition (owner ask 2026-09-10: "more mobility" —
 * SalesRabbit parity). The old 2 km maxBounds cage and minZoom floor are
 * gone: the map follows the GPS dot only while `tracking` is on, and any
 * hand-drag flips tracking off (see TrackingBreaker) so browsing the wider
 * map is never fought by the next GPS tick. The recenter button re-arms it.
 * Pinch/double-tap zooms deliberately do NOT break tracking — the follow pan
 * preserves zoom, so zooming while walking keeps working.
 */
function FollowMe({
  me,
  tracking,
  initialSnap,
  paused = false,
}: {
  me: LatLng | null | undefined;
  tracking: boolean;
  /** Snap to street level on the first fix — off when a turf fit framed the map. */
  initialSnap: boolean;
  paused?: boolean;
}) {
  const map = useMap();
  const didInitial = useRef(false);
  useEffect(() => {
    if (paused) return; // never pan the map under a drawing finger
    if (!me || !tracking) return;
    if (!didInitial.current) {
      didInitial.current = true;
      if (initialSnap) {
        map.setView([me.lat, me.lng], Math.max(map.getZoom(), 17), { animate: false });
        return;
      }
    }
    map.panTo([me.lat, me.lng], { animate: true });
  }, [map, me?.lat, me?.lng, tracking, initialSnap, paused]);
  return null;
}

/** Flip tracking off the moment a hand drags the map — dragstart only fires
 *  for user drags, never for our own panTo/fitBounds, so programmatic moves
 *  can't false-break the follow. */
function TrackingBreaker({ onBreak }: { onBreak: () => void }) {
  const map = useMap();
  const cbRef = useRef(onBreak);
  cbRef.current = onBreak;
  useEffect(() => {
    const breakIt = () => cbRef.current();
    map.on("dragstart", breakIt);
    return () => {
      map.off("dragstart", breakIt);
    };
  }, [map]);
  return null;
}

/** Frame the union of the given rings on mount and whenever the turf set
 *  actually changes (live reassignment swaps polygons without a remount).
 *  Framing only — pan/zoom stay free afterwards (the old maxBounds/minZoom
 *  clamp is gone with the mobility rework). */
function FitPolygons({
  polygons,
  paddingRatio = 0.08,
}: {
  polygons: LatLng[][];
  paddingRatio?: number;
}) {
  const map = useMap();
  const sigRef = useRef("");
  useEffect(() => {
    const rings = polygons.filter((p) => p.length >= 3);
    if (rings.length === 0) return;
    const sig = rings
      .map((ring) => ring.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join(";"))
      .join("|");
    if (sigRef.current === sig) return;
    sigRef.current = sig;
    const b = L.latLngBounds([]);
    rings.forEach((ring) => ring.forEach((p) => b.extend([p.lat, p.lng])));
    // maxZoom 17: a single tiny turf must not open at rooftop zoom 20.
    map.fitBounds(b.pad(paddingRatio), { padding: [20, 20], animate: false, maxZoom: 17 });
  }, [map, polygons, paddingRatio]);
  return null;
}

/** Animated jump to an external target (the Turf Tools ZIP search). Keyed so
 *  repeating the same search re-flies. */
function FlyTo({
  target,
}: {
  target: { bounds: [[number, number], [number, number]]; key: number } | null | undefined;
}) {
  const map = useMap();
  const lastKey = useRef<number | null>(null);
  useEffect(() => {
    if (!target || target.key === lastKey.current) return;
    lastKey.current = target.key;
    map.flyToBounds(L.latLngBounds(target.bounds), { padding: [30, 30], maxZoom: 16 });
  }, [map, target]);
  return null;
}

/** Report zoom to the "zoom in for house circles" pill (zoomend + initial
 *  read — BearingWatcher pattern). */
function ZoomWatcher({ onZoom }: { onZoom: (z: number) => void }) {
  const map = useMap();
  const cbRef = useRef(onZoom);
  cbRef.current = onZoom;
  useEffect(() => {
    const report = () => cbRef.current(map.getZoom());
    map.on("zoomend", report);
    report();
    return () => {
      map.off("zoomend", report);
    };
  }, [map]);
  return null;
}

/** Report viewport bounds + zoom on move/zoom end — drives dashed-label
 *  culling. viewBounds() (not getBounds) because leaflet-rotate can collapse
 *  the latter to a point. */
function ViewTracker({
  onView,
}: {
  onView: (v: { bounds: L.LatLngBounds; zoom: number }) => void;
}) {
  const map = useMap();
  const cbRef = useRef(onView);
  cbRef.current = onView;
  useEffect(() => {
    const report = () => cbRef.current({ bounds: viewBounds(map), zoom: map.getZoom() });
    map.on("moveend", report);
    map.on("zoomend", report);
    report();
    return () => {
      map.off("moveend", report);
      map.off("zoomend", report);
    };
  }, [map]);
  return null;
}

/** Report the map's bearing to the compass button (leaflet-rotate fires
 *  'rotate' both for two-finger twists and programmatic setBearing). */
function BearingWatcher({ onBearing }: { onBearing: (deg: number) => void }) {
  const map = useMap();
  const cbRef = useRef(onBearing);
  cbRef.current = onBearing;
  useEffect(() => {
    const report = () => cbRef.current(map.getBearing?.() ?? 0);
    map.on("rotate", report);
    report();
    return () => {
      map.off("rotate", report);
    };
  }, [map]);
  return null;
}

/** Reports center/zoom/bearing on move/zoom/rotate so a caller can restore
 *  the view after this NeonMap unmounts (Turf Tools mounts a separate map
 *  instance — captain feedback 2026-09-17: switching modes reset the view). */
function ViewPersistWatcher({
  onChange,
}: {
  onChange: (v: { center: LatLng; zoom: number; bearing: number }) => void;
}) {
  const map = useMap();
  const cbRef = useRef(onChange);
  cbRef.current = onChange;
  useEffect(() => {
    const report = () => {
      const c = map.getCenter();
      cbRef.current({
        center: { lat: c.lat, lng: c.lng },
        zoom: map.getZoom(),
        bearing: map.getBearing?.() ?? 0,
      });
    };
    map.on("moveend", report);
    map.on("zoomend", report);
    map.on("rotate", report);
    return () => {
      map.off("moveend", report);
      map.off("zoomend", report);
      map.off("rotate", report);
    };
  }, [map]);
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
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
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
      /** When true, map taps are ignored (page-level hold, e.g. no GPS). */
      disabled?: boolean;
    };

export type HouseMarker = { id: string; lat: number; lng: number; name: string };

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
 *  color may be hsl() (assignee colors) — alpha via color-mix, never hex suffix.
 *  Cached like every other divIcon here: the manager map can hold thousands of
 *  RepCard-history labels, and a fresh icon identity per GPS-tick render made
 *  react-leaflet rebuild every one of their DOM nodes each second. */
function territoryLabelIcon(label: string, color: string) {
  return cachedIcon(`tlabel|${label}|${color}`, () => {
    const safe = label.replace(/[<>&"']/g, "");
    const html = `
    <div style="transform:translate(-50%,-50%);display:inline-flex;align-items:center;background:rgba(11,15,26,0.85);border:1px solid ${color};color:${color};font:700 11px/1 ui-sans-serif,system-ui;padding:4px 9px;border-radius:9999px;white-space:nowrap;box-shadow:0 0 10px color-mix(in srgb, ${color} 40%, transparent);">${safe}</div>`;
    return L.divIcon({
      html,
      className: "neon-territory-label",
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
  });
}

/** Ray-cast point-in-polygon (lng as x, lat as y). */
function pointInPolygon(pt: LatLng, poly: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
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
  let area = 0,
    cx = 0,
    cy = 0;
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
  onDiscard,
}: {
  onComplete: (polygon: LatLng[]) => void;
  onStrokeEnd: () => void;
  /** A finished stroke was thrown away (too small / too few points). */
  onDiscard: () => void;
}) {
  const map = useMap();
  const [stroke, setStroke] = useState<LatLng[]>([]);
  // Callbacks live in refs so the pointer listeners bind once per map.
  const cbRef = useRef({ onComplete, onStrokeEnd, onDiscard });
  cbRef.current = { onComplete, onStrokeEnd, onDiscard };

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
    // Stroke state flushes at most once per frame: setState per 6px pointer
    // sample repainted the whole vector canvas per sample, which is what
    // froze (and on iOS crashed) mid-draw.
    let raf = 0;
    const flushStroke = () => {
      raf = 0;
      setStroke([...lls]);
    };

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
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
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
        if (!raf) raf = requestAnimationFrame(flushStroke);
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
      if (simplified.length < 3) {
        cbRef.current.onDiscard();
        return;
      }
      // Discard degenerate scribbles: the auto-closed ring must enclose a
      // real area (~30×30px), or a stray swipe becomes a sliver turf.
      let areaPx = 0;
      for (let i = 0; i < simplified.length; i++) {
        const a = simplified[i];
        const b = simplified[(i + 1) % simplified.length];
        areaPx += a.x * b.y - b.x * a.y;
      }
      if (Math.abs(areaPx) / 2 < 900) {
        cbRef.current.onDiscard();
        return;
      }
      const ring = simplified
        .map((p) => (p._i != null ? drawnLls[p._i] : null))
        .filter((p): p is LatLng => p != null);
      if (ring.length < 3) {
        cbRef.current.onDiscard();
        return;
      }
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
      if (raf) cancelAnimationFrame(raf);
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

function NeonMapInner({
  territories,
  pins = [],
  houses = [],
  me,
  mode = { kind: "view" },
  center,
  height = 480,
  follow = false,
  initialZoom,
  initialBearing,
  onViewChange,
  fitPolygons,
  onTerritoryClick,
  onPinClick,
  pendingPolygon,
  flyTo,
  territoryPopups = false,
  houseBubbles = false,
  onHouseTap,
  zipTints,
  onZipTap,
  crew,
  overlay,
}: {
  territories: Territory[];
  pins?: FieldPin[];
  houses?: HouseMarker[];
  me?: LatLng | null;
  mode?: Mode;
  center?: LatLng;
  /** px number (capped at 65vh) or any CSS length verbatim, e.g. "42dvh". */
  height?: number | string;
  follow?: boolean;
  /** Overrides the follow/13 default zoom at construction (e.g. restoring a
   *  saved view across a mode-switch remount). */
  initialZoom?: number;
  /** Overrides the 0 default bearing at construction. */
  initialBearing?: number;
  /** Reports center/zoom/bearing on move/zoom/rotate — pairs with
   *  initialZoom/initialBearing/center to survive a remount. */
  onViewChange?: (v: { center: LatLng; zoom: number; bearing: number }) => void;
  /** Open framing the union of these rings (all of a canvasser's turfs) and
   *  re-frame on reassignment. Framing only — movement stays free. */
  fitPolygons?: LatLng[][];
  onTerritoryClick?: (id: string) => void;
  /** Makes field pins tappable (own-pin corrections). Omit = inert markers. */
  onPinClick?: (id: string) => void;
  /** A drawn-but-unsaved ring, previewed dashed white until saved/discarded. */
  pendingPolygon?: LatLng[] | null;
  /** Animated jump target (SW/NE bounds); bump `key` to re-fly. */
  flyTo?: { bounds: [[number, number], [number, number]]; key: number } | null;
  /** Manager mode: tapping a turf opens an on-map popup (current assignee +
   *  recent history + an edit button) instead of firing onTerritoryClick
   *  directly. The popup's button calls onTerritoryClick to open the sheet. */
  territoryPopups?: boolean;
  /** D2DU-style bubble over every house (OSM buildings) at street zoom. */
  houseBubbles?: boolean;
  /** Makes house bubbles tappable — the canvass screen's one-tap result sheet. */
  onHouseTap?: (house: OsmHouse) => void;
  /** ZIP → captain tint (color + name pill) for assigned ZIP codes. */
  zipTints?: Record<string, ZipTint>;
  /** Admin assign mode: ZIP polygons become tappable (forces the layer on). */
  onZipTap?: (zip: string) => void;
  /** Crew Map: live rep positions as pulsing avatar markers (default pane —
   *  custom panes render displaced under leaflet-rotate). */
  crew?: CrewMarker[];
  /** Screen-owned floating controls (armed chips, piggy pill, Assign/Discard
   *  buttons…) rendered INSIDE the map frame so they ride along into
   *  fullscreen. Position them absolute with z-[1000] like before — a
   *  sibling-of-NeonMap overlay gets left behind when the map goes fixed. */
  overlay?: ReactNode;
}) {
  const [draft, setDraft] = useState<LatLng[]>([]);
  const mapRef = useRef<L.Map | null>(null);
  // Set when a freehand stroke just committed — swallows the synthetic click
  // some browsers fire after pointerup so it doesn't become a stray vertex/pin.
  const justDrewRef = useRef(0);
  // Follow-my-dot state: on while the map should chase the GPS dot, off the
  // moment the user drags away (recenter re-arms). Starts as the follow prop.
  const [tracking, setTracking] = useState(follow);
  // ZIP borders on by default (owner ask 2026-09-10); preference sticks
  // per device. try/catch: private mode must not take the map down.
  const [zipOn, setZipOn] = useState(() => {
    try {
      return typeof window !== "undefined" && localStorage.getItem("ti_zip_borders") !== "0";
    } catch {
      return true;
    }
  });
  function toggleZip() {
    setZipOn((on) => {
      try {
        localStorage.setItem("ti_zip_borders", on ? "0" : "1");
      } catch {
        /* preference just won't stick */
      }
      return !on;
    });
  }

  // A search fly-away is a deliberate departure — the next GPS tick must not
  // yank the map back to the dot.
  useEffect(() => {
    if (flyTo?.key != null) setTracking(false);
  }, [flyTo?.key]);

  // Map bearing (leaflet-rotate) — drives the compass needle.
  const [bearing, setBearing] = useState(0);
  // Current zoom — drives the "zoom in for house circles" pill on bubble
  // screens (below HOUSE_MIN_ZOOM the map is silently circle-less otherwise).
  const [zoomLevel, setZoomLevel] = useState<number | null>(null);
  // Overpass down/offline (low-service field crew) — drives the persistent
  // "circles unavailable" banner below, replacing a toast that only fired
  // once per session and was easy to miss.
  const [circlesUnavailable, setCirclesUnavailable] = useState(false);
  // Viewport (moveend/zoomend) — drives dashed-label culling below.
  const [labelView, setLabelView] = useState<{ bounds: L.LatLngBounds; zoom: number } | null>(null);
  // Assign mode must see the ZIPs it's assigning, whatever the toggle says.
  const zipsEnabled = zipOn || !!onZipTap;
  // Drawing needs a light map: the vector canvas repaints on every stroke
  // sample, so shed the heavy read-only layers (customer badges, ZIP borders,
  // house bubbles) while the finger is the priority. They come right back
  // when draw mode ends.
  const drawingNow = mode.kind === "draw";
  // Full screen = CSS takeover (fixed overlay), NOT the Fullscreen API —
  // iPhone Safari doesn't allow element fullscreen and this app lives on
  // phones. z-[1500] sits above page chrome and the z-30 bottom nav but
  // below every sheet (Active Run's z-[2000] surfaces, radix z-[9999]), so
  // house-result and draw→assign flows keep working over the expanded map.
  const [isFull, setIsFull] = useState(false);
  useEffect(() => {
    // Leaflet sizes itself off the container — retile after the box jumps
    // (InvalidateOnMount's staggered pattern; no window resize fires here).
    const m = mapRef.current;
    if (!m) return;
    const run = () => m.invalidateSize();
    run();
    const t1 = window.setTimeout(run, 120);
    const t2 = window.setTimeout(run, 400);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [isFull]);
  useEffect(() => {
    if (!isFull) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // the page must not scroll behind the map
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [isFull]);

  // Feedback for a discarded stroke — the old silent return read as "my
  // drawing didn't register".
  const [drawHint, setDrawHint] = useState<string | null>(null);
  const drawHintTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(drawHintTimer.current), []);
  function flashDrawHint(msg: string) {
    setDrawHint(msg);
    window.clearTimeout(drawHintTimer.current);
    drawHintTimer.current = window.setTimeout(() => setDrawHint(null), 3500);
  }

  const fallbackCenter = useMemo<LatLng>(() => {
    if (center) return center;
    if (me) return me;
    if (territories[0]?.polygon[0]) return territories[0].polygon[0];
    if (pins[0]) return { lat: pins[0].lat, lng: pins[0].lng };
    return { lat: 39.8283, lng: -98.5795 }; // continental US center
  }, [center, me, territories, pins]);

  const hasFit = !!fitPolygons?.some((p) => p.length >= 3);

  // Only the initial FitBounds consumes this — skip the flatten (it walks
  // every vertex of every ring, per GPS tick otherwise) when following or
  // when fitPolygons frames the view instead.
  const allPoints = useMemo<LatLng[]>(() => {
    if (follow || hasFit) return [];
    const pts: LatLng[] = [];
    territories.forEach((t) => pts.push(...t.polygon));
    pins.forEach((p) => pts.push({ lat: p.lat, lng: p.lng }));
    if (me) pts.push(me);
    return pts;
  }, [follow, hasFit, territories, pins, me]);

  // Leaflet-facing props are memoized against the territory set's identity.
  // Inline `t.polygon.map(...)` / object-literal pathOptions handed every
  // Polygon a fresh identity per render, so each GPS tick ran setLatLngs +
  // setStyle across all ~2,800 manager-map rings and forced a full canvas
  // repaint every second.
  const territoryRender = useMemo(
    () =>
      territories.map((t) => ({
        t,
        positions: t.polygon.map((p) => [p.lat, p.lng] as [number, number]),
        pathOptions: {
          color: t.color,
          weight: 2,
          fillColor: t.color,
          ...(t.dashed ? { dashArray: "6 8", fillOpacity: 0.06 } : { fillOpacity: 0.15 }),
        },
      })),
    [territories],
  );

  // Label anchors are memoized against the territory set's identity:
  // labelAnchor runs point-in-polygon + centroid math per ring, this
  // component re-renders on every GPS tick, and the manager map carries
  // ~2,800 RepCard-history rings — recomputing every anchor each second
  // froze (and on iOS crashed) that screen.
  const territoryLabels = useMemo(
    () =>
      territories
        .filter((t) => !!t.assignmentLabel && t.polygon.length >= 3)
        .map((t) => {
          let s = 90,
            n = -90,
            w = 180,
            e = -180;
          for (const p of t.polygon) {
            if (p.lat < s) s = p.lat;
            if (p.lat > n) n = p.lat;
            if (p.lng < w) w = p.lng;
            if (p.lng > e) e = p.lng;
          }
          return {
            key: `${t.id}-label`,
            label: t.assignmentLabel!,
            color: t.color,
            dashed: !!t.dashed,
            anchor: labelAnchor(t.polygon),
            bbox: { s, n, w, e },
          };
        }),
    [territories],
  );
  const hasDashedLabels = useMemo(() => territoryLabels.some((l) => l.dashed), [territoryLabels]);

  // Live (solid) turf labels always render — a roster's worth at most.
  // Dashed coverage (RepCard history, unassigned areas) is throttled hard:
  // neighborhood zoom only, viewport only, capped — the county-wide "label
  // wall" was thousands of permanent DOM markers.
  const visibleLabels = useMemo(() => {
    const live = territoryLabels.filter((l) => !l.dashed);
    if (live.length === territoryLabels.length) return territoryLabels;
    if (!labelView || labelView.zoom < DASHED_LABEL_MIN_ZOOM) return live;
    const b = labelView.bounds.pad(0.2);
    const bn = b.getNorth(),
      bs = b.getSouth(),
      be = b.getEast(),
      bw = b.getWest();
    const out = live.slice();
    for (const l of territoryLabels) {
      if (out.length >= live.length + DASHED_LABEL_CAP) break;
      if (l.dashed && l.bbox.s <= bn && l.bbox.n >= bs && l.bbox.w <= be && l.bbox.e >= bw) {
        out.push(l);
      }
    }
    return out;
  }, [territoryLabels, labelView]);

  function handleClick(ll: LatLng) {
    if (Date.now() - justDrewRef.current < 400) return;
    if (mode.kind === "draw") setDraft((d) => [...d, ll]);
    if (mode.kind === "pin" && !mode.disabled) {
      // Near-miss forgiveness (rep feedback 2026-09-15: "if I don't click it
      // perfectly on the circle it automatically puts not home"): a tap
      // within the pin↔house match radius of a cached house is a tap AT that
      // house — open its result sheet instead of insta-dropping the armed
      // result. A dropped pin inside that radius would have colored this
      // house's bubble anyway; truly bubble-less spots (rural, new builds)
      // still get the armed free-roam drop below.
      if (houseBubbles && onHouseTap) {
        const snapped = snapTapToHouse(ll.lat, ll.lng, pins);
        if (snapped) {
          onHouseTap(snapped);
          return;
        }
      }
      mode.onDrop(ll);
    }
  }

  function finishDraft() {
    if (mode.kind !== "draw" || draft.length < 3) return;
    mode.onComplete(draft);
    setDraft([]);
  }

  // Cap px heights at 65vh so short phones keep room for controls below
  // the map; string heights (e.g. Active Run's clamp()) pass verbatim.
  const heightCss = typeof height === "number" ? `min(${height}px, 65vh)` : height;

  return (
    <>
      {/* Spacer keeps the page layout (and scroll position) put while the
          map floats fullscreen above it. */}
      {isFull && <div aria-hidden style={{ height: heightCss }} />}
      <div
        className={
          isFull
            ? "fixed left-0 right-0 z-[1500] overflow-hidden bg-background"
            : "relative rounded-lg overflow-hidden border border-[color-mix(in_oklab,var(--neon)_35%,var(--border))]"
        }
        style={
          isFull
            ? {
                // Installed-PWA case (viewport-fit=cover): stop at the notch
                // and home bar; plain Safari resolves these to 0 = edge to edge.
                top: "env(safe-area-inset-top, 0px)",
                bottom: "env(safe-area-inset-bottom, 0px)",
              }
            : {
                height: heightCss,
                boxShadow:
                  "0 0 24px -8px color-mix(in oklab, var(--neon) 50%, transparent), inset 0 0 80px -20px color-mix(in oklab, var(--neon) 25%, transparent)",
              }
        }
      >
        <MapContainer
          center={[fallbackCenter.lat, fallbackCenter.lng]}
          zoom={initialZoom ?? (follow ? 17 : 13)}
          zoomControl={false}
          // Stock shift-drag box-zoom FIGHTS leaflet-rotate's shiftKeyRotate
          // for the same gesture — both enabled, a shift-drag box-zoomed and
          // spun at once and could fling the panes thousands of px off-screen
          // (the "map went black" report). Rotation owns shift-drag.
          boxZoom={false}
          // Canvas renderer: draws vector layers on a single <canvas> instead of
          // one SVG node per shape, so the map stays smooth with thousands of
          // polygons (e.g. the imported RepCard territory-history coverage).
          preferCanvas
          scrollWheelZoom
          // leaflet-rotate: two-finger twist on phones, shift-drag on desktop
          // (owner ask 2026-09-11: "the map does not spin"). The compass button
          // below resets north; the plugin's own control stays off.
          rotate
          touchRotate
          shiftKeyRotate
          rotateControl={false}
          bearing={initialBearing ?? 0}
          style={{ height: "100%", width: "100%", background: "#0b0f1a" }}
          ref={(instance) => {
            mapRef.current = instance;
          }}
        >
          <TileLayer
            attribution="&copy; Esri"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            maxNativeZoom={19}
            maxZoom={20}
          />
          {/* Street names on the imagery (Jorge's ask, 2026-09-12) — Esri's
            transportation reference layer, the standard hybrid pairing. Its
            tiles label streets progressively as you zoom in. */}
          <TileLayer
            url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"
            maxNativeZoom={19}
            maxZoom={20}
          />
          <TileLayer
            url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
            maxNativeZoom={19}
            maxZoom={20}
          />
          <InvalidateOnMount />
          <AttributionPrefixOff />
          <BearingWatcher onBearing={setBearing} />
          {houseBubbles && <ZoomWatcher onZoom={setZoomLevel} />}
          {hasDashedLabels && <ViewTracker onView={setLabelView} />}
          {onViewChange && <ViewPersistWatcher onChange={onViewChange} />}
          <FlyTo target={flyTo} />
          <ClickCapture onClick={handleClick} />
          <ZipBordersLayer
            enabled={zipsEnabled && !drawingNow}
            tints={zipTints}
            onZipTap={onZipTap}
          />
          {/* Every Tidal customer, every surface (owner 2026-09-14) — except
            mid-draw: the badges are DOM markers the stroke has to composite
            over, and unmounting (not just inerting) also keeps a badge tap
            from eating polygon vertices. */}
          {!drawingNow && <CustomerHomesLayer tappable />}
          {houseBubbles && !drawingNow && (
            <HouseBubblesLayer
              enabled
              pins={pins}
              onHouseTap={onHouseTap}
              onAvailabilityChange={setCirclesUnavailable}
            />
          )}
          {hasFit && <FitPolygons polygons={fitPolygons!} />}
          {follow ? (
            <>
              <TrackingBreaker onBreak={() => setTracking(false)} />
              <FollowMe
                me={me}
                tracking={tracking}
                initialSnap={!hasFit}
                paused={mode.kind === "draw"}
              />
            </>
          ) : (
            allPoints.length > 0 && !hasFit && <FitBounds points={allPoints} />
          )}

          {territoryRender.map(({ t, positions, pathOptions }) => {
            // Popup mode: click opens the on-map card (below), not the sheet —
            // the card's button opens the sheet. Otherwise keep the plain
            // click→onTerritoryClick used by the canvasser/spectator maps.
            const withPopup = territoryPopups && !!onTerritoryClick;
            // "Earlier" = history minus the current assignment (usually the
            // newest row); if currently unassigned, show all recent rows.
            const earlier = (t.history ?? []).slice(
              t.currentAssignee ? 1 : 0,
              t.currentAssignee ? 5 : 4,
            );
            return (
              <Polygon
                key={t.id}
                positions={positions}
                pathOptions={pathOptions}
                eventHandlers={
                  !withPopup && onTerritoryClick
                    ? { click: () => onTerritoryClick(t.id) }
                    : undefined
                }
              >
                {withPopup && (
                  <Popup className="turf-popup" minWidth={190}>
                    <div className="nm-pop-title">{t.name?.trim() || "Area"}</div>
                    <div className="nm-pop-now">
                      Now · <b>{t.currentAssignee ?? "Unassigned"}</b>
                    </div>
                    {earlier.length > 0 ? (
                      <div className="nm-pop-hist">
                        <div className="nm-pop-head">Earlier</div>
                        {earlier.map((h, i) => (
                          <div key={i} className="nm-pop-row">
                            <span className="nm-pop-name">{h.name}</span>
                            <span className="nm-pop-when">{h.when}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="nm-pop-empty">No earlier assignments</div>
                    )}
                    {t.readOnly ? (
                      <div className="nm-pop-empty">Historical coverage — not editable</div>
                    ) : (
                      <button
                        type="button"
                        className="nm-pop-btn"
                        onClick={() => {
                          // Close the on-map card before the sheet takes over, so
                          // it isn't left open behind (and after) the sheet.
                          mapRef.current?.closePopup();
                          onTerritoryClick!(t.id);
                        }}
                      >
                        Assign / edit →
                      </button>
                    )}
                  </Popup>
                )}
              </Polygon>
            );
          })}

          {visibleLabels.map((l) => (
            <Marker
              key={l.key}
              position={l.anchor}
              icon={territoryLabelIcon(l.label, l.color)}
              interactive={false}
            />
          ))}

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
              onDiscard={() => flashDrawHint("Too small — zoom in and draw a bigger loop")}
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
                      : glowingDotIcon(
                          PIN_COLORS[p.pin_type],
                          18,
                          tappable ? 30 : 18,
                          p.accent ?? undefined,
                        )
                }
              />
            );
          })}

          {me && <Marker position={[me.lat, me.lng]} icon={pulseDotIcon("#00e5ff")} />}

          {(crew ?? []).map((c) => (
            <Marker
              key={`crew-${c.id}`}
              position={[c.lat, c.lng]}
              icon={crewAvatarIcon(c.name, c.color)}
              // Avatars float above every pin; taps pass through — the legend
              // chips below the map are the interaction surface.
              zIndexOffset={1000}
              interactive={false}
            />
          ))}
        </MapContainer>

        {/* Draw mode controls */}
        {mode.kind === "draw" && (
          <div className="absolute top-3 right-3 z-[1000] flex flex-col gap-2 text-xs">
            <div className="rounded border border-neon/60 bg-surface/90 backdrop-blur px-3 py-2 font-display text-[10px] uppercase tracking-widest text-neon">
              Drag to draw an area · tap for points
              {draft.length > 0 ? ` · ${draft.length} pts` : ""}
            </div>
            {drawHint && (
              <div className="rounded border border-yellow-400/60 bg-surface/90 backdrop-blur px-3 py-2 font-display text-[10px] uppercase tracking-widest text-yellow-300">
                {drawHint}
              </div>
            )}
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

        {/* "Every home has a circle" only holds at door-to-door zoom — between
          neighborhood browse (z14) and there, say so instead of showing a
          silently circle-less map. One tap fixes it. Bottom-center is free
          on both bubble screens (armed chips bottom-3, trophy bottom-16
          left, controls bottom-16 right). */}
        {houseBubbles && zoomLevel != null && zoomLevel >= 14 && zoomLevel < HOUSE_MIN_ZOOM && (
          <button
            type="button"
            onClick={() => mapRef.current?.setZoom(HOUSE_MIN_ZOOM)}
            className="absolute bottom-16 left-1/2 -translate-x-1/2 z-[1000] min-h-11 rounded-full border border-neon/60 bg-surface/90 backdrop-blur px-4 font-display text-[10px] uppercase tracking-widest text-neon"
          >
            Zoom in for house circles
          </button>
        )}

        {/* Overpass down (no/low service) — house circles won't appear, but
          logging still works: every result chip is always "armed" (one is
          selected by default), so a tap anywhere on the bare map still drops
          that result exactly where tapped (useFieldPins.dropAtPoint). Stays
          up for as long as it's true instead of a toast shown once and
          gone — the whole point is a crew member glancing back at a bad-
          service moment still sees it. Same slot as the zoom pill above;
          the two never show together (this needs HOUSE_MIN_ZOOM, that pill
          only shows below it). */}
        {houseBubbles && !drawingNow && circlesUnavailable && zoomLevel != null && zoomLevel >= HOUSE_MIN_ZOOM && (
          <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-[1000] max-w-[calc(100%-1.5rem)] rounded-full border border-[var(--warning)]/60 bg-surface/90 backdrop-blur px-4 py-2 text-center font-display text-[10px] uppercase tracking-widest text-[var(--warning)]">
            Circles unavailable — tap the map to log a result
          </div>
        )}

        {/* Map controls: fullscreen + compass + ZIP borders toggle + recenter,
          bottom-right */}
        <div className="absolute bottom-16 right-3 z-[1000] flex flex-col items-center gap-2">
          <button
            type="button"
            aria-label={isFull ? "Exit full screen" : "View map full screen"}
            aria-pressed={isFull}
            title={isFull ? "Exit full screen" : "Full screen"}
            onClick={() => setIsFull((f) => !f)}
            className="flex h-11 w-11 items-center justify-center rounded-full border bg-surface/90 backdrop-blur"
            style={
              isFull
                ? {
                    color: "var(--neon)",
                    borderColor: "color-mix(in oklab, var(--neon) 60%, var(--border))",
                    boxShadow: "0 0 10px -2px color-mix(in oklab, var(--neon) 60%, transparent)",
                  }
                : { color: "var(--muted-foreground)", borderColor: "var(--border)" }
            }
          >
            {isFull ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
          </button>
          {/* Compass: needle tracks the bearing (two-finger twist / shift-drag
            spins the map); tap snaps back to north. */}
          <button
            type="button"
            aria-label="Reset map rotation to north"
            title={
              bearing === 0
                ? "Facing north — twist with two fingers to rotate"
                : `Rotated ${Math.round(bearing)}° — tap to face north`
            }
            onClick={() => mapRef.current?.setBearing?.(0)}
            className="flex h-11 w-11 items-center justify-center rounded-full border bg-surface/90 backdrop-blur"
            style={
              bearing !== 0
                ? { color: "#ffd60a", borderColor: "#ffd60a99", boxShadow: "0 0 10px -2px #ffd60a" }
                : { color: "var(--muted-foreground)", borderColor: "var(--border)" }
            }
          >
            <span
              className="relative flex items-center justify-center"
              style={{ transform: `rotate(${bearing}deg)`, transition: "transform 120ms linear" }}
            >
              <Navigation2 className="h-5 w-5" fill="currentColor" />
              <span className="absolute -top-1.5 font-display text-[7px] leading-none" aria-hidden>
                N
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-label={zipOn ? "Hide ZIP code borders" : "Show ZIP code borders"}
            aria-pressed={zipOn}
            title={`ZIP code borders ${zipOn ? "on" : "off"} — visible from zoom ${ZIP_MIN_ZOOM}+`}
            onClick={toggleZip}
            className="flex h-11 w-11 items-center justify-center rounded-full border bg-surface/90 backdrop-blur font-display text-[10px] tracking-widest"
            style={
              zipOn
                ? {
                    color: "var(--neon)",
                    borderColor: "color-mix(in oklab, var(--neon) 60%, var(--border))",
                    boxShadow: "0 0 10px -2px color-mix(in oklab, var(--neon) 60%, transparent)",
                  }
                : { color: "var(--muted-foreground)", borderColor: "var(--border)" }
            }
          >
            ZIP
          </button>
          {/* Recenter on my location — and re-arm follow-my-dot after a browse */}
          {me && !drawingNow && (
            <button
              type="button"
              aria-label="Center map on my location"
              onClick={() => {
                const m = mapRef.current;
                if (!m) return;
                setTracking(true);
                m.setView([me.lat, me.lng], Math.max(m.getZoom(), 17), { animate: true });
              }}
              className="flex h-11 w-11 items-center justify-center rounded-full border bg-surface/90 backdrop-blur"
              style={
                follow && tracking
                  ? {
                      color: "#00e5ff",
                      borderColor: "#00e5ff99",
                      boxShadow: "0 0 10px -2px #00e5ff",
                    }
                  : {
                      color: "var(--neon)",
                      borderColor: "color-mix(in oklab, var(--neon) 60%, var(--border))",
                    }
              }
            >
              <LocateFixed className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Screen-owned floating controls — inside the frame so they follow
          the map into fullscreen. */}
        {overlay}
      </div>
    </>
  );
}

type NeonMapProps = Parameters<typeof NeonMapInner>[0];

/** A layer throw (a bad polygon, a plugin edge case) must cost the map, not
 *  the whole route — without this the router's root "Connection Lost" screen
 *  swallowed the page. Retry remounts a fresh MapContainer. */
class MapCrashBoundary extends Component<
  { height: number | string; children: ReactNode },
  { crashed: boolean; attempt: number }
> {
  state = { crashed: false, attempt: 0 };
  static getDerivedStateFromError() {
    return { crashed: true };
  }
  componentDidCatch(err: unknown) {
    console.error("[NeonMap] map crashed", err);
  }
  render() {
    if (this.state.crashed) {
      const h = this.props.height;
      return (
        <div
          className="flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-surface/60"
          style={{ height: typeof h === "number" ? `min(${h}px, 65vh)` : h }}
        >
          <div className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
            The map hit a snag
          </div>
          <button
            type="button"
            onClick={() => this.setState((s) => ({ crashed: false, attempt: s.attempt + 1 }))}
            className="min-h-11 rounded border border-neon/60 bg-surface px-4 font-display text-[10px] uppercase tracking-widest text-neon"
          >
            Reload map
          </button>
        </div>
      );
    }
    // Keyed Fragment, NOT a display:contents div — an extra wrapper element
    // around the map broke leaflet-rotate's gesture math (rotate flung the
    // panes thousands of px off-screen: the "map went black" report).
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}

export function NeonMap(props: NeonMapProps) {
  return (
    <MapCrashBoundary height={props.height ?? 480}>
      <NeonMapInner {...props} />
    </MapCrashBoundary>
  );
}
