// Weekly Action Plan verification suite (owner directive 2026-10-01).
// Run:  npm run verify:plan   (or: npx tsx scripts/verify-action-plan.ts)
//
// Pure modules in, assertions out — no network, no database, no browser.
// Exits non-zero on any failure. Extend it whenever a plan rule changes.

import {
  buildProductionJobRow,
  classifyHomeownerNotes,
  effectiveHomeownerStatus,
  splitNames,
  zipFromAddress,
  PRODUCTION_GROUPS,
  type NoteEntry,
} from "../src/lib/production-jobs";
import {
  ACTION_PLAN_CONFIG,
  availableReloads,
  buildWeeklyPlan,
  classifyJobTimeline,
  clusterJobs,
  phaseForTimeline,
  pinForJob,
  planVisitSlots,
  scoreJob,
  type PlanJob,
} from "../src/lib/action-plan";
import { planWeekStartISO } from "../src/lib/dates";

const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (got !== want) fails.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const ok = (label: string, cond: boolean) => {
  if (!cond) fails.push(label);
};

const TODAY = "2026-10-05"; // a Monday
const note = (body: string, daysAgo: number, creator = "Production PM"): NoteEntry => ({
  body,
  created_at: `${addDays(TODAY, -daysAgo)}T16:00:00.000Z`,
  creator,
});
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

// ---- 1. Homeowner classifier --------------------------------------------

// Anonymized tile-dispute thread (modeled on a real Production update,
// trigger phrases preserved): cost dispute + flat refusal + escalation to
// the principals → at_risk.
const tileDispute = [
  note(
    "HO: Said they are waiting on the tiles to come in, told them the ordered tiles are correct and will not get changed unless the manufacturer switches them. HO was told he would have to pay for the switch if the manufacturer won't help us, HO said he will not being doing this. Going to have Tyler call today",
    1,
  ),
  note("LVM for HO: Pending rep to go out there to get the selection", 9),
];
eq("tile dispute → at_risk", classifyHomeownerNotes(tileDispute, TODAY).status, "at_risk");
ok(
  "tile dispute reason mentions a category",
  (classifyHomeownerNotes(tileDispute, TODAY).reason ?? "").startsWith("Notes mention:"),
);
eq(
  "tile dispute note date = newest deciding note",
  classifyHomeownerNotes(tileDispute, TODAY).noteDate,
  addDays(TODAY, -1),
);
// Smart punctuation (iOS types ’): the same refusal must still hit.
eq(
  "curly apostrophe refusal → at_risk",
  classifyHomeownerNotes([note("HO won’t pay for the switch, he’s done", 1)], TODAY).status,
  "at_risk",
);
// A routine staff "thanks" sign-off must NOT reset a strong signal below it.
eq(
  "thanks sign-off doesn't bury the refund demand",
  classifyHomeownerNotes(
    [note("Confirmed schedule with the crew, will follow up. Thanks", 1), note("HO wants a refund", 3)],
    TODAY,
  ).status,
  "at_risk",
);
// Negation window stops at clause punctuation: the lawyer is real.
eq(
  "clause break keeps the legal threat",
  classifyHomeownerNotes([note("Didn't pay yet, says lawyer is involved", 1)], TODAY).status,
  "at_risk",
);
// Evening PT note (next-day UTC): still counted on its LA date.
eq(
  "evening PT note stays in window",
  classifyHomeownerNotes(
    [
      {
        body: "HO says he is calling his attorney",
        created_at: `${addDays(TODAY, 1)}T01:30:00.000Z`, // same LA evening
        creator: "Production PM",
      },
    ],
    TODAY,
  ).status,
  "at_risk",
);

// Negation: "no complaints" is NOT a complaint.
eq(
  "negated 'no complaints' → neutral",
  classifyHomeownerNotes([note("Walked the job, no complaints from the HO", 1)], TODAY).status,
  "neutral",
);
eq(
  "'not upset' → neutral",
  classifyHomeownerNotes([note("HO was not upset about the delay", 2)], TODAY).status,
  "neutral",
);

