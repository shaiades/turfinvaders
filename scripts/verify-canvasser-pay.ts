/** Assertions for the Canvasser Arcade pay/boss/XP math in
 *  src/lib/canvasserPay.ts — run with `npm run verify:canvasserpay`.
 *
 *  Pins the things that must never drift from the real pay engine:
 *   · the $100K boss crossings ($100K, $200K) and the $1,500 bonus parity,
 *   · the enrage window (final $10K) and a fresh boss never enraging,
 *   · the sit bonus starting on the 4th sit ($50, $75 elevated),
 *   · loot folding the clocked components and inventing no per-appt line,
 *   · the XP curve / level thresholds, badges and the sit-rate grades.
 *
 *  Job Walk exclusion and WCC-cancellation netting are NOT tested here: they
 *  are enforced upstream in the data layer (getDispatchProduction / the pay
 *  RPCs), and this module only shapes an already-clean total. The comments on
 *  bossState() record that contract. */
import {
  bossState,
  BOSS_HP,
  BOSS_BOUNTY,
  paceProjection,
  lootLines,
  lootTotal,
  sitBonusFor,
  xpFor,
  levelForXp,
  cumXpForLevel,
  evaluateBadges,
  bestDaySits,
  sitRate,
  volumeBonusForMonthRevenue,
} from "../src/lib/canvasserPay";

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

// ── Boss crossings ───────────────────────────────────────────────────────
expectEq("BOSS_HP is $100K", BOSS_HP, 100_000);
expectEq("BOSS_BOUNTY is $1,500", BOSS_BOUNTY, 1_500);

const b0 = bossState(0);
expectEq("$0 → boss level 1", b0.level, 1);
expectEq("$0 → 0 defeated", b0.bossesDefeated, 0);
expectEq("$0 → full HP left", b0.hpLeft, 100_000);
expectEq("$0 → 0 segments", b0.segmentsCleared, 0);
expectEq("$0 → not enraged", b0.enraged, false);
expectEq("$0 → $0 bonus", b0.bonusEarned, 0);

const b40 = bossState(40_000);
expectEq("$40K → into 40K", b40.hpInto, 40_000);
expectEq("$40K → 60K left", b40.hpLeft, 60_000);
expectEq("$40K → 4 segments", b40.segmentsCleared, 4);
expectEq("$40K → pct 0.4", b40.pct, 0.4);
expectEq("$40K → not enraged", b40.enraged, false);

const b95 = bossState(95_000);
expectEq("$95K → 5K left", b95.hpLeft, 5_000);
expectEq("$95K → 9 segments", b95.segmentsCleared, 9);
expectEq("$95K → ENRAGED", b95.enraged, true);

// Exactly on the $10K enrage line — still in the final segment, enraged.
expectEq("$90K → 10K left → enraged", bossState(90_000).enraged, true);
expectEq("$89,999 → >10K left → not enraged", bossState(89_999).enraged, false);

const b100 = bossState(100_000);
expectEq("$100K → 1 defeated", b100.bossesDefeated, 1);
expectEq("$100K → now fighting boss 2", b100.level, 2);
expectEq("$100K → fresh boss, into 0", b100.hpInto, 0);
expectEq("$100K → fresh boss, full HP", b100.hpLeft, 100_000);
expectEq("$100K → fresh boss NOT enraged", b100.enraged, false);
expectEq("$100K → $1,500 banked", b100.bonusEarned, 1_500);

const b200 = bossState(200_000);
expectEq("$200K → 2 defeated", b200.bossesDefeated, 2);
expectEq("$200K → fighting boss 3", b200.level, 3);
expectEq("$200K → $3,000 banked", b200.bonusEarned, 3_000);

// Spec HUD example: "Boss 3 · $27,400 HP left".
const bSpec = bossState(272_600);
expectEq("$272,600 → boss 3", bSpec.level, 3);
expectEq("$272,600 → $27,400 HP left", bSpec.hpLeft, 27_400);
expectEq("$272,600 → 2 bonuses = $3,000", bSpec.bonusEarned, 3_000);

