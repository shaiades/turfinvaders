// What-Changed engine verification (owner 2026-10-01): every detector's
// AND-gates, the ranking cap, and the digest composition as executable
// checks. Run: npm run verify:deviations

import {
  composeDigest,
  detectDoorSag,
  detectOfficeCancelSpike,
  detectPaymentAging,
  detectRepCloseCollapse,
  detectVanLeadSag,
  rankDeviations,
} from "../src/lib/deviations";

const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = Math.abs(Number(got ?? NaN) - Number(want ?? NaN)) < 1e-6 || got === want;
  if (!ok) fails.push(`${label}: got ${String(got)}, want ${String(want)}`);
};

// ---- Van sag: magnitude AND base-rate AND active-days -------------------
{
  const base = { baselinePerDay: 9.2, activeDaysThisWeek: 4, leadValue: 300 };
  eq(
    "van: -57% fires",
    detectVanLeadSag([{ name: "Miguel", currentPerDay: 4, ...base }]).length,
    1,
  );
  eq(
    "van: -20% stays quiet",
    detectVanLeadSag([{ name: "A", currentPerDay: 7.4, ...base }]).length,
    0,
  );
  eq(
    "van: low-volume van never fires",
    detectVanLeadSag([
      { name: "B", baselinePerDay: 3, currentPerDay: 0.5, activeDaysThisWeek: 4, leadValue: 300 },
    ]).length,
    0,
  );
  eq(
    "van: one active day proves nothing",
    detectVanLeadSag([
      { name: "C", baselinePerDay: 9, currentPerDay: 1, activeDaysThisWeek: 1, leadValue: 300 },
    ]).length,
    0,
  );
  const up = detectVanLeadSag([{ name: "D", currentPerDay: 14, ...base }]);
  eq("van: a surge fires too (slope cuts both ways)", up.length, 1);
}

// ---- Rep close collapse ---------------------------------------------------
{
  const fire = detectRepCloseCollapse([
    { name: "Jake", baseSits: 30, baseSold: 9, curSits: 17, curSold: 2, avgTicket: 24000 },
  ]); // 30% → 11.8%: abs 18pts, rel 61%
  eq("rep: collapse fires", fire.length, 1);
  eq(
    "rep: small drop quiet (abs gate)",
    detectRepCloseCollapse([
      { name: "A", baseSits: 30, baseSold: 9, curSits: 20, curSold: 5, avgTicket: 24000 },
    ]).length,
    0,
  );
  eq(
    "rep: thin sits never rank",
    detectRepCloseCollapse([
      { name: "B", baseSits: 30, baseSold: 9, curSits: 5, curSold: 0, avgTicket: 24000 },
    ]).length,
    0,
  );
  eq(
    "rep: high closer small relative drop quiet (rel gate)",
    detectRepCloseCollapse([
      // 50% → 36%: abs 14pts fires the abs gate, rel 28% < 40% stays quiet.
      { name: "C", baseSits: 40, baseSold: 20, curSits: 25, curSold: 9, avgTicket: 24000 },
    ]).length,
    0,
  );
}

// ---- Office cancel spike ----------------------------------------------------
{
  eq(
    "cancel: +7.7pts & $142K fires",
    detectOfficeCancelSpike([
      { office: "OC", mtdCancel: 142_000, mtdGross: 751_000, baselinePct: 0.112 },
    ]).length,
    1,
  );
  eq(
    "cancel: +3pts quiet",
    detectOfficeCancelSpike([
      { office: "SD", mtdCancel: 100_000, mtdGross: 700_000, baselinePct: 0.113 },
    ]).length,
    0,
  );
  eq(
    "cancel: small dollars quiet even at +10pts",
    detectOfficeCancelSpike([
      { office: "SD", mtdCancel: 30_000, mtdGross: 150_000, baselinePct: 0.1 },
    ]).length,
    0,
  );
  eq(
    "cancel: no baseline, no verdict",
    detectOfficeCancelSpike([
      { office: "SD", mtdCancel: 90_000, mtdGross: 300_000, baselinePct: null },
    ]).length,
    0,
  );
}

// ---- Door sag ---------------------------------------------------------------
{
  eq(
    "doors: era too young stays silent",
    detectDoorSag({
      baselinePerRepDay: 120,
      currentPerRepDay: 60,
      baselineWeeks: 2,
      dollarPerDoor: 100,
    }).length,
    0,
  );
  eq(
    "doors: -33% with 3 baseline weeks fires",
    detectDoorSag({
      baselinePerRepDay: 120,
      currentPerRepDay: 80,
      baselineWeeks: 3,
      dollarPerDoor: 100,
    }).length,
    1,
  );
}

// ---- Payment aging: fires only in the 14–20 day crossing window -------------
{
  const rows = (late: number) => [
    {
      customer: "Hernandez",
      remaining: 28_000,
      anticipated_date: `2026-09-${String(30 - late).padStart(2, "0")}`,
    },
  ];
  eq("aging: 15d fires", detectPaymentAging(rows(15), "2026-09-30").length, 1);
  eq("aging: 13d not yet", detectPaymentAging(rows(13), "2026-09-30").length, 0);
  eq(
    "aging: 22d already fired its week — silent",
    detectPaymentAging(rows(22), "2026-09-30").length,
    0,
  );
  eq(
    "aging: settled rows never fire",
    detectPaymentAging(
      [{ customer: "X", remaining: 0, anticipated_date: "2026-09-10" }],
      "2026-09-30",
    ).length,
    0,
  );
}

// ---- Ranking + digest ---------------------------------------------------------
{
  const ranked = rankDeviations(
    Array.from({ length: 9 }, (_, i) => ({
      key: `k${i}`,
      line: `d${i}`,
      dollars: i * 1000,
      to: "/god-mode",
    })),
  );
  eq("rank: capped at 5", ranked.length, 5);
  eq("rank: dollars first", ranked[0].key, "k8");

  const digest = composeDigest({
    yesterday: { banked: 41_000, soldBook: 86_000, leads: 29, doors: 1_240 },
    today: { dueAmount: 52_000, duePayments: 3, overdueBacklog: 106_000 },
    deviations: [],
    staleFlaggedPunches: null,
  });
  eq("digest: 3 lines when clean", digest.body.split("\n").length, 3);
  eq("digest: all-clear is information", digest.body.includes("No deviations."), true);
  eq("digest: yesterday leads with cash", digest.body.startsWith("Yesterday: $41K banked"), true);

  const busy = composeDigest({
    yesterday: { banked: 41_000, soldBook: 86_000, leads: 29, doors: 1_240 },
    today: { dueAmount: 52_000, duePayments: 3, overdueBacklog: 0 },
    deviations: [
      { key: "a", line: "A line", dollars: 3, to: "/" },
      { key: "b", line: "B line", dollars: 2, to: "/" },
      { key: "c", line: "C line", dollars: 1, to: "/" },
      { key: "d", line: "D line", dollars: 0, to: "/" },
    ],
    staleFlaggedPunches: { count: 137, oldestDays: 9 },
  });
  const lines = busy.body.split("\n");
  eq("digest: hard cap 5 lines", lines.length, 5);
  eq("digest: deviations verbatim", lines[2], "A line");
  eq("digest: punches escalation owns a slot", lines[4].includes("flagged punches"), true);
  eq("digest: no backlog clause when zero", lines[1].includes("backlog"), false);
}

console.log(`checks run, ${fails.length} failure(s)`);
for (const f of fails) console.log("  FAIL " + f);
process.exit(fails.length === 0 ? 0 : 1);