// One weak negative note alone never flips at_risk (threshold needs 2 notes).
eq(
  "single weak negative → neutral",
  classifyHomeownerNotes([note("HO seemed frustrated about scheduling", 1)], TODAY).status,
  "neutral",
);
// Two negative notes clear the threshold.
eq(
  "two negative notes → at_risk",
  classifyHomeownerNotes(
    [note("HO upset about the mess the crew left", 1), note("HO complained about the crew being late", 3)],
    TODAY,
  ).status,
  "at_risk",
);
// A strong signal alone is enough.
eq(
  "attorney mention → at_risk",
  classifyHomeownerNotes([note("HO says he is calling his attorney", 2)], TODAY).status,
  "at_risk",
);
// A newer clear positive closes the episode.
eq(
  "resolved after dispute → not at_risk",
  classifyHomeownerNotes(
    [
      note("Spoke with HO, all good now, happy with the fix", 1),
      note("HO upset about the crew being late", 3),
      note("HO complained about damage to a planter", 4),
    ],
    TODAY,
  ).status === "at_risk",
  false as never,
);
// Positive-only thread → happy.
eq(
  "praise thread → happy",
  classifyHomeownerNotes(
    [note("HO is thrilled, says the roof looks great", 1), note("HO thanked the crew", 4)],
    TODAY,
  ).status,
  "happy",
);
// Automation authors are ignored.
eq(
  "automation note ignored",
  classifyHomeownerNotes([note("Status changed to Cancelled by automation", 1, "Monday Automations")], TODAY)
    .status,
  "neutral",
);
// Stale notes outside the 14-day window are ignored.
eq(
  "old attorney note outside window → neutral",
  classifyHomeownerNotes([note("HO says he is calling his attorney", 20)], TODAY).status,
  "neutral",
);

// ---- 2. Override staleness ----------------------------------------------

const autoRisk = { homeowner_status: "at_risk" as const, homeowner_status_note_date: "2026-10-01" };
eq(
  "override wins while no newer note",
  effectiveHomeownerStatus(autoRisk, { homeowner_status: "happy", based_on_note_date: "2026-10-02" })
    .status,
  "happy",
);
const staleCase = effectiveHomeownerStatus(
  { homeowner_status: "at_risk", homeowner_status_note_date: "2026-10-03" },
  { homeowner_status: "happy", based_on_note_date: "2026-10-01" },
);
eq("newer note reverts to auto", staleCase.status, "at_risk");
eq("newer note flags stale", staleCase.source, "stale_override");

// ---- 3. Plan week (Sunday shows the upcoming week) ----------------------

// 2026-10-04 is a Sunday; 2026-10-05 the Monday after.
eq("Sunday → next Monday", planWeekStartISO(new Date("2026-10-04T20:00:00-07:00")), "2026-10-05");
eq("Monday → same week", planWeekStartISO(new Date("2026-10-05T09:00:00-07:00")), "2026-10-05");
eq("Saturday → current week", planWeekStartISO(new Date("2026-10-10T09:00:00-07:00")), "2026-10-05");
// DST fall-back week (Nov 1 2026 is the change; Sun Nov 1 → Mon Nov 2).
eq("DST Sunday → next Monday", planWeekStartISO(new Date("2026-11-01T20:00:00-08:00")), "2026-11-02");
// UTC-evening trap: Sunday 8 PM PT is Monday UTC — still the upcoming Monday.
eq(
  "Sunday late evening PT",
  planWeekStartISO(new Date("2026-10-05T03:00:00Z")), // Sun 2026-10-04 8 PM PDT
  "2026-10-05",
);

// ---- 4. Job states + mismatch rules -------------------------------------

