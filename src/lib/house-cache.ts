import type { PinType } from "./pin-results";

/**
 * The house-bubble cache engine: OSM element ingest (buildings + county
 * address points), the building↔address dedupe rules, the proximity grid,
 * and tap snapping. Extracted from HouseBubbles.tsx (2026-09-15) so the
 * geometry is pure and headless-verifiable via scripts/verify-house-snap.ts —
 * no leaflet/react in this module graph (pin-results precedent). The Overpass
 * fetch pipeline and all rendering stay in HouseBubbles.tsx.
 */

export type OsmHouse = {
  /** Namespaced OSM id ("w…"/"r…"/"n…") — ways, relations, and nodes have
   *  SEPARATE id spaces; un-namespaced numbers silently merge houses. */
  id: string;
  lat: number;
  lng: number;
  /** Stable [lat, lng] tuple minted once at ingest — react-leaflet compares
   *  position by identity, so a fresh array per render would setLatLng every
   *  GPS tick for every bubble. */
  pos: [number, number];
  /** OSM addr:housenumber when mapped; "" otherwise. */
  num: string;
  /** OSM addr:street when mapped; "" otherwise — with num it makes the
   *  address the result sheet shows (rep ask 2026-09-15). Same tags payload
   *  we already download; keeping it costs nothing. */
  street: string;
  /** OSM addr:postcode when mapped; "" otherwise. The office's Address
   *  question asks for "street address followed by zip code" — the zip
   *  completes the copy/prefill string in exactly that format. */
  zip: string;
  kind: "building" | "addr";
  /** Today's latest valid pin on this house (set by the matcher at tap time). */
  currentPinId?: string;
  currentType?: PinType;
};

/** The pin shape snapping needs — structurally satisfied by NeonMap's
 *  FieldPin without importing the leaflet module graph. */
export type SnapPin = {
  id: string;
  pin_type: PinType;
  lat: number;
  lng: number;
  is_remote_drop?: boolean;
  pending?: boolean;
  created_at?: string;
};

/** A pin belongs to a house when it landed within this many meters of the
 *  building centroid (GPS-at-the-door vs roof-center offset). */
export const MATCH_METERS = 14;
/** An address point within this many meters of a building centroid is the
 *  same home. Deliberately small: SoCal lots run 15-18 m wide, so a bigger
 *  radius would eat the address point of a REAL unmapped home next door —
 *  the exact gap this feature closes. Too-small cost: an occasional second
 *  ring on one large roof (cosmetic; either circle logs the same door). */
export const DEDUPE_METERS = 12;
/** A mixed-tagged multipolygon (building=* on BOTH the relation and its
 *  outer way) yields two bbox centers ~0-2 m apart — merge only that tight
 *  radius, or a pure-relation home next to a townhome WAY gets eaten. */
export const REL_WAY_MERGE_METERS = 3;

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
  "no", // building=no explicitly marks "not a building"
]);

// Address NODES carrying these keys are POIs that happen to have an address
// (a shop, a clinic, a gym), not homes; county address-point imports carry
// only addr:* keys.
const POI_KEYS = [
  "shop",
  "amenity",
  "office",
  "craft",
  "tourism",
  "leisure",
  "healthcare",
  "emergency",
  "historic",
  "man_made",
] as const;

// Session cache (module scope — shared across remounts).
export const houseCache = new Map<string, OsmHouse>();

export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Tiny grid index over the cache so building↔address dedupe stays O(1) per
// ingest instead of scanning the whole session cache. Cell ≈ 28 m ≥
// DEDUPE_METERS (and MATCH_METERS), so a 3×3 neighborhood always covers the
// radius.
const CELL_DEG = 0.00025;
const grid = new Map<string, Set<string>>();
const cellOf = (lat: number, lng: number) =>
  `${Math.round(lat / CELL_DEG)}:${Math.round(lng / CELL_DEG)}`;
function gridAdd(h: OsmHouse) {
  const k = cellOf(h.lat, h.lng);
  let s = grid.get(k);
  if (!s) grid.set(k, (s = new Set()));
  s.add(h.id);
}
function gridDelete(h: OsmHouse) {
  grid.get(cellOf(h.lat, h.lng))?.delete(h.id);
}
function nearestWithin(
  lat: number,
  lng: number,
  kind: OsmHouse["kind"],
  maxM: number,
): OsmHouse | null {
  const ci = Math.round(lat / CELL_DEG);
  const cj = Math.round(lng / CELL_DEG);
  let best: OsmHouse | null = null;
  let bestD = maxM;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const s = grid.get(`${ci + di}:${cj + dj}`);
      if (!s) continue;
      for (const id of s) {
        const h = houseCache.get(id);
        if (!h || h.kind !== kind) continue;
        const d = haversineM(lat, lng, h.lat, h.lng);
        if (d <= bestD) {
          bestD = d;
          best = h;
        }
      }
    }
  }
  return best;
}

/** Nearest cached house of EITHER kind within maxM, or null. */
function nearestAny(lat: number, lng: number, maxM: number): OsmHouse | null {
  const b = nearestWithin(lat, lng, "building", maxM);
  const a = nearestWithin(lat, lng, "addr", maxM);
  if (!b) return a;
  if (!a) return b;
  return haversineM(lat, lng, b.lat, b.lng) <= haversineM(lat, lng, a.lat, a.lng) ? b : a;
}

export type OverpassElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

