/** Assertions for the Arcade Score v2 pure engine in
 *  src/lib/canvasser-arcade.ts — run with `npm run verify:canvasser-arcade`.
 *
 *  Pins the 2026-11-03 engagement-audit contracts:
 *   · rules merge over defaults key-wise; arrays replace whole; null falls
 *     back (mergeKombatRules semantics),
 *   · the default weights match the SQL triggers' fallbacks exactly,
 *   · totals always compute from ledger rows (per-canvasser + per-category),
 *   · the super meter fills toward super.daily_target and clamps,
 *   · a combo projects expiry from last_at + window and dies on day change,
 *   · the daily streak skips Sundays and needs streak.min_pts to stay alive,
 *   · finale: re-weighting, belt resolution and the FINISH HIM window. */
import {
  DEFAULT_ARCADE_RULES,
  FINALE_FINISH_WINDOW,
  comboDisplay,
  dailyStreak,
  finaleFinishHim,
  finaleNextTier,
  finalePace,
  finalePoints,
  finaleTierFor,
  mergeArcadeRules,
  superMeterState,
  totalsFromLedger,
  type ArcadeLedgerRow,
} from "../src/lib/canvasser-arcade";
import { daysLeftInRange, rangeRound, rangeWorkdays } from "../src/lib/contest-core";

