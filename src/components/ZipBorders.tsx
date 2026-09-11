import { useEffect, useMemo, useRef, useState } from "react";
import { Marker, Polygon, useMap } from "react-leaflet";
import L from "leaflet";
import { viewBounds } from "@/lib/map-bounds";

/**
 * ZIP-code borders overlay (owner ask 2026-09-10: "put borders around each
 * zip code", SalesRabbit parity). Boundaries are 2020 Census ZCTAs streamed
 * straight from the Census Bureau's public TIGERweb ArcGIS service — keyless,
 * CORS-open, and generalized server-side via maxAllowableOffset so a phone
 * never parses full-resolution TIGER rings. Everything is non-interactive:
 * pin taps must pass through to the map exactly as before.
 *
 * Fetching is viewport-driven (moveend, debounced) with two detail tiers —
 * coarse while the map shows a city, near-lossless once zoomed to streets —
 * and a session-long module cache so re-panning a worked area costs nothing.
 */

const ZCTA_QUERY_URL =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1/query";

/** Below this zoom a viewport covers hundreds of ZCTAs — skip (and say so via
 *  the toggle's title). Canvassers live at 15+, so this only gates county view. */
export const ZIP_MIN_ZOOM = 10;
/** Labels join once individual zips are comfortably bigger than their pill. */
const LABEL_MIN_ZOOM = 12;
/** Street-level detail tier starts here. */
const FINE_ZOOM = 14;

type Tier = "coarse" | "fine";
const TIER_OFFSET: Record<Tier, number> = {
  coarse: 0.0008, // ~2px at z12 — city overview
  fine: 0.00004, // ~4m — indistinguishable from full TIGER at street zooms
};
const tierForZoom = (z: number): Tier => (z >= FINE_ZOOM ? "fine" : "coarse");

type Ring = Array<[number, number]>; // [lat, lng]
type ZipFeature = {
  zip: string;
  /** MultiPolygon-shaped: polygons → rings (outer first, then holes). */
  polys: Ring[][];
  bounds: L.LatLngBounds;
  labelAt: [number, number];
};

// Session caches (module scope — survive map remounts, shared across pages).
const featuresByTier: Record<Tier, Map<string, ZipFeature>> = {
  coarse: new Map(),
  fine: new Map(),
};
const coveredByTier: Record<Tier, L.LatLngBounds[]> = { coarse: [], fine: [] };
const MAX_COVERED = 30;

function ringCentroid(ring: Ring): [number, number] {
  let area = 0,
    cLat = 0,
    cLng = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][1] * ring[i][0] - ring[i][1] * ring[j][0];
    area += cross;
    cLat += (ring[j][0] + ring[i][0]) * cross;
    cLng += (ring[j][1] + ring[i][1]) * cross;
  }
  if (area === 0) return ring[0];
  return [cLat / (3 * area), cLng / (3 * area)];
}

/** GeoJSON coordinates ([lng,lat]) → our [lat,lng] rings. */
function toRings(coords: number[][][]): Ring[] {
  return coords.map((ring) => ring.map(([lng, lat]) => [lat, lng] as [number, number]));
}

function parseFeature(f: {
  properties?: Record<string, unknown>;
  geometry?: { type?: string; coordinates?: unknown };
}): ZipFeature | null {
  const zip = String(f.properties?.ZCTA5 ?? f.properties?.GEOID ?? "");
  if (!/^\d{5}$/.test(zip)) return null;
  const g = f.geometry;
  let polys: Ring[][];
  if (g?.type === "Polygon") {
    polys = [toRings(g.coordinates as number[][][])];
  } else if (g?.type === "MultiPolygon") {
    polys = (g.coordinates as number[][][][]).map(toRings);
  } else {
    return null;
  }
  const bounds = L.latLngBounds([]);
  for (const poly of polys) for (const p of poly[0] ?? []) bounds.extend(p);
  if (!bounds.isValid()) return null;
  // Label on the biggest outer ring's centroid (coastal zips are multipart;
  // bbox centers land in the ocean).
  let biggest: Ring | null = null;
  let biggestArea = 0;
  for (const poly of polys) {
    const outer = poly[0];
    if (!outer || outer.length < 3) continue;
    const b = L.latLngBounds(outer);
    const area = (b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest());
    if (area > biggestArea) {
      biggestArea = area;
      biggest = outer;
    }
  }
  if (!biggest) return null;
  return { zip, polys, bounds, labelAt: ringCentroid(biggest) };
}