// bonusEarned must be exactly the engine helper for any amount.
for (const v of [0, 1, 99_999, 100_000, 150_000, 349_999, 1_000_000]) {
  expectEq(`bonus parity @ ${v}`, bossState(v).bonusEarned, volumeBonusForMonthRevenue(v));
}

// ── Pace projection ─────────────────────────────────────────────────────
const p = paceProjection(50_000, 10, 20);
expectEq("pace: 50K over 10/20 days → 100K", p.projectedVolume, 100_000);
expectEq("pace: → 1 projected bonus", p.projectedBonuses, 1);
expectEq("pace: day zero → current volume", paceProjection(25_000, 0, 20).projectedVolume, 25_000);
expectEq("pace: elapsed>total clamps", paceProjection(80_000, 25, 20).projectedVolume, 80_000);

// ── Sit bonus (starts on the 4th sit) ────────────────────────────────────
expectEq("0 sits → $0", sitBonusFor(0), 0);
expectEq("3 sits → $0 (threshold)", sitBonusFor(3), 0);
expectEq("4th sit → $50", sitBonusFor(4), 50);
expectEq("10 sits → 7×$50 = $350", sitBonusFor(10), 350);
expectEq("elevated rank 4th sit → $75", sitBonusFor(4, "Captain"), 75);
expectEq("elevated rank 10 sits → 7×$75 = $525", sitBonusFor(10, "Sr. Gold"), 525);

// ── Loot breakdown ────────────────────────────────────────────────────────
const loot = lootLines({
  base_pay: 400,
  ot_premium_pay: 50,
  meal_premium_pay: 10,
  commission: 320,
  sit_bonus: 150,
  monster_bonus: 500,
  volume_bonus: 1_500,
  volume_bonus_ot_true_up: 25,
});
expectEq("loot has 5 lines (no per-appt line)", loot.length, 5);
expectEq("loot base folds clocked components", loot[0].amount, 460);
expectEq("loot base is silver", loot[0].coin, "silver");
expectEq("loot commission is gems", loot.find((l) => l.kind === "commission")?.coin, "gems");
expectEq("loot sit bonus is gold", loot.find((l) => l.kind === "sitBonus")?.coin, "gold");
expectEq(
  "loot volume bonus folds OT true-up",
  loot.find((l) => l.kind === "volumeBonus")?.amount,
  1_525,
);
expectEq("loot total sums every line", lootTotal(loot), 460 + 320 + 150 + 500 + 1_525);
expectEq("empty input → all-zero lines", lootTotal(lootLines({})), 0);

// ── XP & levels ──────────────────────────────────────────────────────────
expectEq(
  "xpFor bag",
  xpFor({ appts: 2, sits: 1, solds: 1, bossesDefeated: 1 }),
  20 + 30 + 100 + 1000,
);
expectEq("cumXp L1 = 0", cumXpForLevel(1), 0);
expectEq("cumXp L2 = 100", cumXpForLevel(2), 100);
expectEq("cumXp L3 = 300", cumXpForLevel(3), 300);
expectEq("cumXp L5 = 1000", cumXpForLevel(5), 1_000);
expectEq("0 XP → level 1", levelForXp(0).level, 1);
expectEq("99 XP → still level 1", levelForXp(99).level, 1);
expectEq("100 XP → level 2", levelForXp(100).level, 2);
expectEq("299 XP → level 2", levelForXp(299).level, 2);
expectEq("300 XP → level 3", levelForXp(300).level, 3);
expectEq("level 1 title", levelForXp(0).title, "Rookie Knocker");
expectEq("150 XP → halfway through level 2", levelForXp(150).pct, 0.25);
expectEq("high XP caps title at last rank", levelForXp(1_000_000).title, "Arcade God");