const baseJob = (over: Partial<PlanJob>): PlanJob => ({
  monday_item_id: over.monday_item_id ?? "1",
  group_id: PRODUCTION_GROUPS.inProgress,
  group_title: "In Progress",
  homeowner_name: "Test, Homeowner",
  reps: ["Josh OConnor"],
  pm_name: "Zuleyma Hernandez",
  projects: "Roof",
  reloads: null,
  reloaded: null,
  advantage_plus: false,
  address: "123 Main St, San Diego, CA 92126, USA",
  lat: null,
  lng: null,
  zip: "92126",
  sale_amount: 20000,
  schedule_start: null,
  schedule_end: null,
  prev_schedule_start: null,
  prev_schedule_end: null,
  completion_date: null,
  delayed_until: null,
  status_label: "In Progress",
  reviews_status: null,
  referral_status: null,
  homeowner_status: "neutral",
  homeowner_status_reason: null,
  homeowner_status_note_date: null,
  ...over,
});

const queue = (over: Partial<PlanJob>) =>
  baseJob({ group_id: PRODUCTION_GROUPS.queueToStart, group_title: "Queue To Start", ...over });

eq(
  "queue start in 3 days → starting_soon",
  classifyJobTimeline(queue({ schedule_start: addDays(TODAY, 3) }), TODAY).state,
  "starting_soon",
);
eq(
  "queue start in 8 days → upcoming_tbd",
  classifyJobTimeline(queue({ schedule_start: addDays(TODAY, 8) }), TODAY).state,
  "upcoming_tbd",
);
eq("queue no date → upcoming_tbd", classifyJobTimeline(queue({}), TODAY).state, "upcoming_tbd");
{
  const t = classifyJobTimeline(
    queue({ schedule_start: addDays(TODAY, -2), schedule_end: addDays(TODAY, 5) }),
    TODAY,
  );
  eq("queue start passed → active", t.state, "active");
  ok("queue start passed → chip", t.chips.some((c) => c.includes("not moved")));
  eq("queue start passed → Day 3", t.dayX, 3);
}
{
  const t = classifyJobTimeline(baseJob({}), TODAY);
  eq("in progress null timeline → active", t.state, "active");
  ok("null timeline chip", t.chips.some((c) => c.includes("Schedule TBD")));
}
{
  const t = classifyJobTimeline(
    baseJob({ schedule_start: addDays(TODAY, -3), schedule_end: addDays(TODAY, -1) }),
    TODAY,
  );
  eq("past end → finishing", t.state, "finishing");
  ok("past end chip", t.chips.some((c) => c.includes("Past scheduled end")));
}
{
  const t = classifyJobTimeline(baseJob({ schedule_start: addDays(TODAY, -4) }), TODAY);
  eq("start without end → active", t.state, "active");
  eq("start without end → Day 5", t.dayX, 5);
  eq("start without end → Y unknown", t.dayY, null);
  ok("end TBD chip", t.chips.some((c) => c.includes("End date TBD")));
}
{
  const d = addDays(TODAY, 1);
  const t = classifyJobTimeline(
    baseJob({ schedule_start: d, schedule_end: d, projects: "Patio Cover, Pavers" }),
    TODAY,
  );
  eq("from==to multi-project → end dropped", t.dayY, null);
  ok("from==to chip", t.chips.some((c) => c.includes("1-day schedule")));
}
eq(
  "cancelled status → excluded",
  classifyJobTimeline(baseJob({ status_label: "Cancelled" }), TODAY).state,
  "excluded",
);
eq(
  "delayed group → paused",
  classifyJobTimeline(
    baseJob({ group_id: PRODUCTION_GROUPS.delayed, group_title: "Delayed" }),
    TODAY,
  ).state,
  "paused",
);
{
  const completed = (done: string | null, over: Partial<PlanJob> = {}) =>
    classifyJobTimeline(
      baseJob({
        group_id: PRODUCTION_GROUPS.completed,
        group_title: "Completed",
        completion_date: done,
        ...over,
      }),
      TODAY,
    );
  eq("completed yesterday → just_completed", completed(addDays(TODAY, -1)).state, "just_completed");
  eq("completed 2 days ago (48h) → just_completed", completed(addDays(TODAY, -2)).state, "just_completed");
  eq("completed 3 days ago → post", completed(addDays(TODAY, -3)).state, "post");
  eq("completed 7 days ago → post", completed(addDays(TODAY, -7)).state, "post");
  eq("completed 8 days ago → excluded", completed(addDays(TODAY, -8)).state, "excluded");
  const est = completed(null, { schedule_end: addDays(TODAY, -1) });
  eq("completed no date falls back to schedule_end", est.state, "just_completed");
  ok("estimated completion chip", est.chips.some((c) => c.includes("estimated")));
}
{
  const t = classifyJobTimeline(
    baseJob({
      schedule_start: addDays(TODAY, -2),
      schedule_end: addDays(TODAY, 4),
      prev_schedule_start: addDays(TODAY, -9),
      prev_schedule_end: addDays(TODAY, -2),
    }),
    TODAY,
  );
  ok("reschedule chip", t.chips.some((c) => c.startsWith("Rescheduled")));
}

