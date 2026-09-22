import type { OsmHouse } from "./house-cache";

/**
 * Disk persistence for the house-bubble cache (IndexedDB, the repo's first —
 * localStorage is wrong here: one dense covered rect is ~350 KB of JSON
 * against a 5 MB quota SHARED with the Supabase auth session and the ti_
 * draft-turf insurance keys, parsed synchronously on the main thread).
 *
 * Model: HouseBubbles marks a fetched viewport rect "covered" and persists
 * that rect's houses as one blob. A truncated fetch splits into 4 quadrant
 * blobs plus an EMPTY parent coverage marker, all sharing a groupKey —
 * eviction is group-atomic, because evicting a quadrant while its parent
 * marker survives would read as covered-but-empty (a permanent mid-block
 * hole). TTL 14 days: buildings don't move; expiry forces an OSM refresh.
 *
 * This is a CACHE. Authoritative worked/noted state lives in Supabase
 * (field_pins / house_notes); StoredHouse deliberately drops the transient
 * pin-match fields. Every IDB entry point is try/catch + null-safe so
 * private-mode Safari degrades to today's memory-only behavior.
 *
 * The decision helpers (rectKey/rectIntersects/isFresh/pickEvictions) are
 * pure and exported for scripts/verify-house-store.ts.
 */

export type StoredHouse = Omit<OsmHouse, "pos" | "currentPinId" | "currentType">;

export type Rect = { s: number; w: number; n: number; e: number };

export type RectMeta = Rect & {
  key: string;
  /** Rects that live and die together (a split's quadrants + parent marker). */
  groupKey: string;
  fetchedAt: number;
  lastUsedAt: number;
};

export const HOUSE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Max persisted rects (~150 KB avg blob → worst case a few MB on disk). */
export const RECT_CAP = 120;

/** Canonical rect id — 5 decimals ≈ 1.1 m, stable for identical bounds. */
export function rectKey(s: number, w: number, n: number, e: number): string {
  return `${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)}`;
}

export function rectIntersects(a: Rect, b: Rect): boolean {
  return a.s <= b.n && a.n >= b.s && a.w <= b.e && a.e >= b.w;
}

export function isFresh(meta: { fetchedAt: number }, now: number): boolean {
  return now - meta.fetchedAt <= HOUSE_TTL_MS;
}

/** Which rect keys to delete: every TTL-expired rect, then — if still over
 *  cap — whole GROUPS, least-recently-used first (group recency = its
 *  freshest member, so an actively-walked split isn't chipped apart). */
export function pickEvictions(metas: RectMeta[], now: number, cap = RECT_CAP): string[] {
  const evict: string[] = [];
  const fresh: RectMeta[] = [];
  for (const m of metas) {
    if (isFresh(m, now)) fresh.push(m);
    else evict.push(m.key);
  }
  if (fresh.length <= cap) return evict;
  const groups = new Map<string, { keys: string[]; lastUsedAt: number }>();
  for (const m of fresh) {
    let g = groups.get(m.groupKey);
    if (!g) groups.set(m.groupKey, (g = { keys: [], lastUsedAt: 0 }));
    g.keys.push(m.key);
    g.lastUsedAt = Math.max(g.lastUsedAt, m.lastUsedAt);
  }
  const ordered = [...groups.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  let count = fresh.length;
  for (const g of ordered) {
    if (count <= cap) break;
    evict.push(...g.keys);
    count -= g.keys.length;
  }
  return evict;
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing. One DB, two stores: tiny metas (scanned whole) and the
// house blobs (fetched per key).

const DB_NAME = "ti_house_cache";
const DB_VERSION = 1;
const META_STORE = "rect_meta";
const HOUSES_STORE = "rect_houses";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(HOUSES_STORE)) {
          db.createObjectStore(HOUSES_STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // A future schema bump in another tab must not deadlock it.
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null); // private-mode Safari can throw on open
    }
  });
  return dbPromise;
}

function reqDone<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function putRect(meta: RectMeta, houses: StoredHouse[]): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction([META_STORE, HOUSES_STORE], "readwrite");
    tx.objectStore(META_STORE).put(meta);
    tx.objectStore(HOUSES_STORE).put({ key: meta.key, houses });
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve(); // quota etc. — cache write is best-effort
      tx.onabort = () => resolve();
    });
  } catch {
    /* best-effort */
  }
}

export async function loadAllMeta(): Promise<RectMeta[]> {
  try {
    const db = await openDb();
    if (!db) return [];
    const tx = db.transaction(META_STORE, "readonly");
    return (await reqDone(tx.objectStore(META_STORE).getAll())) as RectMeta[];
  } catch {
    return [];
  }
}

export async function getHouses(key: string): Promise<StoredHouse[] | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    const tx = db.transaction(HOUSES_STORE, "readonly");
    const row = (await reqDone(tx.objectStore(HOUSES_STORE).get(key))) as
      | { key: string; houses: StoredHouse[] }
      | undefined;
    return row?.houses ?? null;
  } catch {
    return null;
  }
}

export async function touchRects(keys: string[], now: number): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(META_STORE, "readwrite");
    const store = tx.objectStore(META_STORE);
    for (const key of keys) {
      const meta = (await reqDone(store.get(key))) as RectMeta | undefined;
      if (meta) store.put({ ...meta, lastUsedAt: now });
    }
  } catch {
    /* best-effort */
  }
}

export async function deleteRects(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction([META_STORE, HOUSES_STORE], "readwrite");
    for (const key of keys) {
      tx.objectStore(META_STORE).delete(key);
      tx.objectStore(HOUSES_STORE).delete(key);
    }
  } catch {
    /* best-effort */
  }
}

/** TTL + cap sweep — called once per session from the first hydration. */
export async function pruneStore(now: number): Promise<void> {
  const metas = await loadAllMeta();
  await deleteRects(pickEvictions(metas, now));
}
