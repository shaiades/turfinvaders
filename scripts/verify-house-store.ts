/** Assertions for the house-store decision helpers in src/lib/house-store.ts
 *  (rect keys, intersection, TTL, group-atomic eviction) plus the
 *  StoredHouse ⇄ restoreHouse round trip — run with `npm run verify:housestore`.
 *  The IDB plumbing itself is browser-only and try/catch-degrading; these
 *  pure helpers make every eviction/coverage decision, so they carry the
 *  correctness load (a quadrant evicted while its parent coverage marker
 *  survives would read as covered-but-empty — a permanent mid-block hole). */
import {
  HOUSE_TTL_MS,
  isFresh,
  pickEvictions,
  rectIntersects,
  rectKey,
  type RectMeta,
  type StoredHouse,
} from "../src/lib/house-store";
import { houseCache, resetHouseCache, restoreHouse, snapTapToHouse } from "../src/lib/house-cache";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) {
    failures++;
    console.error(`✗ ${label}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

const NOW = 1_800_000_000_000; // fixed clock — assertions never flake

// ---- rectKey ---------------------------------------------------------------
check(
  "rectKey canonicalizes to 5 decimals",
  rectKey(33.7, -117.8, 33.71, -117.79) === "33.70000,-117.80000,33.71000,-117.79000",
  rectKey(33.7, -117.8, 33.71, -117.79),
);
check(
  "rectKey is stable across float noise below 5 decimals",
  rectKey(33.700001, -117.8, 33.71, -117.79) === rectKey(33.7, -117.8, 33.71, -117.79),
);

// ---- rectIntersects --------------------------------------------------------
const R = (s: number, w: number, n: number, e: number) => ({ s, w, n, e });
check("overlapping rects intersect", rectIntersects(R(0, 0, 2, 2), R(1, 1, 3, 3)));
check("containment intersects", rectIntersects(R(0, 0, 10, 10), R(2, 2, 3, 3)));
check("touching edges intersect", rectIntersects(R(0, 0, 1, 1), R(1, 1, 2, 2)));
check("disjoint rects don't intersect", !rectIntersects(R(0, 0, 1, 1), R(2, 2, 3, 3)));
check(
  "lat-overlap alone doesn't intersect",
  !rectIntersects(R(0, 0, 1, 1), R(0, 5, 1, 6)),
);

// ---- isFresh ---------------------------------------------------------------
check("just-fetched is fresh", isFresh({ fetchedAt: NOW }, NOW));
check("at exactly TTL is fresh", isFresh({ fetchedAt: NOW - HOUSE_TTL_MS }, NOW));
check("past TTL is stale", !isFresh({ fetchedAt: NOW - HOUSE_TTL_MS - 1 }, NOW));

// ---- pickEvictions ---------------------------------------------------------
const meta = (
  key: string,
  groupKey: string,
  fetchedAgoMs: number,
  lastUsedAgoMs: number,
): RectMeta => ({
  key,
  groupKey,
  s: 0,
  w: 0,
  n: 1,
  e: 1,
  fetchedAt: NOW - fetchedAgoMs,
  lastUsedAt: NOW - lastUsedAgoMs,
});

{
  // Expired rects always evict, even under cap.
  const out = pickEvictions(
    [meta("a", "a", 0, 0), meta("b", "b", HOUSE_TTL_MS + 1, 0)],
    NOW,
    10,
  );
  check("expired rect evicts under cap", out.length === 1 && out[0] === "b", out);
}
{
  // Under cap, nothing fresh evicts.
  const out = pickEvictions([meta("a", "a", 0, 0), meta("b", "b", 0, 0)], NOW, 2);
  check("under cap keeps all fresh rects", out.length === 0, out);
}
{
  // Over cap: whole LRU group goes — a split's quadrants + parent marker
  // (5 rects sharing groupKey) evict together, never chipped apart.
  const split = [
    meta("parent", "parent", 0, 60_000),
    meta("q1", "parent", 0, 60_000),
    meta("q2", "parent", 0, 60_000),
    meta("q3", "parent", 0, 30_000), // freshest member sets group recency
    meta("q4", "parent", 0, 60_000),
  ];
  const solo = [meta("solo1", "solo1", 0, 90_000), meta("solo2", "solo2", 0, 10_000)];
  const out = pickEvictions([...split, ...solo], NOW, 6);
  check(
    "over cap evicts the LRU group whole (oldest solo first)",
    out.length === 1 && out[0] === "solo1",
    out,
  );
  const out2 = pickEvictions([...split, ...solo], NOW, 2);
  check(
    "deeper cut takes the split group atomically",
    out2.includes("solo1") &&
      ["parent", "q1", "q2", "q3", "q4"].every((k) => out2.includes(k)) &&
      !out2.includes("solo2"),
    out2,
  );
}
{
  // Group recency = freshest member: an actively-walked split outlives an
  // idle solo rect even if some quadrants are old.
  const out = pickEvictions(
    [
      meta("q1", "g", 0, 500_000),
      meta("q2", "g", 0, 1_000), // just touched — keeps the whole group
      meta("solo", "solo", 0, 400_000),
    ],
    NOW,
    2,
  );
  check("freshest member protects its group", out.length === 1 && out[0] === "solo", out);
}

// ---- StoredHouse ⇄ restoreHouse round trip ---------------------------------
resetHouseCache();
const stored: StoredHouse = {
  id: "w42",
  lat: 33.7,
  lng: -117.8,
  num: "1234",
  street: "Elm Street",
  zip: "92008",
  kind: "building",
};
restoreHouse(stored);
{
  const h = houseCache.get("w42");
  check("restoreHouse re-mints pos from lat/lng", h?.pos[0] === 33.7 && h?.pos[1] === -117.8);
  check("restored house carries no pin match", h?.currentPinId === undefined);
  check("restored house keeps the address", h?.num === "1234" && h?.street === "Elm Street");
}
{
  // Idempotent: hydrating an overlapping rect must not duplicate or clobber.
  const before = houseCache.get("w42");
  restoreHouse({ ...stored, num: "9999" });
  const after = houseCache.get("w42");
  check("restoreHouse skips ids already cached", after === before && after?.num === "1234");
  check("no duplicate entry after re-restore", houseCache.size === 1, houseCache.size);
}
{
  // A restored house is snappable — the grid index was rebuilt.
  const hit = snapTapToHouse(33.7 + 8 / 111_320, -117.8, []);
  check("restored house is snappable via the grid", hit?.id === "w42", hit?.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll house-store checks passed");