// Final-day boundary: remaining 1 → finishing; remaining 2 → active.
eq(
  "remaining 1 day → finishing",
  classifyJobTimeline(
    baseJob({ schedule_start: addDays(TODAY, -5), schedule_end: addDays(TODAY, 1) }),
    TODAY,
  ).state,
  "finishing",
);
eq(
  "remaining 2 days → active",
  classifyJobTimeline(
    baseJob({ schedule_start: addDays(TODAY, -5), schedule_end: addDays(TODAY, 2) }),
    TODAY,
  ).state,
  "active",
);

// ---- 5. Phases -----------------------------------------------------------

const tl = (start: number, end: number) =>
  classifyJobTimeline(
    baseJob({ schedule_start: addDays(TODAY, start), schedule_end: addDays(TODAY, end) }),
    TODAY,
  );
eq("day 1 of 9 → day1", phaseForTimeline(tl(0, 8)), "day1");
eq("day 3 of 9 → early", phaseForTimeline(tl(-2, 6)), "early");
eq("day 5 of 9 → middle", phaseForTimeline(tl(-4, 4)), "middle");
eq("day 8 of 9 → late", phaseForTimeline(tl(-7, 1)) === "late" || phaseForTimeline(tl(-7, 1)) === "final", true);
eq("final day → final", phaseForTimeline(tl(-8, 0)), "final");
// 2-day job: day 1 then merged early/middle→final.
eq("2-day job day 1 → day1", phaseForTimeline(tl(0, 1)), "day1");

// ---- 6. Pins + at-risk precedence ---------------------------------------

const AT_RISK = { status: "at_risk" as const, source: "auto" as const };
const NEUTRAL = { status: "neutral" as const, source: "auto" as const };

{
  // At-risk + gutters reload starting in 3 days → recovery wins, never the
  // reload label (spec §6: no asks on a recovery visit).
  const job = queue({ schedule_start: addDays(TODAY, 3), reloads: "Gutters" });
  const t = classifyJobTimeline(job, TODAY);
  eq("at-risk + reload → recovery pin", pinForJob(job, t, AT_RISK, TODAY)?.kind, "recovery");
  eq("neutral + reload → reload pin", pinForJob(job, t, NEUTRAL, TODAY)?.kind, "pre_start_reload");
  eq(
    "reload pin label",
    pinForJob(job, t, NEUTRAL, TODAY)?.label,
    "Job about to start: reload gutters or insulation",
  );
}
{
  // Reload already sold (Reloaded column) → no reload pin.
  const job = queue({ schedule_start: addDays(TODAY, 3), reloads: "Gutters", reloaded: "Gutters" });
  eq(
    "reloaded gutters → no pin",
    pinForJob(job, classifyJobTimeline(job, TODAY), NEUTRAL, TODAY),
    null,
  );
  eq("availableReloads nets out", availableReloads(job).length, 0);
}
{
  // At-risk on the final day → recovery, not the capture pin.
  const job = baseJob({ schedule_start: addDays(TODAY, -5), schedule_end: TODAY });
  const t = classifyJobTimeline(job, TODAY);
  eq("final day neutral → capture pin", pinForJob(job, t, NEUTRAL, TODAY)?.kind, "capture");
  eq("final day at-risk → recovery pin", pinForJob(job, t, AT_RISK, TODAY)?.kind, "recovery");
}

