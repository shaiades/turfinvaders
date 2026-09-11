import { useEffect, useMemo, useRef, useState } from "react";
import { Marker, useMap } from "react-leaflet";
import L from "leaflet";
import { PIN_COLORS, type PinType } from "@/lib/pin-results";
import type { FieldPin } from "@/components/NeonMap";

/**
 * A bubble over every house (owner ask 2026-09-10, D2DU-video parity). House
 * locations are OpenStreetMap building centroids streamed from Overpass at
 * street zoom — keyless and CORS-open. Un-worked houses wear a neutral ring;
 * a house whose door was logged today wears its result's color. Tapping a
 * bubble hands the house (plus its current pin, if any) to the page, which
 * opens the one-tap result sheet.
 *
 * OSM has no homeowner identities (the video app licenses that data), so the
 * under-bubble label is the house number where OSM knows it.
 */

/** Bubbles only make sense at door-to-door zoom. */
export const HOUSE_MIN_ZOOM = 17;
const NUMBER_MIN_ZOOM = 18;
/** A pin belongs to a house when it landed within this many meters of the
 *  building centroid (GPS-at-the-door vs roof-center offset). */
const MATCH_METERS = 14;

export type OsmHouse = {
  id: number;
  lat: number;
  lng: number;
  /** OSM addr:housenumber when mapped; "" otherwise. */
  num: string;
  /** Today's latest valid pin on this house (set by the matcher at tap time). */
  currentPinId?: string;
  currentType?: PinType;
};

// Outbuildings that shouldn't get a knock bubble.
const EXCLUDED_BUILDINGS = new Set([
  "garage",
  "garages",
  "shed",
  "carport",
  "roof",
  "greenhouse",
  "hut",
  "kiosk",
  "service",
  "ruins",
]);

// Public Overpass endpoints, tried in order. After both fail we go quiet for
// a minute — a field crew must never turn into a retry storm.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const FAIL_COOLDOWN_MS = 60_000;

// Session caches (module scope — shared across remounts).
const houseCache = new Map<number, OsmHouse>();
const coveredBounds: L.LatLngBounds[] = [];
const MAX_COVERED = 40;
let lastFailAt = 0;

