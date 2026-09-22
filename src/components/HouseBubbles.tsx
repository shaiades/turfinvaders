import { useEffect, useMemo, useRef, useState } from "react";
import { Marker, useMap } from "react-leaflet";
import L from "leaflet";
import { useQuery } from "@tanstack/react-query";
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
  restoreHouse,
  MATCH_METERS,
  type OsmHouse,
  type OverpassElement,
} from "@/lib/house-cache";
import {
  rectKey,
  rectIntersects,
  isFresh,
  putRect,
  loadAllMeta,
  getHouses,
  touchRects,
  pruneStore,
  type StoredHouse,
} from "@/lib/house-store";
import type { HouseFetchStatus } from "@/lib/map-status";
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

// Public Overpass endpoints. The primary fires immediately; the mirror is
// HEDGED in 2.5s later (or the moment the primary fails fast) — first
// success wins and aborts the loser. On weak field cellular that turns a
// dead primary from a 10s stall into a ~3s failover, at the cost of at most
// one extra in-flight request. After BOTH fail we go quiet for a beat — a
// field crew must never turn into a retry storm (one deferred fetch fires
// at cooldown expiry; the status pill's retry clears it early).
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const HEDGE_DELAY_MS = 2_500;
const FAIL_COOLDOWN_MS = 20_000;
// Server-side junk filter, mirroring EXCLUDED_BUILDINGS in house-cache.ts:
// garages/sheds consumed print budget before the client filter dropped
// them, and budget exhaustion is what forces quadrant splits (the slow
// path). The client filter stays as belt-and-braces.
const EXCLUDED_BUILDINGS_RE = "^(garage|garages|shed|carport|roof|greenhouse|hut|kiosk|service|ruins|no)$";
// Surface "loading" only when a real network fetch outlives this grace —
// cache hits and fast fetches never flash the pill.
const LOADING_GRACE_MS = 600;
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
// Splits add up to 5 rects per dense view; hydrated rects from the disk
// store land here too, and must not FIFO-evict the session's own fetches.
const MAX_COVERED = 128;
let lastFailAt = 0;
// Rects already persisted or hydrated this session — guards double writes
// and double restores.
const storedKeys = new Set<string>();
let prunedThisSession = false;

/** One attempt against one endpoint. Ingests on success (idempotent via
 *  houseCache.has, so a double-success hedge race is harmless) and returns
 *  RAW per-class element counts (before client filters — filtered elements
 *  consumed print budget too, and the counts are how the caller detects
 *  truncation). */
async function overpassAttempt(
  endpoint: string,
  query: string,
  signal: AbortSignal,
): Promise<{ buildings: number; nodes: number }> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
    // 10 s client deadline per attempt. `[timeout:8]` is a server-side
    // hint that never covers a hung connection. The deadline aborts as
    // TimeoutError, so AbortError still uniquely means "caller cancelled".
    signal: withTimeout(signal, 10_000),
  });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  const data = (await res.json()) as { elements?: OverpassElement[]; remark?: string };
  // Overpass can 200 a TIMED-OUT query: partial elements plus a
  // runtime-error remark, with per-class counts under the caps.
  // Counting that as complete would mark the rect covered and cache
  // mid-block holes for the whole session — treat it as this attempt
  // failing (the hedge/mirror gets its shot, then the cooldown).
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
}

/** Hedged round trip: primary now, mirror after HEDGE_DELAY_MS (or the
 *  moment the primary fails fast). First success wins and aborts the
 *  loser; max 2 requests per bbox, mirror only when the primary is slow
 *  or dead — same order of load on the public endpoints as the old
 *  sequential walk, minus the 10s dead-primary stall. */