export function ingestBuilding(el: OverpassElement) {
  if (!el.center) return;
  const id = `${el.type[0]}${el.id}`;
  if (houseCache.has(id)) return;
  const kind = (el.tags?.building ?? "yes").toLowerCase();
  if (EXCLUDED_BUILDINGS.has(kind)) return;
  if (el.tags?.["building:part"]) return;
  const { lat, lon: lng } = el.center;
  const h: OsmHouse = {
    id,
    lat,
    lng,
    pos: [lat, lng],
    num: el.tags?.["addr:housenumber"] ?? "",
    street: el.tags?.["addr:street"] ?? "",
    zip: el.tags?.["addr:postcode"] ?? "",
    kind: "building",
  };
  // Mixed-tagging double: a minority of multipolygons carry building=* on
  // BOTH the relation and its outer way. Dedupe ONLY rel↔way pairs — never
  // way↔way, since townhome centroids sit closer than any safe radius. The
  // way wins: its centroid is the true polygon centroid vs the relation's
  // bbox center.
  const twinB = nearestWithin(lat, lng, "building", REL_WAY_MERGE_METERS);
  if (twinB && twinB.id[0] !== id[0]) {
    if (id[0] === "w") {
      // Incoming way replaces the cached relation.
      if (!h.num && twinB.num) h.num = twinB.num;
      if (!h.street && twinB.street) h.street = twinB.street;
      if (!h.zip && twinB.zip) h.zip = twinB.zip;
      houseCache.delete(twinB.id);
      gridDelete(twinB);
    } else {
      // Incoming relation defers to the cached way.
      if (!twinB.num && h.num) twinB.num = h.num;
      if (!twinB.street && h.street) twinB.street = h.street;
      if (!twinB.zip && h.zip) twinB.zip = h.zip;
      return;
    }
  }
  // A footprint supersedes an address point on the same roof (quadrant
  // fetches make arrival order unpredictable, so dedupe runs both ways) —
  // UNLESS they carry different housenumbers: on sub-15 m beach/zero-lot
  // tracts, a real unmapped neighbor's point can sit under 12 m from the
  // adjacent footprint's centroid, and that home keeps its own circle.
  const twin = nearestWithin(lat, lng, "addr", DEDUPE_METERS);
  if (twin && (!twin.num || !h.num || twin.num === h.num)) {
    if (!h.num && twin.num) h.num = twin.num;
    if (!h.street && twin.street) h.street = twin.street;
    if (!h.zip && twin.zip) h.zip = twin.zip;
    houseCache.delete(twin.id);
    gridDelete(twin);
  }
  houseCache.set(id, h);
  gridAdd(h);
}

export function ingestAddrNode(el: OverpassElement) {
  if (el.lat == null || el.lon == null) return;
  const id = `n${el.id}`;
  if (houseCache.has(id)) return;
  const tags = el.tags ?? {};
  if (POI_KEYS.some((k) => tags[k])) return;
  // An entrance node is by definition a vertex of a mapped building — its
  // home already has a footprint bubble. Skipping it kills the most common
  // "two circles on one roof" twin at the source.
  if (tags.entrance) return;
  // Unit-level points (multifamily imports): a big apartment roof would
  // sprout dozens of always-labeled circles and eat the node budget.
  if (tags["addr:unit"]) return;
  const { lat, lon: lng } = el;
  const num = tags["addr:housenumber"] ?? "";
  const street = tags["addr:street"] ?? "";
  const zip = tags["addr:postcode"] ?? "";
  const roof = nearestWithin(lat, lng, "building", DEDUPE_METERS);
  // Same home unless the numbers disagree — a differing number under 12 m
  // is a real neighbor on a tiny lot, exactly the home this feature covers.
  if (roof && (!roof.num || !num || roof.num === num)) {
    // The node's number (and street/zip) is a free label for the footprint.
    if (!roof.num && num) roof.num = num;
    if (!roof.street && street) roof.street = street;
    if (!roof.zip && zip) roof.zip = zip;
    return;
  }
  const h: OsmHouse = {
    id,
    lat,
    lng,
    pos: [lat, lng],
    num,
    street,
    zip,
    kind: "addr",
  };
  houseCache.set(id, h);
  gridAdd(h);
}

/**
 * The mis-tap fix (rep feedback 2026-09-15: "if I don't click it perfectly
 * on the circle it automatically puts not home"): a map tap within maxM of a
 * cached house is a tap AT that house — the caller opens the one-tap result
 * sheet instead of insta-dropping the armed result. maxM defaults to
 * MATCH_METERS on purpose: a pin dropped inside that radius would color this
 * house's bubble anyway, so the sheet only makes the same outcome deliberate.
 * Returns a copy carrying today's latest valid pin (the bubble-coloring
 * rule: non-remote, non-pending, and not owned by a nearer house), or null
 * when nothing is close enough — the armed free-roam drop stays for the
 * bubble-less rural/new-build case it was built for.
 */
export function snapTapToHouse(
  lat: number,
  lng: number,
  pins: SnapPin[],
  maxM = MATCH_METERS,
): OsmHouse | null {
  const house = nearestAny(lat, lng, maxM);
  if (!house) return null;
  let best: SnapPin | null = null;
  let bestAt = "";
  for (const p of pins) {
    if (p.is_remote_drop || p.pending) continue;
    if (haversineM(house.lat, house.lng, p.lat, p.lng) > MATCH_METERS) continue;
    // A pin belongs to its NEAREST house — never adopt a neighbor's pin just
    // because it also sits within range of ours (same rule as the bubble
    // coloring matcher in HouseBubbles).
    const owner = nearestAny(p.lat, p.lng, MATCH_METERS);
    if (owner && owner.id !== house.id) continue;
    const at = p.created_at ?? "";
    if (!best || at >= bestAt) {
      best = p;
      bestAt = at;
    }
  }
  return best ? { ...house, currentPinId: best.id, currentType: best.pin_type } : { ...house };
}

/** Test hook (verify-house-snap): wipe the session cache between cases. */
export function resetHouseCache() {
  houseCache.clear();
  grid.clear();
}