// ── Badges ────────────────────────────────────────────────────────────────
const noneEarned = evaluateBadges({
  weekSales: 0,
  bestDaySits: 0,
  sitRate: 0,
  sitRateLeads: 0,
  bossesDefeated: 0,
  sitStreakDays: 0,
  vanMvp: false,
});
expectEq("no activity → no badges", noneEarned.size, 0);

const all = evaluateBadges({
  weekSales: 2,
  bestDaySits: 3,
  sitRate: 0.6,
  sitRateLeads: 25,
  bossesDefeated: 1,
  sitStreakDays: 4,
  vanMvp: true,
});
expectEq("full snapshot → all 6 badges", all.size, 6);
expectEq(
  "first sale → First Blood",
  evaluateBadges({ ...base0(), weekSales: 1 }).has("first_blood"),
  true,
);
expectEq(
  "2 sits → no Hat Trick",
  evaluateBadges({ ...base0(), bestDaySits: 2 }).has("hat_trick"),
  false,
);
expectEq(
  "sniper needs 20+ leads",
  evaluateBadges({ ...base0(), sitRate: 0.9, sitRateLeads: 19 }).has("sniper"),
  false,
);
expectEq(
  "sniper 50%+ over 20 leads",
  evaluateBadges({ ...base0(), sitRate: 0.5, sitRateLeads: 20 }).has("sniper"),
  true,
);
expectEq(
  "1-day streak → no On Fire",
  evaluateBadges({ ...base0(), sitStreakDays: 1 }).has("streak"),
  false,
);

function base0() {
  return {
    weekSales: 0,
    bestDaySits: 0,
    sitRate: 0,
    sitRateLeads: 0,
    bossesDefeated: 0,
    sitStreakDays: 0,
    vanMvp: false,
  };
}

// ── Hat Trick range (bestDaySits) ───────────────────────────────────────
// The Hat Trick must check the SELECTED range, not just today: the best single
// day inside the window, same-day office rows summed, out-of-range days ignored.
const week = [
  { date: "2026-10-05", sits: 1 }, // Monday
  { date: "2026-10-05", sits: 2 }, // same day, second office → sums to 3
  { date: "2026-10-07", sits: 2 }, // Wednesday
  { date: "2026-10-10", sits: 5 }, // Saturday — but outside a Mon–Fri window below
];
expectEq("best day sums same-day office rows", bestDaySits(week, "2026-10-05", "2026-10-11"), 5);
expectEq(
  "Hat Trick fires on a prior day in range",
  bestDaySits(week, "2026-10-05", "2026-10-07"),
  3,
);
expectEq("out-of-range days excluded", bestDaySits(week, "2026-10-06", "2026-10-07"), 2);
expectEq("empty range → 0", bestDaySits(week, "2026-11-01", "2026-11-30"), 0);
expectEq("no rows → 0", bestDaySits([], "2026-10-01", "2026-10-31"), 0);
expectEq(
  "3+ on any single day in range lights Hat Trick",
  evaluateBadges({ ...base0(), bestDaySits: bestDaySits(week, "2026-10-05", "2026-10-07") }).has(
    "hat_trick",
  ),
  true,
);

// ── Sit rate grades ─────────────────────────────────────────────────────
expectEq("no leads → null rate", sitRate(0, 0).rate, null);
expectEq("no leads → null grade", sitRate(0, 0).grade, null);
expectEq("11/20 = 55% → S", sitRate(11, 20).grade, "S");
expectEq("9/20 = 45% → A", sitRate(9, 20).grade, "A");
expectEq("7/20 = 35% → B", sitRate(7, 20).grade, "B");
expectEq("5/20 = 25% → C", sitRate(5, 20).grade, "C");
expectEq("4/20 = 20% → D", sitRate(4, 20).grade, "D");

console.log(`\n${failures === 0 ? "✅" : "❌"} ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