function overpassRequest(
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
  // center, close enough for a multipolygon home). The !~/!key prefilters
  // stop junk from eating the print caps server-side.
  const query =
    `[out:json][timeout:8];` +
    `(way[building][building!~"${EXCLUDED_BUILDINGS_RE}"](${bbox});` +
    `relation[building][building!~"${EXCLUDED_BUILDINGS_RE}"](${bbox}););` +
    `out tags center ${BUILDING_CAP};` +
    `node["addr:housenumber"][!"addr:unit"][!"entrance"](${bbox});out ${NODE_CAP};`;
  return new Promise((resolve, reject) => {
    const ctrls: AbortController[] = [];
    let launched = 0;
    let failed = 0;
    let done = false;
    let hedgeTimer: number | null = null;
    let lastErr: unknown = null;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      if (hedgeTimer != null) window.clearTimeout(hedgeTimer);
      signal.removeEventListener("abort", onOuterAbort);
      for (const c of ctrls) c.abort();
      settle();
    };
    const onOuterAbort = () =>
      finish(() => reject(new DOMException("aborted", "AbortError")));
    const launch = (i: number) => {
      if (done || i >= OVERPASS_ENDPOINTS.length) return;
      launched++;
      const ac = new AbortController();
      ctrls.push(ac);
      overpassAttempt(OVERPASS_ENDPOINTS[i], query, ac.signal).then(
        (counts) => finish(() => resolve(counts)),
        (e) => {
          if (done) return;
          if (e instanceof DOMException && e.name === "AbortError") return; // we cancelled it
          lastErr = e;
          failed++;
          if (launched < OVERPASS_ENDPOINTS.length) {
            // Fast primary failure — don't wait out the hedge delay.
            if (hedgeTimer != null) {
              window.clearTimeout(hedgeTimer);
              hedgeTimer = null;
            }
            launch(launched);
          } else if (failed >= launched) {
            lastFailAt = Date.now();
            finish(() =>
              reject(lastErr instanceof Error ? lastErr : new Error("overpass unavailable")),
            );
          }
        },
      );
    };
    if (signal.aborted) {
      onOuterAbort();
      return;
    }
    signal.addEventListener("abort", onOuterAbort, { once: true });
    launch(0);
    hedgeTimer = window.setTimeout(() => {
      hedgeTimer = null;
      launch(launched);
    }, HEDGE_DELAY_MS);
  });
}

function pushCovered(bounds: L.LatLngBounds) {
  coveredBounds.push(bounds);
  if (coveredBounds.length > MAX_COVERED) coveredBounds.shift();
}

/** Persist a covered rect's houses (or an empty parent coverage marker) to
 *  the disk store, fire-and-forget. groupKey ties a split's quadrants to
 *  their parent marker so eviction is group-atomic. */
function persistRect(bounds: L.LatLngBounds, groupKey: string, includeHouses: boolean) {
  const s = bounds.getSouth();
  const w = bounds.getWest();
  const n = bounds.getNorth();
  const e = bounds.getEast();
  const key = rectKey(s, w, n, e);
  if (storedKeys.has(key)) return;
  storedKeys.add(key);
  const houses: StoredHouse[] = [];
  if (includeHouses) {
    for (const h of houseCache.values()) {
      if (bounds.contains(h.pos)) {
        const { pos: _pos, currentPinId: _p, currentType: _t, ...rest } = h;
        houses.push(rest);
      }
    }
  }
  const now = Date.now();
  void putRect({ key, s, w, n, e, groupKey, fetchedAt: now, lastUsedAt: now }, houses);
}

/** Restore any fresh persisted rects intersecting `want` into the session
 *  cache + coveredBounds. Returns true when houses actually landed (the
 *  caller bumps the render tick). On a reload with no service, this is the
 *  difference between yesterday's circles painting in <100ms and nothing. */
