import { useEffect, useMemo, useRef, useState } from "react";
import { Marker, useMap } from "react-leaflet";
import L from "leaflet";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { viewBounds } from "@/lib/map-bounds";
import { withTimeout } from "@/lib/abort-timeout";
import { PIN_COLORS } from "@/lib/pin-results";
import {
  houseCache,
  haversineM,
  ingestBuilding,
  ingestAddrNode,
  MATCH_METERS,
  type OsmHouse,
  type OverpassElement,
} from "@/lib/house-cache";
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
 * wears its result's color; a house with a saved note wears a 📝 badge.
 * Tapping a bubble hands the house (plus its current pin, if any) to the
 * page, which opens the one-tap result sheet.
 *
 * The cache/dedupe/snap geometry lives in src/lib/house-cache.ts (pure,
 * verified by scripts/verify-house-snap.ts); this file owns the Overpass
 * fetch pipeline and rendering.
 *
 * Dense frames that would overflow one Overpass print are re-fetched as
 * quadrants (depth 1, sequential) so truncation never leaves arbitrary
 * mid-block holes; if a frame still overflows the render cap, the farthest
 * NEUTRAL bubbles from center yield first and worked bubbles never drop.
 *
 * OSM has no homeowner identities (the video app licenses that data), so the
 * under-bubble label is the house number where OSM knows it.
 */

export type { OsmHouse } from "@/lib/house-cache";

/** Bubbles only make sense at door-to-door zoom — below it they'd overlap
 *  2-3 deep and nothing would be tappable. NeonMap shows a "zoom in" pill
 *  between z14 and here so a zoomed-out rep is never silently circle-less. */
export const HOUSE_MIN_ZOOM = 17;
const NUMBER_MIN_ZOOM = 18;
/** DOM divIcon markers a mid-range field phone pans smoothly with. */
const RENDER_CAP = 300;

// Untyped table access (ObjectionDojo/gratitude pattern) until generated
// types catch up with house_notes — the default SupabaseClient generics
// keep the builder loose without per-call-site casts.
const rawTable = (name: string) => (supabase as unknown as SupabaseClient).from(name);

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

// Fetch-state session caches (module scope — shared across remounts).
const coveredBounds: L.LatLngBounds[] = [];
const MAX_COVERED = 64; // splits add up to 5 rects per dense view
let lastFailAt = 0;
let failNoticeShown = false;

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
function bubbleIcon(opts: {
  color: string | null;
  num: string;
  showNum: boolean;
  hit: number;
  noted: boolean;
}) {
  const { color, num, showNum, hit, noted } = opts;
  const key = `${color ?? "none"}|${showNum ? num : ""}|${hit}|${noted ? 1 : 0}`;
  let icon = bubbleIconCache.get(key);
  if (!icon) {
    const ring = color
      ? `border:3px solid ${color};box-shadow:0 0 12px ${color},inset 0 0 8px color-mix(in srgb, ${color} 45%, transparent);background:color-mix(in srgb, ${color} 18%, transparent);`
      : `border:2px solid rgba(255,255,255,0.72);background:rgba(10,14,24,0.28);box-shadow:0 0 6px rgba(0,0,0,0.5);`;
    const label =
      showNum && num
        ? `<div style="margin-top:1px;color:#fff;font:700 9px/1 ui-sans-serif,system-ui;text-shadow:0 0 4px #000,0 1px 2px #000;letter-spacing:0.04em;">${num.replace(/[<>&"']/g, "")}</div>`
        : "";
    // 📝 badge: this house has a saved note (rep ask 2026-09-15) — visible
    // from the street so "come back at 6" isn't buried behind a tap.
    const noteBadge = noted
      ? `<div style="position:absolute;top:-7px;right:-8px;font-size:12px;line-height:1;filter:drop-shadow(0 1px 2px #000);">📝</div>`
      : "";
    const html = `
    <div style="width:${hit}px;display:flex;flex-direction:column;align-items:center;">
      <div style="width:${hit}px;height:${hit}px;display:flex;align-items:center;justify-content:center;">
        <div style="position:relative;width:26px;height:26px;border-radius:9999px;${ring}">${noteBadge}</div>
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

  // House notes in view → 📝 badges. Sparse team data on a ~1 km rounded
  // bbox key: a walking rep's pans reuse one cached fetch instead of firing
  // per moveend; adds/deletes invalidate the ["house_notes"] prefix.
  const noteBox = useMemo(() => {
    if (!enabled || !view || view.zoom < HOUSE_MIN_ZOOM) return null;
    const b = view.bounds.pad(0.5);
    return {
      s: Math.floor(b.getSouth() * 100) / 100,
      w: Math.floor(b.getWest() * 100) / 100,
      n: Math.ceil(b.getNorth() * 100) / 100,
      e: Math.ceil(b.getEast() * 100) / 100,
    };
  }, [enabled, view]);
  const notesQuery = useQuery({
    enabled: !!noteBox,
    queryKey: ["house_notes", "bbox", noteBox?.s, noteBox?.w, noteBox?.n, noteBox?.e],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await rawTable("house_notes")
        .select("lat, lng")
        .gte("lat", noteBox!.s)
        .lte("lat", noteBox!.n)
        .gte("lng", noteBox!.w)
        .lte("lng", noteBox!.e)
        .limit(500);
      if (error) throw error;
      return (data ?? []) as Array<{ lat: number; lng: number }>;
    },
  });

  // Houses wearing a 📝 — each note badges its nearest house (same radius
  // as pin matching, so the badge lands where the sheet will find the note).
  const notedIds = useMemo(() => {
    const ids = new Set<string>();
    const notes = notesQuery.data ?? [];
    if (notes.length === 0 || inFrame.length === 0) return ids;
    const latWindow = MATCH_METERS / 111_000;
    for (const nte of notes) {
      let best: OsmHouse | null = null;
      let bestD = MATCH_METERS;
      for (const h of inFrame) {
        if (Math.abs(h.lat - nte.lat) > latWindow * 1.5) continue;
        const d = haversineM(h.lat, h.lng, nte.lat, nte.lng);
        if (d <= bestD) {
          bestD = d;
          best = h;
        }
      }
      if (best) ids.add(best.id);
    }
    return ids;
  }, [notesQuery.data, inFrame]);

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

  // Deterministic trim: worked and noted bubbles always render; neutral ones
  // yield from the frame edge inward (an edge gap reads as "still loading",
  // never a random mid-block hole).
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
    for (const h of inFrame) {
      (resultByHouse.has(h.id) || notedIds.has(h.id) ? worked : neutral).push(h);
    }
    neutral.sort((a, b) => d2(a) - d2(b));
    return worked.concat(neutral.slice(0, Math.max(0, RENDER_CAP - worked.length)));
  }, [inFrame, resultByHouse, notedIds, view]);

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
            icon={bubbleIcon({
              color,
              num: h.num,
              showNum: showNum || h.kind === "addr",
              hit,
              noted: notedIds.has(h.id),
            })}
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