let failures = 0;
function expectEq(label: string, got: unknown, want: unknown) {
  const ok =
    typeof got === "number" && typeof want === "number"
      ? Math.abs(got - want) < 1e-9
      : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`✗ ${label}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// ── Rules merge ───────────────────────────────────────────────────────────────
expectEq("null stored → defaults", mergeArcadeRules(null), DEFAULT_ARCADE_RULES);
const merged = mergeArcadeRules({ pts: { sit: 40 }, crit: null });
expectEq("partial pts merges", merged.pts.sit, 40);
expectEq("untouched siblings survive", merged.pts.sale, 50);
expectEq("stored null subtree falls back", merged.crit.mult, DEFAULT_ARCADE_RULES.crit.mult);
const tierEdit = mergeArcadeRules({
  finale: { tiers: [{ key: "solo", label: "Solo", points: 10 }] },
});
expectEq("tier arrays replace whole", tierEdit.finale.tiers.length, 1);

// ── Defaults mirror the SQL fallbacks ────────────────────────────────────────
expectEq(
  "SQL fallback mirror (talk/lead_set/confirmed/sit/sale)",
  [
    DEFAULT_ARCADE_RULES.pts.talk,
    DEFAULT_ARCADE_RULES.pts.lead_set,
    DEFAULT_ARCADE_RULES.pts.lead_confirmed,
    DEFAULT_ARCADE_RULES.pts.sit,
    DEFAULT_ARCADE_RULES.pts.sale,
  ],
  [1, 5, 10, 25, 50],
);
expectEq(
  "SQL fallback mirror (crit/combo/super)",
  [
    DEFAULT_ARCADE_RULES.crit.chance,
    DEFAULT_ARCADE_RULES.crit.mult,
    DEFAULT_ARCADE_RULES.crit.daily_cap,
    DEFAULT_ARCADE_RULES.combo.window_min,
    DEFAULT_ARCADE_RULES.combo.cap,
    DEFAULT_ARCADE_RULES.super.daily_target,
    DEFAULT_ARCADE_RULES.super.bonus,
  ],
  [0.08, 5, 4, 20, 3, 40, 15],
);

// ── Ledger totals ────────────────────────────────────────────────────────────
const rows: ArcadeLedgerRow[] = [
  { canvasser_id: "a", day: "2026-11-02", category: "talk", points: 3 },
  { canvasser_id: "a", day: "2026-11-02", category: "sit", points: 25 },
  { canvasser_id: "a", day: "2026-11-03", category: "talk", points: 2 },
  { canvasser_id: "b", day: "2026-11-03", category: "sale", points: 50 },
  { canvasser_id: "b", day: "2026-11-03", category: "talk", points: null },
];
const totals = totalsFromLedger(rows);
expectEq("per-canvasser sum", totals.byCanvasser.get("a"), 30);
expectEq("null points count 0", totals.byCanvasser.get("b"), 50);
expectEq("per-category sum", totals.byCategory.get("a")?.get("talk"), 5);

// ── Super meter ──────────────────────────────────────────────────────────────
const meter = superMeterState(30, DEFAULT_ARCADE_RULES);
expectEq("meter pct", meter.pct, 0.75);
expectEq("meter remaining", meter.remaining, 10);
expectEq("meter not unleashed", meter.unleashed, false);
expectEq("meter clamps past target", superMeterState(90, DEFAULT_ARCADE_RULES).pct, 1);
expectEq("meter unleashed at target", superMeterState(40, DEFAULT_ARCADE_RULES).unleashed, true);

// ── Combo display ────────────────────────────────────────────────────────────
const now = Date.parse("2026-11-03T20:00:00Z");
const alive = comboDisplay(
  { day: "2026-11-03", count: 3, last_at: "2026-11-03T19:50:00Z" },
  DEFAULT_ARCADE_RULES,
  now,
  "2026-11-03",
);
expectEq("combo alive inside window", alive.alive, true);
expectEq("combo msLeft = 10min", alive.msLeft, 10 * 60_000);
expectEq("next bonus capped", alive.nextBonus, 3);
const dead = comboDisplay(
  { day: "2026-11-03", count: 3, last_at: "2026-11-03T19:00:00Z" },
  DEFAULT_ARCADE_RULES,
  now,
  "2026-11-03",
);
expectEq("combo dies past window", dead.count, 0);
const stale = comboDisplay(
  { day: "2026-11-02", count: 9, last_at: "2026-11-03T19:59:00Z" },
  DEFAULT_ARCADE_RULES,
  now,
  "2026-11-03",
);
expectEq("combo dies on day change", stale.alive, false);
expectEq("no state → no combo", comboDisplay(null, DEFAULT_ARCADE_RULES, now).count, 0);

// ── Daily streak ─────────────────────────────────────────────────────────────
// 2026-11-03 is a Tuesday; 2026-11-01 was a Sunday (never breaks the chain).
const streakRows: ArcadeLedgerRow[] = [
  { canvasser_id: "a", day: "2026-11-03", category: "talk", points: 12 },
  { canvasser_id: "a", day: "2026-11-02", category: "talk", points: 15 },
  { canvasser_id: "a", day: "2026-10-31", category: "talk", points: 11 },
  { canvasser_id: "a", day: "2026-10-30", category: "talk", points: 4 }, // under min_pts
];
const streak = dailyStreak(streakRows, DEFAULT_ARCADE_RULES, "2026-11-03");
expectEq("streak skips Sunday, stops under min", streak.days, 3);
expectEq("streak alive today", streak.aliveToday, true);
const coldStart = dailyStreak([], DEFAULT_ARCADE_RULES, "2026-11-03");
expectEq("empty ledger → 0 streak", coldStart.days, 0);

// ── Finale ───────────────────────────────────────────────────────────────────
const byCat = new Map<string, number>([
  ["sit", 100],
  ["lead_confirmed", 40],
  ["talk", 60],
]);
expectEq(
  "finale re-weights quality",
  finalePoints(byCat, DEFAULT_ARCADE_RULES),
  100 * 1.6 + 40 * 1.25 + 60,
);
expectEq("belt for 650", finaleTierFor(650, DEFAULT_ARCADE_RULES)?.key, "blue");
expectEq("no belt under first tier", finaleTierFor(299, DEFAULT_ARCADE_RULES), null);
const fh = finaleFinishHim(580, DEFAULT_ARCADE_RULES);
expectEq("FINISH HIM inside the window", fh?.next.key, "blue");
expectEq("FINISH HIM toGo", fh?.toGo, 20);
expectEq("quiet outside the window", finaleFinishHim(500, DEFAULT_ARCADE_RULES), null);
expectEq("window constant", FINALE_FINISH_WINDOW, 25);
const nx = finaleNextTier(500, DEFAULT_ARCADE_RULES);
expectEq("next tier any distance", nx?.next.key, "blue");
expectEq("next tier toGo", nx?.toGo, 100);
expectEq("no tier above Black", finaleNextTier(1500, DEFAULT_ARCADE_RULES), null);

// ── Contest-core (Tier 3 lift — shared with kombat-month) ────────────────────
// Dec 2026: the 1st is a Tuesday, the 31st a Thursday. Mon–Sat workdays.
const wd = rangeWorkdays("2026-12-01", "2026-12-31", "2026-12-10");
expectEq("Dec 2026 workday total", wd.total, 27);
expectEq("elapsed through today", wd.elapsed, 9);
// elapsed + remaining overlap on a worked today.
expectEq("remaining from today", wd.remaining, 19);
const beforeStart = rangeWorkdays("2026-12-01", "2026-12-31", "2026-11-20");
expectEq("elapsed 0 before the range", beforeStart.elapsed, 0);
expectEq("days left counts today", daysLeftInRange("2026-12-01", "2026-12-31", "2026-12-30"), 2);
expectEq("days left 0 when past", daysLeftInRange("2026-12-01", "2026-12-31", "2027-01-02"), 0);
// Dec 1 is a Tuesday → the partial opening week is ROUND 1; Dec 10 (Thu)
// falls in the second Monday-anchored week.
const rr = rangeRound("2026-12-01", "2026-12-31", "2026-12-10");
expectEq("round number", rr?.roundNumber, 2);
expectEq("round end clamped to week", rr?.end, "2026-12-13");
expectEq("days left in round", rr?.daysLeftInRound, 4);
expectEq("total rounds in Dec", rr?.totalRounds, 5);
expectEq("null outside the range", rangeRound("2026-12-01", "2026-12-31", "2026-11-30"), null);

// finalePace over a configured window.
const finaleRules = mergeArcadeRules({
  finale: { start: "2026-12-01", end: "2026-12-31" },
});
const pace = finalePace(540, finaleRules, "2026-12-10");
expectEq("pace null without window", finalePace(100, DEFAULT_ARCADE_RULES, "2026-12-10"), null);
expectEq("pace projects linearly", Math.round(pace?.projected ?? 0), Math.round((540 * 27) / 9));
expectEq("projected belt", pace?.projectedTier?.key, "black");
expectEq("per-day to next belt", pace?.perDayToNext, (600 - 540) / 19);
expectEq("pace round number", pace?.round?.roundNumber, 2);
expectEq("pace days left", pace?.daysLeft, 22);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll canvasser-arcade assertions passed.");