async function hydrateCovered(want: L.LatLngBounds): Promise<boolean> {
  let landed = false;
  try {
    const metas = await loadAllMeta();
    if (!prunedThisSession) {
      prunedThisSession = true;
      void pruneStore(Date.now());
    }
    const now = Date.now();
    const wantRect = {
      s: want.getSouth(),
      w: want.getWest(),
      n: want.getNorth(),
      e: want.getEast(),
    };
    const touched: string[] = [];
    for (const m of metas) {
      if (storedKeys.has(m.key)) continue;
      if (!isFresh(m, now) || !rectIntersects(m, wantRect)) continue;
      const houses = await getHouses(m.key);
      // Blob missing (partial write, cleared store) — do NOT mark covered,
      // or the viewport fetch would skip a rect we can't actually paint.
      if (houses == null) continue;
      storedKeys.add(m.key);
      for (const h of houses) restoreHouse(h);
      pushCovered(L.latLngBounds([m.s, m.w], [m.n, m.e]));
      touched.push(m.key);
      if (houses.length > 0) landed = true;
    }
    if (touched.length > 0) void touchRects(touched, now);
  } catch {
    /* IDB unavailable — memory-only behavior, exactly as before */
  }
  return landed;
}

/** Fetch with truncation honesty: a print capped at N returns exactly N in
 *  database order — geographically arbitrary mid-block holes, the trust
 *  killer. A truncated fetch re-runs as 4 quadrants (depth 1) in two
 *  concurrent PAIRS (polite to the public endpoints, half the wall clock);
 *  the parent rect is recorded only after ALL quadrants land, keeping the
 *  covered-bounds `contains` gate sound. Quadrants consult coveredBounds
 *  themselves so a walking rep's restarted split reuses finished pieces.
 *  Finished rects persist to the disk store under one groupKey per split. */