async function fetchHouses(bounds: L.LatLngBounds, signal: AbortSignal) {
  const bbox = [
    bounds.getSouth().toFixed(5),
    bounds.getWest().toFixed(5),
    bounds.getNorth().toFixed(5),
    bounds.getEast().toFixed(5),
  ].join(",");
  const query = `[out:json][timeout:8];way[building](${bbox});out center tags 600;`;
  let lastErr: unknown = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        signal,
      });
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      const data = (await res.json()) as {
        elements?: Array<{
          type: string;
          id: number;
          center?: { lat: number; lon: number };
          tags?: Record<string, string>;
        }>;
      };
      for (const el of data.elements ?? []) {
        if (el.type !== "way" || !el.center) continue;
        const kind = (el.tags?.building ?? "yes").toLowerCase();
        if (EXCLUDED_BUILDINGS.has(kind)) continue;
        if (el.tags?.["building:part"]) continue;
        if (!houseCache.has(el.id)) {
          houseCache.set(el.id, {
            id: el.id,
            lat: el.center.lat,
            lng: el.center.lon,
            num: el.tags?.["addr:housenumber"] ?? "",
          });
        }
      }
      coveredBounds.push(bounds);
      if (coveredBounds.length > MAX_COVERED) coveredBounds.shift();
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      lastErr = e;
    }
  }
  lastFailAt = Date.now();
  throw lastErr instanceof Error ? lastErr : new Error("overpass unavailable");
}

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Bubble divIcons cached by look (same rationale as NeonMap's icon cache:
// stable identity across the GPS-tick re-renders).
const bubbleIconCache = new Map<string, L.DivIcon>();
function bubbleIcon(opts: { color: string | null; num: string; showNum: boolean; hit: number }) {
  const { color, num, showNum, hit } = opts;
  const key = `${color ?? "none"}|${showNum ? num : ""}|${hit}`;
  let icon = bubbleIconCache.get(key);
  if (!icon) {
    const ring = color
      ? `border:3px solid ${color};box-shadow:0 0 12px ${color},inset 0 0 8px color-mix(in srgb, ${color} 45%, transparent);background:color-mix(in srgb, ${color} 18%, transparent);`
      : `border:2px solid rgba(255,255,255,0.72);background:rgba(10,14,24,0.28);box-shadow:0 0 6px rgba(0,0,0,0.5);`;
    const label =
      showNum && num
        ? `<div style="margin-top:1px;color:#fff;font:700 9px/1 ui-sans-serif,system-ui;text-shadow:0 0 4px #000,0 1px 2px #000;letter-spacing:0.04em;">${num.replace(/[<>&"']/g, "")}</div>`
        : "";
    const html = `
    <div style="width:${hit}px;display:flex;flex-direction:column;align-items:center;">
      <div style="width:${hit}px;height:${hit}px;display:flex;align-items:center;justify-content:center;">
        <div style="width:26px;height:26px;border-radius:9999px;${ring}"></div>
      </div>
      ${label}
    </div>`;
    icon = L.divIcon({
      html,
      className: "house-bubble",
      iconSize: [hit, hit],
      iconAnchor: [hit / 2, hit / 2],
    });
    bubbleIconCache.set(key, icon);
  }
  return icon;
}

export function HouseBubblesLayer({
  enabled,
  pins = [],
  onHouseTap,
}: {
  enabled: boolean;
  /** Today's pins — they color the bubbles of the houses they landed on. */
  pins?: FieldPin[];
  onHouseTap?: (house: OsmHouse) => void;
}) {
  const map = useMap();
  const [renderTick, setRenderTick] = useState(0);
  const [view, setView] = useState<{ bounds: L.LatLngBounds; zoom: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);
  const tapRef = useRef(onHouseTap);
  tapRef.current = onHouseTap;

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      const zoom = map.getZoom();
      setView({ bounds: map.getBounds(), zoom });
      if (zoom < HOUSE_MIN_ZOOM) return;
      if (Date.now() - lastFailAt < FAIL_COOLDOWN_MS) return;
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(async () => {
        const want = map.getBounds().pad(0.4);
        if (coveredBounds.some((b) => b.contains(want))) return;
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        try {
          await fetchHouses(want, ac.signal);
          setRenderTick((t) => t + 1);
        } catch (e) {
          if (!(e instanceof DOMException && e.name === "AbortError")) {
            // Stay silent on the map — bubbles simply don't appear; taps on
            // the bare map (armed result) keep working exactly as before.
            console.warn("[house-bubbles] fetch failed", e);
          }
        }
      }, 400);
    };
    refresh();
    map.on("moveend", refresh);
    map.on("zoomend", refresh);
    return () => {
      map.off("moveend", refresh);
      map.off("zoomend", refresh);
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, [map, enabled]);

  const visible = useMemo(() => {
    void renderTick;
    if (!enabled || !view || view.zoom < HOUSE_MIN_ZOOM) return [];
    const frame = view.bounds.pad(0.08);
    const out: OsmHouse[] = [];
    for (const h of houseCache.values()) {
      if (frame.contains([h.lat, h.lng])) out.push(h);
      if (out.length >= 300) break;
    }
    return out;
  }, [enabled, view, renderTick]);

  // Latest valid pin per house — the bubble wears that result's color. Remote
  // drops stay off bubbles (they're stat-dead and already flagged on the map).
  const resultByHouse = useMemo(() => {
    const match = new Map<number, { pin: FieldPin; at: string }>();
    if (visible.length === 0) return match;
    const latWindow = MATCH_METERS / 111_000;
    for (const p of pins) {
      if (p.is_remote_drop || p.pending) continue;
      let best: OsmHouse | null = null;
      let bestD = MATCH_METERS;
      for (const h of visible) {
        if (Math.abs(h.lat - p.lat) > latWindow * 1.5) continue;
        const d = haversineM(h.lat, h.lng, p.lat, p.lng);
        if (d <= bestD) {
          bestD = d;
          best = h;
        }
      }
      if (!best) continue;
      const prev = match.get(best.id);
      const at = p.created_at ?? "";
      if (!prev || at >= prev.at) match.set(best.id, { pin: p, at });
    }
    return match;
  }, [visible, pins]);

  if (visible.length === 0) return null;
  const showNum = (view?.zoom ?? 0) >= NUMBER_MIN_ZOOM;
  const tappable = !!onHouseTap;
  return (
    <>
      {visible.map((h) => {
        const hit = tappable ? 40 : 30;
        const matched = resultByHouse.get(h.id);
        const color = matched ? PIN_COLORS[matched.pin.pin_type] : null;
        return (
          <Marker
            key={h.id}
            position={[h.lat, h.lng]}
            icon={bubbleIcon({ color, num: h.num, showNum, hit })}
            interactive={tappable}
            // Bubbles sit UNDER result pins/the me-dot — a bubble must never
            // steal the tap meant for a pin correction dead-center on it.
            zIndexOffset={-800}
            eventHandlers={
              tappable
                ? {
                    click: () =>
                      tapRef.current?.({
                        ...h,
                        currentPinId: matched?.pin.id,
                        currentType: matched?.pin.pin_type,
                      }),
                  }
                : undefined
            }
          />
        );
      })}
    </>
  );
}
