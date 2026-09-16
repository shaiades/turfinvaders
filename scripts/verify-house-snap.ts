/** Assertions for the house-cache geometry in src/lib/house-cache.ts — run
 *  with `npm run verify:snap`. Pins down the mis-tap snap contract (rep
 *  feedback 2026-09-15: a near-miss on a house circle must open that house's
 *  sheet, never insta-drop the armed result) plus the street/number adoption
 *  rules the address display depends on. */
import {
  houseCache,
  ingestAddrNode,
  ingestBuilding,
  MATCH_METERS,
  resetHouseCache,
  snapTapToHouse,
  type SnapPin,
} from "../src/lib/house-cache";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) {
    failures++;
    console.error(`✗ ${label}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// Degrees per meter at a SoCal latitude (33.7°N — the crews' turf).
const LAT0 = 33.7;
const LNG0 = -117.8;
const M_LAT = 1 / 111_320;
const M_LNG = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));
const at = (dxM: number, dyM: number) => ({ lat: LAT0 + dyM * M_LAT, lng: LNG0 + dxM * M_LNG });

function building(id: number, dxM: number, dyM: number, tags?: Record<string, string>) {
  const { lat, lng } = at(dxM, dyM);
  ingestBuilding({
    type: "way",
    id,
    center: { lat, lon: lng },
    tags: { building: "house", ...tags },
  });
}
function addrNode(id: number, dxM: number, dyM: number, tags: Record<string, string>) {
  const { lat, lng } = at(dxM, dyM);
  ingestAddrNode({ type: "node", id, lat, lon: lng, tags });
}

// ---- snap: the mis-tap contract -------------------------------------------
resetHouseCache();
building(1, 0, 0, {
  "addr:housenumber": "1234",
  "addr:street": "Elm Street",
  "addr:postcode": "92008",
});

{
  const tap = at(8, 0); // 8 m off the centroid — a fat-finger miss
  const hit = snapTapToHouse(tap.lat, tap.lng, []);
  check("8 m near-miss snaps to the house", hit?.id === "w1", hit?.id);
  check(
    "snapped house carries the address",
    hit?.num === "1234" && hit?.street === "Elm Street" && hit?.zip === "92008",
    hit,
  );
  check(
    "no pin today → no current result attached",
    hit?.currentPinId === undefined,
    hit?.currentPinId,
  );
}
{
  const tap = at(MATCH_METERS + 6, 0); // 20 m — clearly off the house
  const hit = snapTapToHouse(tap.lat, tap.lng, []);
  check("20 m away stays a free-roam drop (null)", hit === null, hit?.id);
}
{
  const empty = snapTapToHouse(at(500, 500).lat, at(500, 500).lng, []);
  check("empty area (rural) stays a free-roam drop", empty === null, empty?.id);
}

// ---- snap: latest-valid-pin attach (the bubble-coloring rule) --------------
{
  const pin = (id: string, dxM: number, dyM: number, extra?: Partial<SnapPin>): SnapPin => ({
    id,
    pin_type: "not_home",
    lat: at(dxM, dyM).lat,
    lng: at(dxM, dyM).lng,
    created_at: `2026-09-15T18:00:0${id.length}Z`,
    ...extra,
  });
  const pins: SnapPin[] = [
    pin("a", 3, 0, { created_at: "2026-09-15T17:00:00Z" }),
    pin("bb", 4, 0, { pin_type: "go_back", created_at: "2026-09-15T18:30:00Z" }),
    pin("remote", 2, 0, { is_remote_drop: true, created_at: "2026-09-15T19:00:00Z" }),
    pin("optimistic", 2, 1, { pending: true, created_at: "2026-09-15T19:30:00Z" }),
  ];
  const tap = at(6, 0);
  const hit = snapTapToHouse(tap.lat, tap.lng, pins);
  check(
    "latest VALID pin wins (remote/pending skipped)",
    hit?.currentPinId === "bb",
    hit?.currentPinId,
  );
  check("current result rides along", hit?.currentType === "go_back", hit?.currentType);
}

// ---- snap: a neighbor's pin is never adopted -------------------------------
resetHouseCache();
building(10, 0, 0, { "addr:housenumber": "1", "addr:street": "A St" });
building(11, 16, 0, { "addr:housenumber": "3", "addr:street": "A St" }); // 16 m lot next door
{
  // Pin sits 10 m from house w10 but only 6 m from w11 — it belongs to w11.
  const p: SnapPin = {
    id: "n1",
    pin_type: "not_home",
    ...at(10, 0),
    created_at: "2026-09-15T18:00:00Z",
  };
  const tap = at(2, 0); // tapping at house w10
  const hit = snapTapToHouse(tap.lat, tap.lng, [p]);
  check("tap snaps to the nearest house", hit?.id === "w10", hit?.id);
  check(
    "the neighbor-owned pin is NOT adopted",
    hit?.currentPinId === undefined,
    hit?.currentPinId,
  );
  const tap2 = at(14, 0); // tapping nearer the neighbor
  const hit2 = snapTapToHouse(tap2.lat, tap2.lng, [p]);
  check(
    "neighbor tap snaps to the neighbor with its pin",
    hit2?.id === "w11" && hit2.currentPinId === "n1",
    hit2,
  );
}

// ---- ingest: street adoption ------------------------------------------------
resetHouseCache();
building(20, 0, 0); // bare footprint, no addr tags
addrNode(21, 5, 0, {
  "addr:housenumber": "77",
  "addr:street": "Oak Avenue",
  "addr:postcode": "92011",
}); // county point on the roof
{
  const h = houseCache.get("w20");
  check("footprint absorbs the county point's number", h?.num === "77", h?.num);
  check("footprint absorbs the county point's street", h?.street === "Oak Avenue", h?.street);
  check("footprint absorbs the county point's zip", h?.zip === "92011", h?.zip);
  check("absorbed point never becomes its own bubble", !houseCache.has("n21"), [
    ...houseCache.keys(),
  ]);
}

resetHouseCache();
addrNode(31, 5, 0, { "addr:housenumber": "88", "addr:street": "Pine Court" }); // point arrives FIRST
building(30, 0, 0); // quadrant order flipped
{
  const h = houseCache.get("w30");
  check(
    "reverse arrival order: footprint still absorbs number+street",
    h?.num === "88" && h?.street === "Pine Court",
    h,
  );
  check("reverse order kills the point bubble too", !houseCache.has("n31"), [...houseCache.keys()]);
}

// ---- ingest: differing numbers stay separate homes (zero-lot rule) ----------
resetHouseCache();
building(40, 0, 0, { "addr:housenumber": "10", "addr:street": "Shore Walk" });
addrNode(41, 10, 0, { "addr:housenumber": "12", "addr:street": "Shore Walk" });
{
  check("different housenumber under 12 m = real neighbor kept", houseCache.has("n41"), [
    ...houseCache.keys(),
  ]);
  const tap = at(9, 0);
  const hit = snapTapToHouse(tap.lat, tap.lng, []);
  check("tap between them snaps to the closer (the point)", hit?.id === "n41", hit?.id);
}

// ---- ingest: rel↔way merge keeps the relation's address on the way ----------
resetHouseCache();
ingestBuilding({
  type: "relation",
  id: 50,
  center: { lat: LAT0, lon: LNG0 },
  tags: {
    building: "house",
    "addr:housenumber": "5",
    "addr:street": "Loop Road",
    "addr:postcode": "92013",
  },
});
ingestBuilding({
  type: "way",
  id: 51,
  center: { lat: LAT0 + 1 * M_LAT, lon: LNG0 },
  tags: { building: "house" },
});
{
  check("way replaced the relation", houseCache.has("w51") && !houseCache.has("r50"), [
    ...houseCache.keys(),
  ]);
  const h = houseCache.get("w51");
  check(
    "way inherited number, street AND zip",
    h?.num === "5" && h?.street === "Loop Road" && h?.zip === "92013",
    h,
  );
}

if (failures > 0) {
  console.error(`\n${failures} failing check(s)`);
  process.exit(1);
}
console.log("\nAll house-snap checks passed.");