// ---- 7. Score ------------------------------------------------------------

{
  // Max-out: Advantage+ (25) + 2 reloads (25) + happy (15) + ≥30k (15) +
  // final day (10) + 2 neighbors (10) = 100.
  const job = baseJob({
    advantage_plus: true,
    reloads: "Gutters, Insulation",
    sale_amount: 35000,
    schedule_start: addDays(TODAY, -5),
    schedule_end: TODAY,
  });
  const t = classifyJobTimeline(job, TODAY);
  eq("max score = 100", scoreJob(job, t, { status: "happy", source: "auto" }, 2), 100);
  eq("at-risk forfeits status points", scoreJob(job, t, AT_RISK, 2), 85);
}
{
  const job = baseJob({ sale_amount: 5000, schedule_start: addDays(TODAY, -1), schedule_end: addDays(TODAY, 18) });
  const t = classifyJobTimeline(job, TODAY);
  // neutral 8 + tier 5 + days-remaining 0 (18 ≥ horizon) + no extras = 13.
  eq("low score floor", scoreJob(job, t, NEUTRAL, 0), 13);
}

// ---- 8. Clustering -------------------------------------------------------

// Spec example: 3 jobs in 92127, 1 in 92111 → the three together, 92127 label.
const RB = { lat: 33.02, lng: -117.12 }; // 92127-ish
const CLRMT = { lat: 32.83, lng: -117.16 }; // 92111-ish
{
  const clusters = clusterJobs([
    { id: "a", lat: RB.lat, lng: RB.lng, zip: "92127", address: null, score: 40, pinned: false },
    { id: "b", lat: RB.lat + 0.01, lng: RB.lng, zip: "92127", address: null, score: 30, pinned: false },
    { id: "c", lat: RB.lat, lng: RB.lng + 0.01, zip: "92127", address: null, score: 20, pinned: false },
    { id: "d", lat: CLRMT.lat, lng: CLRMT.lng, zip: "92111", address: null, score: 90, pinned: false },
  ]);
  eq("two clusters", clusters.length, 2);
  const big = clusters.find((c) => c.jobIds.length === 3);
  eq("spec cluster label", big?.label, "92127");
  // 40+30+20 + 2×5 bonus = 100 > 90 → the trio outranks the lone high scorer.
  eq("trio ordered first", clusters[0]?.jobIds.length, 3);
}
{
  // Chain fixture: 4 jobs each ~2.4mi apart in a line must NOT all merge
  // (centroid-radius, not single-link). 2.4 mi ≈ 0.0347° latitude.
  const step = 0.0347;
  const clusters = clusterJobs(
    [0, 1, 2, 3].map((i) => ({
      id: String(i),
      lat: 33 + step * i,
      lng: -117,
      zip: null,
      address: null,
      score: 10,
      pinned: false,
    })),
  );
  ok("chain does not collapse to one cluster", clusters.length >= 2);
}
{
  // Pinned-containing cluster goes first even with a lower score.
  const clusters = clusterJobs([
    { id: "pin", lat: RB.lat, lng: RB.lng, zip: "92127", address: null, score: 10, pinned: true },
    { id: "big", lat: CLRMT.lat, lng: CLRMT.lng, zip: "92111", address: null, score: 90, pinned: false },
  ]);
  eq("pinned cluster first", clusters[0]?.jobIds[0], "pin");
}
{
  // Coordinate-less jobs fall back to ZIP grouping.
  const clusters = clusterJobs([
    { id: "x", lat: null, lng: null, zip: "92127", address: null, score: 10, pinned: false },
    { id: "y", lat: null, lng: null, zip: "92127", address: null, score: 10, pinned: false },
    { id: "z", lat: null, lng: null, zip: null, address: "456 Gold Coast Dr, San Diego", score: 5, pinned: false },
  ]);
  eq("zip fallback groups two", clusters.find((c) => c.label === "92127")?.jobIds.length, 2);
}

