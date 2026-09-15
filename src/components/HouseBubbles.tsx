import { useEffect, useMemo, useRef, useState } from "react";
import { Marker, useMap } from "react-leaflet";
import L from "leaflet";
import { toast } from "sonner";
import { viewBounds } from "@/lib/map-bounds";
import { withTimeout } from "@/lib/abort-timeout";
import { PIN_COLORS, type PinType } from "@/lib/pin-results";
import type { FieldPin } from "@/components/NeonMap";

/**
 * A bubble over every home (owner ask 2026-09-10, widened 2026-09-14:
 * "every home on the map no matter what"). Two OSM sources, streamed from
 * Overpass at street zoom — keyless and CORS-open:
 *  - building footprints (ways AND multipolygon relations), centroid-placed;
 *  - addr:housenumber POINTS where no footprint is mapped (county address
 *    imports) — these sit where the county put them (driveway/parcel), and
 *    they always show their number: the number IS the house there.
 * Un-worked houses wear a neutral ring; a house whose door was logged today
 * wears its result's color. Tapping a bubble hands the house (plus its
 * current pin, if any) to the page, which opens the one-tap result sheet.
 *
 * Dense frames that would overflow one Overpass print are re-fetched as
 * quadrants (depth 1, sequential) so truncation never leaves arbitrary
 * mid-block holes; if a frame still overflows the render cap, the farthest
 * NEUTRAL bubbles from center yield first and worked bubbles never drop.
 *
 * OSM has no homeowner identities (the video app licenses that data), so the
 * under-bubble label is the house number where OSM knows it.
 */

/** Bubbles only make sense at door-to-door zoom — below it they'd overlap
 *  2-3 deep and nothing would be tappable. NeonMap shows a "zoom in" pill
 *  between z14 and here so a zoomed-out rep is never silently circle-less. */
export const HOUSE_MIN_ZOOM = 17;
const NUMBER_MIN_ZOOM = 18;
/** A pin belongs to a house when it landed within this many meters of the
 *  building centroid (GPS-at-the-door vs roof-center offset). */
const MATCH_METERS = 14;
/** An address point within this many meters of a building centroid is the
 *  same home. Deliberately small: SoCal lots run 15-18 m wide, so a bigger
 *  radius would eat the address point of a REAL unmapped home next door —
 *  the exact gap this feature closes. Too-small cost: an occasional second
 *  ring on one large roof (cosmetic; either circle logs the same door). */
const DEDUPE_METERS = 12;
/** A mixed-tagged multipolygon (building=* on BOTH the relation and its
 *  outer way) yields two bbox centers ~0-2 m apart — merge only that tight
 *  radius, or a pure-relation home next to a townhome WAY gets eaten. */
const REL_WAY_MERGE_METERS = 3;
/** DOM divIcon markers a mid-range field phone pans smoothly with. */
const RENDER_CAP = 300;

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
  kind: "building" | "addr";
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

// Public Overpass endpoints, tried in order. After both fail we go quiet for
// a minute — a field crew must never turn into a retry storm.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const FAIL_COOLDOWN_MS = 60_000;
// Per-request print budgets. A padded z17 frame in a dense SoCal tract holds
// ~1300-1500 roof polygons (garages included — they consume budget before the
// client filter drops them); 1800/900 covers it with headroom at ~150 B per
// element (≤ ~300 KB raw, tens of KB gzipped — fine on field LTE).
const BUILDING_CAP = 1800;
const NODE_CAP = 900;
// Sequential quadrant fetches are spaced — polite to the public endpoints.
const QUADRANT_SPACING_MS = 300;

// Session caches (module scope — shared across remounts).
const houseCache = new Map<string, OsmHouse>();
const coveredBounds: L.LatLngBounds[] = [];
const MAX_COVERED = 64; // splits add up to 5 rects per dense view
let lastFailAt = 0;
let failNoticeShown = false;

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

// Tiny grid index over the cache so building↔address dedupe stays O(1) per
// ingest instead of scanning the whole session cache. Cell ≈ 28 m ≥
// DEDUPE_METERS, so a 3×3 neighborhood always covers the radius.
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

type OverpassElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

function ingestBuilding(el: OverpassElement) {
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
      houseCache.delete(twinB.id);
      gridDelete(twinB);
    } else {
      // Incoming relation defers to the cached way.
      if (!twinB.num && h.num) twinB.num = h.num;
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
    houseCache.delete(twin.id);
    gridDelete(twin);
  }
  houseCache.set(id, h);
  gridAdd(h);
}

function ingestAddrNode(el: OverpassElement) {
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
  const roof = nearestWithin(lat, lng, "building", DEDUPE_METERS);
  // Same home unless the numbers disagree — a differing number under 12 m
  // is a real neighbor on a tiny lot, exactly the home this feature covers.
  if (roof && (!roof.num || !num || roof.num === num)) {
    // The node's number is a free label for the footprint.
    if (!roof.num && num) roof.num = num;
    return;
  }
  const h: OsmHouse = {
    id,
    lat,
    lng,
    pos: [lat, lng],
    num,
    kind: "addr",
  };
  houseCache.set(id, h);
  gridAdd(h);
}

/** One Overpass round trip; returns RAW per-class element counts (before
 *  client filters — filtered elements consumed print budget too, and the
 *  counts are how the caller detects truncation). */
async function overpassRequest(
  bounds: L.LatLngBounds,
  signal: AbortSignal,
): Promise<{ buildings: number; nodes: number }> {
  const bbox = [
    bounds.getSouth().toFixed(5),
    bounds.getWest().toFixed(5),
    bounds.getNorth().toFixed(5),
    bounds.getEast().toFixed(5),
  ].join(",");
  // Two prints: the union of building ways+relations, then address nodes
  // (the second statement reassigns the default set). GOTCHA: the node print
  // MUST be body verbosity (`out N`) — `out tags N` strips node lat/lon and
  // every address point silently vanishes. Ways/relations keep `tags center`
  // (no member arrays — small payload; a relation's center is its bbox
  // center, close enough for a multipolygon home).
  const query =
    `[out:json][timeout:8];` +
    `(way[building](${bbox});relation[building](${bbox}););out tags center ${BUILDING_CAP};` +
    `node["addr:housenumber"](${bbox});out ${NODE_CAP};`;
  let lastErr: unknown = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        // 10 s client deadline per endpoint. `[timeout:8]` is a server-side
        // hint that never covers a hung connection — before this, a stalled
        // primary blocked the mirror failover until the next pan's abort,
        // which read as "house circles never load". The deadline aborts as
        // TimeoutError, so the AbortError rethrow below (user pan) still
        // only matches real aborts and the mirror gets its turn.
        signal: withTimeout(signal, 10_000),
      });
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      const data = (await res.json()) as { elements?: OverpassElement[]; remark?: string };
      // Overpass can 200 a TIMED-OUT query: partial elements plus a
      // runtime-error remark, with per-class counts under the caps.
      // Counting that as complete would mark the rect covered and cache
      // mid-block holes for the whole session — treat it as this endpoint
      // failing (failover to the mirror, then the cooldown).
      if (data.remark && /runtime error|timed out/i.test(data.remark)) {
        throw new Error(`overpass partial: ${data.remark.slice(0, 120)}`);
      }
      let buildings = 0;
      let nodes = 0;
      for (const el of data.elements ?? []) {
        if (el.type === "way" || el.type === "relation") {
          buildings++;
          ingestBuilding(el);
        } else if (el.type === "node") {
          nodes++;
          ingestAddrNode(el);
        }
      }
      return { buildings, nodes };
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      lastErr = e;
    }
  }
  lastFailAt = Date.now();
  throw lastErr instanceof Error ? lastErr : new Error("overpass unavailable");
}

function pushCovered(bounds: L.LatLngBounds) {
  coveredBounds.push(bounds);
  if (coveredBounds.length > MAX_COVERED) coveredBounds.shift();
}

