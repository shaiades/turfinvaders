/* Turf Invaders service worker — exactly two jobs, keep it that way:
 *
 * 1. Web Push for time-clock review alerts (payload shape from
 *    supabase/functions/notify-flagged-punch). Historically registered on
 *    demand by the "Enable alerts" flow (src/lib/push.ts); now also
 *    registered at boot for everyone (src/lib/register-sw.ts) because of:
 *
 * 2. A runtime cache for Esri basemap tiles. Esri serves tiles with
 *    Cache-Control: max-age=86400, so the plain HTTP cache forgets a
 *    canvasser's turf overnight and every shift re-downloads the same
 *    satellite JPEGs over field cellular — on a 1-bar connection that read
 *    as "the map never loads" (owner video 2026-09-21). Cache-first with a
 *    30-day cap: tiles are effectively immutable, and re-validating in the
 *    background (stale-while-revalidate) would re-spend the exact bandwidth
 *    the field crew doesn't have.
 *
 * NEVER cache the app shell (HTML/JS/CSS) here. A stale shell needs real
 * update UX (reload prompts, versioned precache) that this file doesn't
 * have; the fetch handler below must keep early-returning for everything
 * that isn't a tile. */

const TILE_CACHE = "esri-tiles-v1"; // bump the suffix to invalidate en masse
const TILE_HOST = "server.arcgisonline.com";
const MAX_TILE_ENTRIES = 1000; // ~256px JPEG/PNG tiles ≈ 20-40MB — inside iOS quota
const TRIM_BATCH = 100;
const TILE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TILE_FETCH_TIMEOUT_MS = 12_000;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Drop superseded tile caches (old TILE_CACHE names) on version bumps.
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("esri-tiles-") && k !== TILE_CACHE)
            .map((k) => caches.delete(k)),
        ),
      ),
    ]),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // Tiles only — every other request keeps default browser handling.
  if (url.hostname !== TILE_HOST || !url.pathname.includes("/MapServer/tile/")) return;
  event.respondWith(tileCacheFirst(event.request));
});

function tileIsFresh(response) {
  // Esri always sends Date; a missing header just means "keep serving it"
  // (the entry cap bounds growth either way).
  const date = response.headers.get("date");
  if (!date) return true;
  const age = Date.now() - new Date(date).getTime();
  return !(age > TILE_MAX_AGE_MS);
}

async function tileCacheFirst(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached && tileIsFresh(cached)) return cached;
  try {
    // AbortSignal.timeout is Safari 16+; older engines just fetch unbounded.
    const init =
      "timeout" in AbortSignal ? { signal: AbortSignal.timeout(TILE_FETCH_TIMEOUT_MS) } : undefined;
    const response = await fetch(request, init);
    // Only cache real, non-opaque successes: the TileLayers request with
    // crossOrigin="anonymous" so responses are type "cors"; opaque entries
    // would be quota-padded by megabytes and unverifiable.
    if (response.ok && (response.type === "cors" || response.type === "basic")) {
      const copy = response.clone();
      cache
        .put(request, copy)
        .then(() => trimTileCache(cache))
        .catch(() => {}); // quota/private-mode put failures never break the tile
    }
    return response;
  } catch (err) {
    // Stale-if-error: an expired tile beats a black square when the network
    // is gone. No cached copy → rethrow so Leaflet gets a real tileerror.
    if (cached) return cached;
    throw err;
  }
}

let trimming = false;
async function trimTileCache(cache) {
  if (trimming) return;
  trimming = true;
  try {
    // cache.keys() is insertion-ordered and cache-first never re-puts a
    // fresh hit, so the front of the list is the oldest — FIFO by batch.
    const keys = await cache.keys();
    if (keys.length > MAX_TILE_ENTRIES) {
      await Promise.all(keys.slice(0, TRIM_BATCH).map((k) => cache.delete(k)));
    }
  } catch {
    // Trim is best-effort.
  } finally {
    trimming = false;
  }
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Turf Invaders", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "Turf Invaders";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: payload.tag || "turf-invaders",
      data: { url: payload.url || "/dashboard?tab=timesheets" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