// ---- 9. Visit agenda -----------------------------------------------------

{
  // Job starting Tuesday with a gutters reload: Monday carries the reload
  // slot (the [start−5, start−1] window ∩ the week), Tuesday carries Day 1.
  const job = queue({ schedule_start: addDays(TODAY, 1), reloads: "Insulation" });
  const t = classifyJobTimeline(job, TODAY);
  const slots = planVisitSlots(
    [{ job, timeline: t, effective: NEUTRAL, pin: pinForJob(job, t, NEUTRAL, TODAY) }],
    TODAY,
    TODAY,
  );
  eq(
    "Monday reload slot",
    slots.find((s) => s.dateISO === TODAY)?.label,
    "Job about to start: reload gutters or insulation",
  );
  eq("Tuesday day-1 slot", slots.find((s) => s.dateISO === addDays(TODAY, 1))?.phase, "day1");
}
{
  // At-risk job: exactly one recovery slot, nothing else.
  const job = baseJob({ schedule_start: addDays(TODAY, -2), schedule_end: addDays(TODAY, 4) });
  const t = classifyJobTimeline(job, TODAY);
  const slots = planVisitSlots([{ job, timeline: t, effective: AT_RISK, pin: null }], TODAY, TODAY);
  eq("one recovery slot", slots.length, 1);
  eq("recovery slot phase", slots[0]?.phase, "recovery");
}
{
  // Multi-week active job: capped spread visits.
  const job = baseJob({ schedule_start: addDays(TODAY, -10), schedule_end: addDays(TODAY, 20) });
  const t = classifyJobTimeline(job, TODAY);
  const slots = planVisitSlots([{ job, timeline: t, effective: NEUTRAL, pin: null }], TODAY, TODAY);
  ok(
    `long job ≤ ${ACTION_PLAN_CONFIG.longJobVisitsPerWeek} visits (got ${slots.length})`,
    slots.length <= ACTION_PLAN_CONFIG.longJobVisitsPerWeek && slots.length >= 2,
  );
}
{
  // Past-scheduled-end job (crew never moved the timeline): exactly one
  // ASAP walkthrough slot — it must not vanish from the week strip.
  const job = baseJob({ schedule_start: addDays(TODAY, -8), schedule_end: addDays(TODAY, -2) });
  const t = classifyJobTimeline(job, TODAY);
  const slots = planVisitSlots([{ job, timeline: t, effective: NEUTRAL, pin: null }], TODAY, TODAY);
  eq("past-end job gets one slot", slots.length, 1);
  eq("past-end slot is today", slots[0]?.dateISO, TODAY);
  ok("past-end slot says walkthrough", (slots[0]?.label ?? "").includes("Past scheduled end"));
}
{
  // Pre-start window produces ONE visit, not one per day: a Saturday start
  // (anchor Monday) puts a single pre-start slot on Monday + Day 1 Saturday.
  const job = queue({ schedule_start: addDays(TODAY, 5), reloads: "Gutters" });
  const t = classifyJobTimeline(job, TODAY);
  const slots = planVisitSlots(
    [{ job, timeline: t, effective: NEUTRAL, pin: pinForJob(job, t, NEUTRAL, TODAY) }],
    TODAY,
    TODAY,
  );
  eq("pre-start = 1 reload slot + day 1", slots.length, 2);
  eq("single reload slot lands on Monday", slots[0]?.dateISO, TODAY);
}
{
  // 1-day job today: the final slot covers the date — no duplicate Day 1.
  const job = baseJob({ schedule_start: TODAY, schedule_end: TODAY });
  const t = classifyJobTimeline(job, TODAY);
  const slots = planVisitSlots([{ job, timeline: t, effective: NEUTRAL, pin: null }], TODAY, TODAY);
  eq("1-day job: one final slot", slots.filter((s) => s.phase === "final").length, 1);
  eq("1-day job: no day1 duplicate", slots.filter((s) => s.phase === "day1").length, 0);
}