async function fetchHouses(
  bounds: L.LatLngBounds,
  signal: AbortSignal,
  onChunk: () => void,
  depth = 0,
  groupKey?: string,
): Promise<void> {
  if (depth > 0 && coveredBounds.some((b) => b.contains(bounds))) {
    onChunk();
    return;
  }
  const ownKey = rectKey(
    bounds.getSouth(),
    bounds.getWest(),
    bounds.getNorth(),
    bounds.getEast(),
  );
  const { buildings, nodes } = await overpassRequest(bounds, signal);
  const truncated = buildings >= BUILDING_CAP || nodes >= NODE_CAP;
  if (!truncated || depth >= 1) {
    if (truncated) {
      // Post-split quadrant still over budget ≈ >10k buildings/km² —
      // Manhattan, not a canvass turf. Accept and move on.
      console.warn("[house-bubbles] dense frame truncated after split");
    }
    pushCovered(bounds);
    persistRect(bounds, groupKey ?? ownKey, true);
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
  for (const pair of [
    [quads[0], quads[1]],
    [quads[2], quads[3]],
  ]) {
    await new Promise((r) => setTimeout(r, QUADRANT_SPACING_MS));
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    // allSettled, not all: a fast-failing sibling must not orphan the other
    // quadrant's in-flight promise as an unhandled rejection.
    const results = await Promise.allSettled(
      pair.map((q) => fetchHouses(q, signal, onChunk, depth + 1, ownKey)),
    );
    const failure = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failure) throw failure.reason;
  }
  pushCovered(bounds);
  // Empty coverage marker: the quadrant blobs hold the houses; duplicating
  // them at the parent would double the disk payload.
  persistRect(bounds, ownKey, false);
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
  onStatusChange,
  retryToken = 0,
}: {
  enabled: boolean;
  /** Today's pins — they color the bubbles of the houses they landed on. */
  pins?: FieldPin[];
  onHouseTap?: (house: OsmHouse) => void;
  /** Circle-fetch health for NeonMap's status pill: "loading" when a real
   *  network fetch outlives a short grace, "unavailable" after both
   *  endpoints fail (canvass screen only — spectate has no armed chips to
   *  point at), "ok" otherwise. Replaces the old boolean availability wire. */
  onStatusChange?: (status: HouseFetchStatus) => void;
  /** Bump to clear the failure cooldown and refetch NOW — the status pill's
   *  tap-to-retry (FlyTo key pattern). */
  retryToken?: number;
}) {
  const map = useMap();
  const [renderTick, setRenderTick] = useState(0);
  const [view, setView] = useState<{ bounds: L.LatLngBounds; zoom: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inflightRef = useRef<L.LatLngBounds | null>(null);
  const debounceRef = useRef<number | null>(null);
  const loadingTimerRef = useRef<number | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const tapRef = useRef(onHouseTap);
  tapRef.current = onHouseTap;
  const statusRef = useRef(onStatusChange);
  statusRef.current = onStatusChange;

  useEffect(() => {
    if (!enabled) return;
    const clearLoadingTimer = () => {
      if (loadingTimerRef.current != null) {
        window.clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = null;
      }
    };
    const fire = async () => {
      // Re-check at fire time — the rep may have zoomed out mid-debounce.
      if (map.getZoom() < HOUSE_MIN_ZOOM) return;
      const want = viewBounds(map).pad(0.4);
      // Disk/cache first, BEFORE the cooldown gate: hydration is local and
      // an area we can already paint must clear the "unavailable" pill
      // immediately — deferring it 20s would show a warning over visibly
      // rendering circles.
      if (await hydrateCovered(want)) setRenderTick((t) => t + 1);
      if (coveredBounds.some((b) => b.contains(want))) {
        statusRef.current?.("ok");
        return;
      }
      // Failure cooldown: never storm the endpoints, but never go dead
      // either — exactly ONE deferred fetch re-arms itself for expiry
      // (pre-#249 this cleared the debounce outright, which read as
      // "circles permanently broken" on flaky LTE).
      const wait = lastFailAt + FAIL_COOLDOWN_MS - Date.now();
      if (wait > 0) {
        debounceRef.current = window.setTimeout(fire, wait + 250);
        return;
      }
      // A walking rep's GPS-follow pans fire moveend every settle; if the
      // in-flight fetch (padded ~350 m beyond the frame) already covers
      // the shifted viewport, let it FINISH instead of aborting a nearly
      // done quadrant split over and over.
      if (abortRef.current && inflightRef.current?.contains(want)) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      inflightRef.current = want;
      // "Loading" only if this real fetch outlives the grace — cache hits
      // and quick fetches never flash the pill.
      clearLoadingTimer();
      loadingTimerRef.current = window.setTimeout(() => {
        loadingTimerRef.current = null;
        if (abortRef.current === ac) statusRef.current?.("loading");
      }, LOADING_GRACE_MS);
      try {
        await fetchHouses(want, ac.signal, () => setRenderTick((t) => t + 1));
        clearLoadingTimer();
        statusRef.current?.("ok");
      } catch (e) {
        // AbortError = superseded by a newer pan/zoom; the successor cleared
        // our loading timer when it scheduled its own and owns the status.
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          // Bubbles simply don't appear; armed bare-map taps keep working —
          // the status pill says so for as long as it stays true (canvass
          // screen only; spectate reports "ok" = nothing to say).
          console.warn("[house-bubbles] fetch failed", e);
          clearLoadingTimer();
          statusRef.current?.(tapRef.current ? "unavailable" : "ok");
        }
      } finally {
        // A finished (or failed) fetch is no longer in flight — a stale
        // ref here would make the contains-skip above block retries of
        // this area after a failure.
        if (abortRef.current === ac) {
          abortRef.current = null;
          inflightRef.current = null;
          clearLoadingTimer();
        }
      }
    };
    const refresh = () => {
      const zoom = map.getZoom();
      setView({ bounds: viewBounds(map), zoom });
      if (zoom < HOUSE_MIN_ZOOM) {
        // Clear any pending timer too — a fetch scheduled at street zoom
        // must not fire against a zoomed-out viewport (a giant bbox that
        // truncates past the split depth would poison coveredBounds).
        if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
        return;
      }
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(fire, 400);
    };
    refreshRef.current = refresh;
    refresh();
    map.on("moveend", refresh);
    map.on("zoomend", refresh);
    return () => {
      map.off("moveend", refresh);
      map.off("zoomend", refresh);
      refreshRef.current = null;
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      clearLoadingTimer();
      abortRef.current?.abort();
    };
  }, [map, enabled]);

  // Status-pill retry: clear the cooldown and go now.
  useEffect(() => {
    if (!retryToken) return;
    lastFailAt = 0;
    refreshRef.current?.();
  }, [retryToken]);

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

// ---------------------------------------------------------------------------
// Turf prefetch — morning WiFi (or the parking-lot bar of signal) loads the
// day's houses into the disk store before the rep starts walking.

const PREFETCH_TILE_DEG = 0.008; // ≈ one padded z17 frame at SoCal latitude
const PREFETCH_MAX_TILES = 6; // per turf, center-out; edges fill via viewport
const prefetchedTurfSigs = new Set<string>();

/** Background-fill the assigned turf's houses (canvasser turfs only — a
 *  captain's query returns EVERY turf and prefetching all of them would
 *  hammer the public mirrors). Sequential on purpose: background work never
 *  competes with the interactive viewport fetch for parallelism. Failures
 *  are silent (the viewport fetch owns the status pill) but do set the
 *  shared cooldown, which is exactly the storm protection we want. */
export async function prefetchTurfHouses(
  polygons: Array<Array<{ lat: number; lng: number }>>,
): Promise<void> {
  try {
    for (const poly of polygons) {
      if (poly.length < 3) continue;
      let s = 90;
      let w = 180;
      let n = -90;
      let e = -180;
      for (const p of poly) {
        s = Math.min(s, p.lat);
        n = Math.max(n, p.lat);
        w = Math.min(w, p.lng);
        e = Math.max(e, p.lng);
      }
      // One prefetch per turf shape per session — realtime turf refetches
      // re-run the caller effect with the same polygons.
      const sig = rectKey(s, w, n, e);
      if (prefetchedTurfSigs.has(sig)) continue;
      prefetchedTurfSigs.add(sig);
      // Small pad so edge houses (door on the boundary street) make it in.
      s -= 0.0006;
      w -= 0.0006;
      n += 0.0006;
      e += 0.0006;
      const rows = Math.max(1, Math.ceil((n - s) / PREFETCH_TILE_DEG));
      const cols = Math.max(1, Math.ceil((e - w) / PREFETCH_TILE_DEG));
      const cLat = (s + n) / 2;
      const cLng = (w + e) / 2;
      const tiles: Array<{ b: L.LatLngBounds; d: number }> = [];
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
          const b = L.latLngBounds(
            [s + (i * (n - s)) / rows, w + (j * (e - w)) / cols],
            [s + ((i + 1) * (n - s)) / rows, w + ((j + 1) * (e - w)) / cols],
          );
          const cc = b.getCenter();
          const dy = cc.lat - cLat;
          const dx = cc.lng - cLng;
          tiles.push({ b, d: dy * dy + dx * dx });
        }
      }
      tiles.sort((a, b) => a.d - b.d);
      const ac = new AbortController();
      let fetched = 0;
      for (const t of tiles) {
        if (fetched >= PREFETCH_MAX_TILES) break;
        // Respect the shared failure cooldown — if the viewport fetch just
        // burned both endpoints, background work stands down entirely.
        if (Date.now() - lastFailAt < FAIL_COOLDOWN_MS) return;
        if (coveredBounds.some((cb) => cb.contains(t.b))) continue;
        await hydrateCovered(t.b);
        if (coveredBounds.some((cb) => cb.contains(t.b))) continue;
        fetched++;
        await new Promise((r) => setTimeout(r, QUADRANT_SPACING_MS));
        await fetchHouses(t.b, ac.signal, () => {});
      }
    }
  } catch {
    // Silent: prefetch is a nicety. lastFailAt is already set by the shared
    // fetch machinery, so the next attempt waits out the cooldown.
  }
}
