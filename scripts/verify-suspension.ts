// Suspension recency-gate verification — the 7-day "still on the team" rule.
// Run:  npm run verify:suspension   (or: npx tsx scripts/verify-suspension.ts)
//
// Owner rule (2026-08-03): the suspension box only lists reps active within
// the last 7 calendar days (daily_metrics row presence, or a profile newer
// than the window). Pure module in, assertions out — no network, no database.
// Exits non-zero on any failure.

import { isRecentlyActive, lastActiveMap, SUSPENSION_RECENCY_DAYS } from "../src/lib/suspension";

const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (got !== want) fails.push(`${label}: got ${String(got)}, want ${String(want)}`);
};

const TODAY = "2026-08-03"; // cutoff = 2026-07-27 (inclusive)
const OLD = "2026-06-01"; // profile with real tenure — judged on activity
const row = (canvasser_id: string, metric_date: string) => ({ canvasser_id, metric_date });

eq("window constant", SUSPENSION_RECENCY_DAYS, 7);

// ---- lastActiveMap: presence, not lead counts --------------------------
const m1 = lastActiveMap([row("a", "2026-07-20"), row("a", "2026-07-31"), row("a", "2026-07-25")]);
eq("max date wins regardless of order", m1.get("a"), "2026-07-31");
eq("unknown id absent", m1.get("zz"), undefined);

// ---- The rule ----------------------------------------------------------
// 1. Last activity 8 days ago, old profile → hidden (the reported bug).
eq(
  "gone 8 days → excluded",
  isRecentlyActive(TODAY, ["a"], lastActiveMap([row("a", "2026-07-26")]), OLD),
  false,
);
// 2. Active 3 days ago (even with a current 2-day zero streak) → shows.
eq(
  "active 3 days ago → included",
  isRecentlyActive(TODAY, ["a"], lastActiveMap([row("a", "2026-07-31")]), OLD),
  true,
);
// 3. New hire: no rows yet, created 2 days ago → shows (grace).
eq("new hire, no rows → included", isRecentlyActive(TODAY, ["a"], new Map(), "2026-08-01"), true);
// 4. No rows ever, created 8 days ago → hidden.
eq(
  "no rows, 8-day-old profile → excluded",
  isRecentlyActive(TODAY, ["a"], new Map(), "2026-07-26"),
  false,
);
// 5. Dup group: only one duplicate id has a recent row → the group shows.
eq(
  "dup group, one recent id → included",
  isRecentlyActive(TODAY, ["a", "b"], lastActiveMap([row("b", "2026-08-02")]), OLD),
  true,
);
// 6. Boundary: last activity exactly 7 days ago → still shows (inclusive).
eq(
  "exactly on cutoff → included",
  isRecentlyActive(TODAY, ["a"], lastActiveMap([row("a", "2026-07-27")]), OLD),
  true,
);
// 6b. One day past the boundary → hidden.
eq(
  "one day past cutoff → excluded",
  isRecentlyActive(TODAY, ["a"], lastActiveMap([row("a", "2026-07-26")]), OLD),
  false,
);
// 7. A 0-lead row still registers as activity — lastActiveMap keys off
// presence, so callers must not pre-filter rows by leads_generated.
const zeroLeadRows = [{ canvasser_id: "a", metric_date: "2026-08-01", leads_generated: 0 }];
eq(
  "0-lead row counts as active",
  isRecentlyActive(TODAY, ["a"], lastActiveMap(zeroLeadRows), OLD),
  true,
);
// 8. Boundary of the new-hire grace: created exactly on cutoff → shows.
eq("created on cutoff → included", isRecentlyActive(TODAY, ["a"], new Map(), "2026-07-27"), true);

console.log(`checks run, ${fails.length} failure(s)`);
for (const f of fails) console.log("  FAIL " + f);
process.exit(fails.length === 0 ? 0 : 1);