/** Fetch with truncation honesty: a print capped at N returns exactly N in
 *  database order — geographically arbitrary mid-block holes, the trust
 *  killer. A truncated fetch re-runs as 4 sequential quadrants (depth 1);
 *  the parent rect is recorded only after ALL quadrants land, keeping the
 *  covered-bounds `contains` gate sound. Quadrants consult coveredBounds
 *  themselves so a walking rep's restarted split reuses finished pieces. */
async function fetchHouses(
  bounds: L.LatLngBounds,
  signal: AbortSignal,
  onChunk: () => void,
  depth = 0,
): Promise<void> {
  if (depth > 0 && coveredBounds.some((b) => b.contains(bounds))) {
    onChunk();
    return;
  }
  const { buildings, nodes } = await overpassRequest(bounds, signal);
  const truncated = buildings >= BUILDING_CAP || nodes >= NODE_CAP;
  if (!truncated || depth >= 1) {
    if (truncated) {
      // Post-split quadrant still over budget ≈ >10k buildings/km² —
      // Manhattan, not a canvass turf. Accept and move on.
      console.warn("[house-bubbles] dense frame truncated after split");
    }
    pushCovered(bounds);
    onChunk();
    return;
  }
  onChunk(); // show the partial batch while the quadrants stream in
  const c = bounds.getCenter();
  const quads = [
    L.latLngBounds([bounds.getSouth(), bounds.getWest()], [c.lat, c.lng]),
    L.latLngBounds([bounds.getSouth(), c.lng], [c.lat, bounds.getEast()]),
    L.latLngBounds([c.lat, bounds.getWest()], [bounds.getNorth(), c.lng]),
    L.latLngBounds([c.lat, c.lng], [bounds.getNorth(), bounds.getEast()]),
  ];
  for (const q of quads) {
    await new Promise((r) => setTimeout(r, QUADRANT_SPACING_MS));
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    await fetchHouses(q, signal, onChunk, depth + 1);
  }
  pushCovered(bounds);
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
  const inflightRef = useRef<L.LatLngBounds | null>(null);
  const debounceRef = useRef<number | null>(null);
  const tapRef = useRef(onHouseTap);
  tapRef.current = onHouseTap;

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      const zoom = map.getZoom();
      setView({ bounds: viewBounds(map), zoom });
      if (zoom < HOUSE_MIN_ZOOM || Date.now() - lastFailAt < FAIL_COOLDOWN_MS) {
        // Clear any pending timer too — a fetch scheduled at street zoom
        // must not fire against a zoomed-out viewport (a giant bbox that
        // truncates past the split depth would poison coveredBounds).
        if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
        return;
      }
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(async () => {
        // Re-check at fire time — the rep may have zoomed out mid-debounce.
        if (map.getZoom() < HOUSE_MIN_ZOOM) return;
        const want = viewBounds(map).pad(0.4);
        if (coveredBounds.some((b) => b.contains(want))) return;
        // A walking rep's GPS-follow pans fire moveend every settle; if the
        // in-flight fetch (padded ~350 m beyond the frame) already covers
        // the shifted viewport, let it FINISH instead of aborting a nearly
        // done quadrant split over and over.
        if (abortRef.current && inflightRef.current?.contains(want)) return;
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        inflightRef.current = want;
        try {
          await fetchHouses(want, ac.signal, () => setRenderTick((t) => t + 1));
        } catch (e) {
          if (!(e instanceof DOMException && e.name === "AbortError")) {
            // Bubbles simply don't appear; armed bare-map taps keep working.
            // One honest sentence per session, canvass screen only (spectate
            // has no armed chips to point at).
            console.warn("[house-bubbles] fetch failed", e);
            if (!failNoticeShown && tapRef.current && map.getZoom() >= HOUSE_MIN_ZOOM) {
              failNoticeShown = true;
              toast.warning(
                "House circles can't load right now — arm a result and tap the house on the map to log it.",
                { id: "house-bubbles-offline", duration: 6000 },
              );
            }
          }
        } finally {
          // A finished (or failed) fetch is no longer in flight — a stale
          // ref here would make the contains-skip above block retries of
          // this area after a failure.
          if (abortRef.current === ac) {
            abortRef.current = null;
            inflightRef.current = null;
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

  const inFrame = useMemo(() => {
    void renderTick;
    if (!enabled || !view || view.zoom < HOUSE_MIN_ZOOM) return [] as OsmHouse[];
    const frame = view.bounds.pad(0.08);
    const out: OsmHouse[] = [];
    for (const h of houseCache.values()) {
      if (frame.contains(h.pos)) out.push(h);
    }
    return out;
  }, [enabled, view, renderTick]);

  // Latest valid pin per house — matched against the FULL frame (before the
  // render cap) so a worked house can never lose its bubble to the trim.
  // Remote drops stay off bubbles (stat-dead, already flagged on the map).
  const resultByHouse = useMemo(() => {
    const match = new Map<string, { pin: FieldPin; at: string }>();
    if (inFrame.length === 0) return match;
    const latWindow = MATCH_METERS / 111_000;
    for (const p of pins) {
      if (p.is_remote_drop || p.pending) continue;
      let best: OsmHouse | null = null;
      let bestD = MATCH_METERS;
      for (const h of inFrame) {
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
  }, [inFrame, pins]);

  // Deterministic trim: worked bubbles always render; neutral ones yield
  // from the frame edge inward (an edge gap reads as "still loading", never
  // a random mid-block hole).
  const visible = useMemo(() => {
    if (inFrame.length <= RENDER_CAP) return inFrame;
    const c = view!.bounds.getCenter();
    const cosLat = Math.cos((c.lat * Math.PI) / 180);
    const d2 = (h: OsmHouse) => {
      const dy = h.lat - c.lat;
      const dx = (h.lng - c.lng) * cosLat;
      return dy * dy + dx * dx;
    };
    const worked: OsmHouse[] = [];
    const neutral: OsmHouse[] = [];
    for (const h of inFrame) (resultByHouse.has(h.id) ? worked : neutral).push(h);
    neutral.sort((a, b) => d2(a) - d2(b));
    return worked.concat(neutral.slice(0, Math.max(0, RENDER_CAP - worked.length)));
  }, [inFrame, resultByHouse, view]);

  // Stable per-house event handlers: fresh objects every render would make
  // react-leaflet re-bind (off/on) every bubble on every GPS tick. Handlers
  // read the LATEST match/tap through refs.
  //
  // NO tap-time twin adoption: a mixed building↔addr pair 12-14 m apart is
  // MORE often a real unmapped neighbor than a same-door twin (review
  // 2026-09-14 — three lenses converged), so redirecting the tap onto the
  // other bubble's pin would silently edit a neighbor's logged result.
  // Twins are killed at INGEST instead (entrance/unit filters, number-aware
  // dedupe); a residual double ring is visible map reality the rep can see.
  const matchRef = useRef(resultByHouse);
  matchRef.current = resultByHouse;
  const handlerCacheRef = useRef(new Map<string, { click: () => void }>());
  const handlersFor = (id: string) => {
    let h = handlerCacheRef.current.get(id);
    if (!h) {
      h = {
        click: () => {
          const house = houseCache.get(id);
          if (!house) return;
          const m = matchRef.current.get(id);
          tapRef.current?.({
            ...house,
            currentPinId: m?.pin.id,
            currentType: m?.pin.pin_type,
          });
        },
      };
      handlerCacheRef.current.set(id, h);
    }
    return h;
  };

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
            position={h.pos}
            // Address-point houses always show their number — with no
            // footprint under them, the number IS the house.
            icon={bubbleIcon({ color, num: h.num, showNum: showNum || h.kind === "addr", hit })}
            interactive={tappable}
            // Bubbles sit UNDER result pins/the me-dot — a bubble must never
            // steal the tap meant for a pin correction dead-center on it.
            zIndexOffset={-800}
            eventHandlers={tappable ? handlersFor(h.id) : undefined}
          />
        );
      })}
    </>
  );
}