// ---- 10. buildWeeklyPlan end-to-end + Sunday parity ----------------------

const fleet: PlanJob[] = [
  baseJob({
    monday_item_id: "active1",
    reps: ["Josh OConnor", "Yakup Sancakli"],
    schedule_start: addDays(TODAY, -3),
    schedule_end: addDays(TODAY, 4),
    lat: RB.lat,
    lng: RB.lng,
    zip: "92127",
  }),
  queue({
    monday_item_id: "soon1",
    reps: ["Josh OConnor"],
    schedule_start: addDays(TODAY, 2),
    reloads: "Gutters",
    lat: RB.lat + 0.01,
    lng: RB.lng,
    zip: "92127",
  }),
  queue({ monday_item_id: "tbd1", reps: ["Josh OConnor"] }),
  baseJob({
    monday_item_id: "paused1",
    reps: ["Josh OConnor"],
    group_id: PRODUCTION_GROUPS.delayed,
    group_title: "Delayed",
  }),
  baseJob({ monday_item_id: "other1", reps: ["Edward Romero"] }),
  baseJob({
    monday_item_id: "risk1",
    reps: ["Josh OConnor"],
    schedule_start: addDays(TODAY, -1),
    schedule_end: addDays(TODAY, 5),
    homeowner_status: "at_risk",
    homeowner_status_reason: "Notes mention: refusal",
    homeowner_status_note_date: addDays(TODAY, -1),
    lat: CLRMT.lat,
    lng: CLRMT.lng,
    zip: "92111",
  }),
];
const isJosh = (rep: string) => rep.toLowerCase().includes("josh");
const plan = buildWeeklyPlan({
  jobs: fleet,
  overrides: new Map(),
  isMine: isJosh,
  anchorISO: TODAY,
  planWeekStart: TODAY,
});
eq("my actionable jobs", plan.jobs.length, 3);
eq("paused section", plan.paused.length, 1);
eq("upcoming TBD section", plan.upcomingTbd.length, 1);
ok("other rep's job excluded", !plan.jobs.some((j) => j.job.monday_item_id === "other1"));
{
  const shared = plan.jobs.find((j) => j.job.monday_item_id === "active1");
  eq("shared with partner", shared?.sharedWith[0], "Yakup Sancakli");
}
{
  const risk = plan.jobs.find((j) => j.job.monday_item_id === "risk1");
  eq("at-risk pinned recovery", risk?.pin?.kind, "recovery");
  eq("at-risk suppresses asks", risk?.suppressedAsks?.length, 5);
  eq("at-risk guide has no asks", risk?.guide.title, "Recovery visit");
  eq("at-risk hides reload pills", risk?.reloadsAvailable.length, 0);
}
{
  const soon = plan.jobs.find((j) => j.job.monday_item_id === "soon1");
  eq("pre-start reload pinned", soon?.pin?.kind, "pre_start_reload");
}
ok("pinned jobs sort first", plan.jobs[0]?.pin !== null);
ok("route has 1-2 clusters", plan.route.length >= 1 && plan.route.length <= 2);
ok(
  "at-risk cluster leads the route",
  plan.route[0]?.hasPinned === true,
);
ok("agenda has slots", plan.agenda.length > 0);

