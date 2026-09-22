import type { LatLng } from "@/components/NeonMap";

// Turf Tools and the canvass screen mount separate NeonMap/Leaflet
// instances, so switching between them used to reset pan/zoom/rotation
// (captain feedback 2026-09-17). Both screens report their view here on
// every move/zoom/rotate and read it back as the next mount's initial view.
//
// Since 2026-09: also persisted per user (ti_ localStorage convention) with
// a 24h shelf life, so a cold open lands on yesterday's streets instantly —
// on field cellular that's the difference between a map and a black
// rectangle while tiles for the continental-US fallback trickle in. The
// in-memory value stays the fast path; storage is read-through on the first
// call per user and written behind a debounce (moveend fires ~1/s under GPS
// follow).
export type MapView = { center: LatLng; zoom: number; bearing: number };

const TTL_MS = 24 * 60 * 60 * 1000;
const WRITE_DEBOUNCE_MS = 500;
const keyFor = (uid: string) => `ti_last_map_view:v1:${uid}`;

let last: (MapView & { at: number }) | null = null;
let lastUid: string | null = null;
let writeTimer: number | null = null;
let pendingWrite: { v: MapView; userId: string } | null = null;
let flushHooked = false;

// The debounce would drop the last pan if the rep swipes the app away
// within 500ms — pagehide is the reliable iOS Safari/PWA teardown signal
// (unload never fires there), so flush synchronously on the way out.
function hookFlush() {
  if (flushHooked || typeof window === "undefined") return;
  flushHooked = true;
  window.addEventListener("pagehide", () => {
    if (!pendingWrite) return;
    const { v, userId } = pendingWrite;
    pendingWrite = null;
    try {
      localStorage.setItem(keyFor(userId), JSON.stringify({ ...v, at: Date.now() }));
    } catch {
      /* best-effort */
    }
  });
}

function sane(v: unknown): v is MapView & { at: number } {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Partial<MapView & { at: number }>;
  return (
    typeof m.center === "object" &&
    m.center !== null &&
    Number.isFinite(m.center.lat) &&
    Math.abs(m.center.lat) <= 85 &&
    Number.isFinite(m.center.lng) &&
    Math.abs(m.center.lng) <= 180 &&
    typeof m.zoom === "number" &&
    m.zoom >= 3 &&
    m.zoom <= 20 &&
    typeof m.bearing === "number" &&
    Number.isFinite(m.bearing) &&
    typeof m.at === "number"
  );
}

export function getLastMapView(userId?: string): MapView | null {
  // A user switch on shared devices must never leak the previous rep's spot.
  if (userId && lastUid !== null && lastUid !== userId) last = null;
  if (userId) lastUid = userId;
  // TTL applies to the in-memory value too — an iOS tab resumed days later
  // must not sidestep the shelf life the storage path enforces.
  if (last && Date.now() - last.at <= TTL_MS) {
    return { center: last.center, zoom: last.zoom, bearing: last.bearing };
  }
  if (!userId || typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (!sane(v) || Date.now() - v.at > TTL_MS) return null;
    last = {
      center: { lat: v.center.lat, lng: v.center.lng },
      zoom: v.zoom,
      bearing: v.bearing,
      at: v.at,
    };
    return { center: last.center, zoom: last.zoom, bearing: last.bearing };
  } catch {
    return null; // private mode / corrupt JSON — same as no saved view
  }
}

export function setLastMapView(v: MapView, userId?: string): void {
  last = { ...v, at: Date.now() };
  if (!userId) return;
  lastUid = userId;
  if (typeof window === "undefined") return;
  hookFlush();
  pendingWrite = { v, userId };
  if (writeTimer != null) window.clearTimeout(writeTimer);
  writeTimer = window.setTimeout(() => {
    writeTimer = null;
    pendingWrite = null;
    try {
      localStorage.setItem(keyFor(userId), JSON.stringify({ ...v, at: Date.now() }));
    } catch {
      /* private mode / quota — in-memory behavior still works */
    }
  }, WRITE_DEBOUNCE_MS);
}
