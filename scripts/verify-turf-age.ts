/**
 * Old-tagged-area hiding (owner ask 2026-10-29): isOldArea drives which
 * turfs the captain/manager maps hide by default. Run: npm run verify:turfage
 */
import { isOldArea, OLD_AREA_DAYS } from "../src/lib/turf-age";

const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

let failures = 0;
function check(name: string, got: boolean, want: boolean) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} ${name} — got ${got}, want ${want}`);
}

check("fresh create, never assigned", isOldArea({ assigned_at: null, created_at: iso(2) }), false);
check(
  "created 45d ago, never assigned",
  isOldArea({ assigned_at: null, created_at: iso(45) }),
  true,
);
check(
  "created 45d ago, re-assigned 3d ago (assignment refreshes it)",
  isOldArea({ assigned_at: iso(3), created_at: iso(45) }),
  false,
);
check(
  "created 45d ago, assigned 40d ago",
  isOldArea({ assigned_at: iso(40), created_at: iso(45) }),
  true,
);
check(
  "exactly on the boundary stays visible",
  isOldArea({ assigned_at: null, created_at: iso(OLD_AREA_DAYS) }),
  false,
);
check(
  "just past the boundary hides",
  isOldArea({ assigned_at: null, created_at: iso(OLD_AREA_DAYS + 1) }),
  true,
);
check(
  "garbage dates never vanish a turf",
  isOldArea({ assigned_at: "not-a-date", created_at: "also-bad" }),
  false,
);
check(
  "missing dates never vanish a turf",
  isOldArea({ assigned_at: null, created_at: null }),
  false,
);
check(
  "bad assigned_at falls back to created_at",
  isOldArea({ assigned_at: "not-a-date", created_at: iso(60) }),
  true,
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll turf-age checks passed");