// Sunday parity: the same anchor (Monday) must produce the same plan a
// Sunday viewer sees — the UI derives anchorISO from planWeekStartISO.
const sundayPlan = buildWeeklyPlan({
  jobs: fleet,
  overrides: new Map(),
  isMine: isJosh,
  anchorISO: planWeekStartISO(new Date("2026-10-04T18:00:00-07:00")), // Sunday → Monday
  planWeekStart: planWeekStartISO(new Date("2026-10-04T18:00:00-07:00")),
});
eq("Sunday == Monday plan (jobs)", JSON.stringify(sundayPlan.jobs), JSON.stringify(plan.jobs));
eq("Sunday == Monday plan (agenda)", JSON.stringify(sundayPlan.agenda), JSON.stringify(plan.agenda));

// Overrides flow: leadership marking risk1 happy un-pins it.
const overridden = buildWeeklyPlan({
  jobs: fleet,
  overrides: new Map([
    ["risk1", { homeowner_status: "happy" as const, based_on_note_date: addDays(TODAY, -1) }],
  ]),
  isMine: isJosh,
  anchorISO: TODAY,
  planWeekStart: TODAY,
});
eq(
  "override clears recovery pin",
  overridden.jobs.find((j) => j.job.monday_item_id === "risk1")?.pin,
  null,
);

// ---- 11. Row-builder spot checks ----------------------------------------

eq("zip from address", zipFromAddress("8953 Gold Coast Dr, San Diego, CA 92126, USA"), "92126");
eq("zip missing", zipFromAddress("somewhere with no zip"), null);
eq("splitNames dedupes", splitNames("Josh OConnor, josh oconnor , Yakup Sancakli").length, 2);
{
  const row = buildProductionJobRow(
    {
      id: 12961873358,
      name: "Wimmer, Sue & Brian",
      group: { id: PRODUCTION_GROUPS.inProgress, title: "In Progress" },
      column_values: [
        { id: "people5", text: "Josh OConnor, Yakup Sancakli", persons_and_teams: [{ id: "1", kind: "person" }, { id: "2", kind: "person" }] },
        { id: "people", text: "Zuleyma Hernandez", persons_and_teams: [{ id: "62003092", kind: "person" }, { id: "9", kind: "team" }] },
        { id: "timeline", text: "2026-09-29 - 2026-10-10", from: "2026-09-29", to: "2026-10-10" },
        { id: "dropdown", text: "Patio Cover, Pavers" },
        { id: "dropdown4", text: "Stucco/Paint" },
        { id: "color_mkwkb083", text: "Advantage+" },
        { id: "location", text: "12274 Lomica Drive, San Diego, CA 92128, USA", lat: "32.99", lng: "-117.07" },
        { id: "numbers", text: "35500" },
        { id: "status", text: "In Progress" },
      ],
    },
    "4300880129",
  );
  eq("row reps", row.reps.length, 2);
  eq("row pm ids drop teams", row.pm_monday_ids.length, 1);
  eq("row schedule start", row.schedule_start, "2026-09-29");
  eq("row schedule end", row.schedule_end, "2026-10-10");
  eq("row advantage", row.advantage_plus, true);
  eq("row lat", row.lat, 32.99);
  eq("row geo source", row.geo_source, "monday");
  eq("row zip from address", row.zip, "92128");
  eq("row sale amount", row.sale_amount, 35500);
}
{
  // Blank money = $0; 0/0 coords = missing.
  const row = buildProductionJobRow(
    {
      id: 1,
      name: "X",
      group: { id: PRODUCTION_GROUPS.queueToStart, title: "Queue To Start" },
      column_values: [{ id: "location", text: "1 Somewhere", lat: 0, lng: 0 }],
    },
    "4300880129",
  );
  eq("blank sale = 0", row.sale_amount, 0);
  eq("0/0 coords dropped", row.lat, null);
  eq("no coords → geo_source null", row.geo_source, null);
}

// ---- Result --------------------------------------------------------------

if (fails.length > 0) {
  console.error(`✗ ${fails.length} failure(s):`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("✓ verify-action-plan: all checks passed");
