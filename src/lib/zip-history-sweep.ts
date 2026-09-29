import { supabase } from "@/integrations/supabase/client";
import { withTimeout } from "@/lib/abort-timeout";
import type { LatLng } from "@/components/NeonMap";

/**
 * ZIP → historical-coverage sweep (owner ask 2026-09-28: "when I assign a
 * zip code, all of the pre-assigned areas/historic areas get assigned to the
 * person I assigned the zip code to").
 *
 * Handing a ZIP to a captain can also promote every RepCard 2026 history
 * ring inside that ZIP into a live turf assigned to them — the same
 * promote-and-retire semantics as the one-ring popup flow, batched. The
 * geometry test runs client-side against the Census ZCTA boundary (the same
 * TIGERweb service ZipBorders streams), so no SQL or PostGIS is involved.
 */

export type RepcardHistoryRow = {
  // uuid PK — the stable key for promote/delete (repcard_area_id is nullable).
  id: string;
  rep_name: string | null;
  team: string | null;
  color: string | null;
  assigned_at: string | null;
  polygon_coordinates: LatLng[];
};

/** Every history row, paged past PostgREST's 1000-row cap. Shared by the
 *  My Territory map layer and the sweep (via the same React Query key, so
 *  one session fetches the 2,700 rows at most once). */
export async function fetchAllRepcardTerritoryRows(): Promise<RepcardHistoryRow[]> {
  const PAGE = 1000;
  const rows: RepcardHistoryRow[] = [];
  for (let from = 0; from < 20000; from += PAGE) {
    const { data, error } = await supabase
      .from("repcard_territory_history")
      .select("id, rep_name, team, color, assigned_at, polygon_coordinates")
      .order("assigned_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as RepcardHistoryRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

type Ring = Array<[number, number]>; // [lat, lng]
/** MultiPolygon-shaped: polygons → rings (outer first, then holes). */
export type ZctaBoundary = Ring[][];

const ZCTA_QUERY_URL =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1/query";

// ~20 m generalization: plenty for a vertex-majority containment test, and it
// keeps a full ZCTA at hundreds of points instead of thousands.
const SWEEP_OFFSET = 0.0002;

// Session cache — dispatch mornings re-touch the same handful of ZIPs.
const boundaryCache = new Map<string, ZctaBoundary>();

function toRings(coords: number[][][]): Ring[] {
  return coords.map((ring) => ring.map(([lng, lat]) => [lat, lng] as [number, number]));
}

/** Fetch ZCTA boundaries for the given ZIPs (one round trip for the batch).
 *  A ZIP missing from the result had no boundary (bad ZIP, or the row was
 *  dropped server-side) — callers report those instead of silently skipping. */
export async function fetchZctaBoundaries(zips: string[]): Promise<Map<string, ZctaBoundary>> {
  const out = new Map<string, ZctaBoundary>();
  const need: string[] = [];
  for (const zip of [...new Set(zips)]) {
    const cached = boundaryCache.get(zip);
    if (cached) out.set(zip, cached);
    else if (/^\d{5}$/.test(zip)) need.push(zip);
  }
  if (need.length === 0) return out;
  const params = new URLSearchParams({
    where: `ZCTA5 IN (${need.map((z) => `'${z}'`).join(",")})`,
    inSR: "4326",
    outSR: "4326",
    outFields: "ZCTA5",
    returnGeometry: "true",
    geometryPrecision: "5",
    maxAllowableOffset: String(SWEEP_OFFSET),
    f: "geojson",
  });
  const res = await fetch(`${ZCTA_QUERY_URL}?${params}`, {
    signal: withTimeout(undefined, 12_000),
  });
  if (!res.ok) throw new Error(`ZIP boundary lookup failed (${res.status})`);
  const data = (await res.json()) as {
    features?: Array<{
      properties?: Record<string, unknown>;
      geometry?: { type?: string; coordinates?: unknown };
    }>;
  };
  for (const f of data.features ?? []) {
    const zip = String(f.properties?.ZCTA5 ?? f.properties?.GEOID ?? "");
    if (!/^\d{5}$/.test(zip)) continue;
    const g = f.geometry;
    let polys: ZctaBoundary;
    if (g?.type === "Polygon") polys = [toRings(g.coordinates as number[][][])];
    else if (g?.type === "MultiPolygon") polys = (g.coordinates as number[][][][]).map(toRings);
    else continue;
    boundaryCache.set(zip, polys);
    out.set(zip, polys);
  }
  return out;
}

/** Even-odd ray cast across every ring of the multipolygon — holes and
 *  multipart coastal ZCTAs fall out of the parity for free. */
function insideBoundary(lat: number, lng: number, polys: ZctaBoundary): boolean {
  let inside = false;
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [latI, lngI] = ring[i];
        const [latJ, lngJ] = ring[j];
        if (
          latI > lat !== latJ > lat &&
          lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI
        ) {
          inside = !inside;
        }
      }
    }
  }
  return inside;
}

type BBox = { s: number; n: number; w: number; e: number };

function boundaryBBox(polys: ZctaBoundary): BBox {
  const b: BBox = { s: 90, n: -90, w: 180, e: -180 };
  for (const poly of polys) {
    for (const [lat, lng] of poly[0] ?? []) {
      if (lat < b.s) b.s = lat;
      if (lat > b.n) b.n = lat;
      if (lng < b.w) b.w = lng;
      if (lng > b.e) b.e = lng;
    }
  }
  return b;
}

/** A ring belongs to the ZIP when MORE THAN HALF its vertices land inside —
 *  edge turfs that merely touch the boundary stay put, and a border-straddler
 *  goes to whichever side actually holds it. BBox prefilter first: 2,700
 *  county-wide rings vs one ZCTA must not cost 2,700 full casts. */
export function historyRowsInsideZip(
  rows: RepcardHistoryRow[],
  polys: ZctaBoundary,
): RepcardHistoryRow[] {
  const box = boundaryBBox(polys);
  const out: RepcardHistoryRow[] = [];
  for (const row of rows) {
    const pts = row.polygon_coordinates ?? [];
    if (pts.length < 3) continue;
    let touches = false;
    for (const p of pts) {
      if (p.lat >= box.s && p.lat <= box.n && p.lng >= box.w && p.lng <= box.e) {
        touches = true;
        break;
      }
    }
    if (!touches) continue;
    let inside = 0;
    for (const p of pts) {
      if (insideBoundary(p.lat, p.lng, polys)) inside++;
    }
    if (inside * 2 > pts.length) out.push(row);
  }
  return out;
}

/** Sweep matches for a batch of ZIPs. Each history row lands in at most one
 *  ZIP (first match wins — one call assigns everything to the same person, so
 *  the split only affects the per-ZIP turf naming). */
export function matchHistoryRowsToZips(
  rows: RepcardHistoryRow[],
  boundaries: Map<string, ZctaBoundary>,
): Array<{ zip: string; row: RepcardHistoryRow }> {
  const taken = new Set<string>();
  const out: Array<{ zip: string; row: RepcardHistoryRow }> = [];
  for (const [zip, polys] of boundaries) {
    for (const row of historyRowsInsideZip(rows, polys)) {
      if (taken.has(row.id)) continue;
      taken.add(row.id);
      out.push({ zip, row });
    }
  }
  return out;
}