/** ZIP → captain tint: polygon fill/stroke color + the name on the pill. */
export type ZipTint = { color: string; label: string };

// One shared divIcon per zip+tint (same cache rationale as NeonMap's icons:
// stable identity across GPS-tick re-renders).
const labelIconCache = new Map<string, L.DivIcon>();
function zipLabelIcon(zip: string, tint?: ZipTint): L.DivIcon {
  const key = tint ? `${zip}|${tint.color}|${tint.label}` : zip;
  let icon = labelIconCache.get(key);
  if (!icon) {
    const safeLabel = tint?.label?.replace(/[<>&"']/g, "") ?? "";
    const html = tint
      ? `<div style="transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:1px;background:rgba(11,15,26,0.8);border:1px solid ${tint.color};padding:3px 7px;border-radius:6px;white-space:nowrap;box-shadow:0 0 10px color-mix(in srgb, ${tint.color} 45%, transparent);">
           <span style="color:rgba(232,244,255,0.95);font:700 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0.08em;">${zip}</span>
           <span style="color:${tint.color};font:700 9px/1 ui-sans-serif,system-ui;letter-spacing:0.04em;">${safeLabel}</span>
         </div>`
      : `<div style="transform:translate(-50%,-50%);display:inline-block;background:rgba(11,15,26,0.72);border:1px solid rgba(232,244,255,0.45);color:rgba(232,244,255,0.92);font:700 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0.08em;padding:2px 6px;border-radius:4px;white-space:nowrap;">${zip}</div>`;
    icon = L.divIcon({
      html,
      className: "zip-border-label",
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    labelIconCache.set(key, icon);
  }
  return icon;
}

async function fetchZctas(bounds: L.LatLngBounds, tier: Tier, signal: AbortSignal) {
  const params = new URLSearchParams({
    where: "1=1",
    geometry: [
      bounds.getWest().toFixed(5),
      bounds.getSouth().toFixed(5),
      bounds.getEast().toFixed(5),
      bounds.getNorth().toFixed(5),
    ].join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "ZCTA5",
    returnGeometry: "true",
    geometryPrecision: "5",
    maxAllowableOffset: String(TIER_OFFSET[tier]),
    f: "geojson",
  });
  const res = await fetch(`${ZCTA_QUERY_URL}?${params}`, { signal });
  if (!res.ok) throw new Error(`ZCTA query ${res.status}`);
  const data = (await res.json()) as {
    features?: Array<{ properties?: Record<string, unknown>; geometry?: { type?: string } }>;
  };
  const cache = featuresByTier[tier];
  for (const raw of data.features ?? []) {
    const feat = parseFeature(raw as Parameters<typeof parseFeature>[0]);
    if (feat && !cache.has(feat.zip)) cache.set(feat.zip, feat);
  }
  const covered = coveredByTier[tier];
  covered.push(bounds);
  if (covered.length > MAX_COVERED) covered.shift();
}

export function ZipBordersLayer({
  enabled,
  tints,
  onZipTap,
}: {
  enabled: boolean;
  /** Assigned ZIPs: captain color + name pill (zip_assignments). */
  tints?: Record<string, ZipTint>;
  /** Admin assign mode: every visible ZIP becomes tappable. */
  onZipTap?: (zip: string) => void;
}) {
  const map = useMap();
  const tapRef = useRef(onZipTap);
  tapRef.current = onZipTap;
  // Bumped after every fetch/move so the visible-feature memo re-reads the
  // module cache; the cache itself is not React state on purpose (large).
  const [renderTick, setRenderTick] = useState(0);
  const [view, setView] = useState<{ bounds: L.LatLngBounds; zoom: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      const zoom = map.getZoom();
      setView({ bounds: viewBounds(map), zoom });
      if (zoom < ZIP_MIN_ZOOM) return;
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(async () => {
        const tier = tierForZoom(map.getZoom());
        const want = viewBounds(map).pad(0.3);
        if (coveredByTier[tier].some((b) => b.contains(want))) return;
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        try {
          await fetchZctas(want, tier, ac.signal);
          setRenderTick((t) => t + 1);
        } catch (e) {
          // Aborts are routine (fast panning); real failures stay silent on
          // the map — borders simply don't draw until the next pan retries.
          if (!(e instanceof DOMException && e.name === "AbortError")) {
            console.warn("[zip-borders] fetch failed", e);
          }
        }
      }, 350);
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
    if (!enabled || !view || view.zoom < ZIP_MIN_ZOOM) return [];
    const tier = tierForZoom(view.zoom);
    const frame = view.bounds.pad(0.1);
    const out: ZipFeature[] = [];
    for (const f of featuresByTier[tier].values()) {
      if (frame.intersects(f.bounds)) out.push(f);
      if (out.length >= 400) break; // hard cap — deep zoom-outs stay smooth
    }
    return out;
  }, [enabled, view, renderTick]);

  if (visible.length === 0) return null;
  const zoom = view?.zoom ?? 0;
  const tappable = !!onZipTap;
  return (
    <>
      {/* Default panes on purpose: leaflet-rotate only rotates the built-in
          panes (custom panes hang off the un-rotated map pane and render
          displaced the moment the map spins — found 2026-09-11). Zips stay
          visually beneath turfs by weight, not z: thin light strokes vs the
          turfs' bold filled polygons; labels ride the marker pane with a
          negative zIndexOffset so pins and assignee pills stay on top. */}
      <>
        {visible.map((f) => {
          const tint = tints?.[f.zip];
          return (
            <Polygon
              // Interactivity and style bake into the layer at creation —
              // key by them so entering assign mode rebuilds the paths.
              key={`${f.zip}|${tint ? tint.color : "plain"}|${tappable ? "tap" : "inert"}`}
              positions={f.polys}
              interactive={tappable}
              eventHandlers={tappable ? { click: () => tapRef.current?.(f.zip) } : undefined}
              pathOptions={
                tint
                  ? {
                      color: tint.color,
                      weight: 2,
                      opacity: 0.9,
                      // A captain's zone reads as a wash of their color.
                      fill: true,
                      fillColor: tint.color,
                      fillOpacity: tappable ? 0.16 : 0.1,
                      interactive: tappable,
                    }
                  : {
                      color: "#e8f4ff",
                      weight: 1.5,
                      opacity: 0.55,
                      // fill:false paths only hit-test on the stroke — assign
                      // mode needs the interior tappable, so give unassigned
                      // ZIPs a whisper of fill while assigning.
                      fill: tappable,
                      fillColor: "#e8f4ff",
                      fillOpacity: tappable ? 0.05 : 0,
                      interactive: tappable,
                    }
              }
            />
          );
        })}
      </>
      <>
        {visible.map((f) => {
          const tint = tints?.[f.zip];
          // Assigned ZIPs keep their captain pill at every layer zoom (the
          // county view IS the assignment overview); plain zips label at 12+.
          if (!tint && zoom < LABEL_MIN_ZOOM) return null;
          return (
            <Marker
              key={`${f.zip}-label${tint ? `|${tint.color}|${tint.label}` : ""}`}
              position={f.labelAt}
              icon={zipLabelIcon(f.zip, tint)}
              interactive={false}
              zIndexOffset={-600}
            />
          );
        })}
      </>
    </>
  );
}
