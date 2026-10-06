/** Assertions for the Out of House (OOH) write-back engine in
 *  supabase/functions/monday-ooh-report/engine.ts — run with
 *  `npm run verify:ooh`.
 *
 *  Covers every rule the webhook receiver leans on: the disposition map, the
 *  order of writes (via a MOCK Monday client — never the live API), branch
 *  questions, Source Code fill, the Details one-liner + time-in-house PT math,
 *  one-lead-at-a-time release, pairs, "late report = no lead", "At the door",
 *  and idempotency. October 2026 is PDT (UTC−7): a PT wall time T is T+7:00Z. */
import {
  ADVANTAGE_LABEL,
  AUTO_ISSUE_WITHOUT_REPORT,
  BLOCK_COL,
  FORM_COL,
  ISS_CREATE_INDEX,
  LABEL,
  ON_BLOCK,
  RESULT,
  SALESPROC_BOARD_ID,
  SALESPROC_COL,
  SOURCE_CODE_COL,
  addOnReloadLabels,
  applyDisposition,
  buildBaseQueueRow,
  buildCanSaveDetails,
  buildDetailsLine,
  buildOffBlockCreate,
  buildOffBlockText,
  buildSaleAlert,
  buildSalesProcMissingText,
  hasExistingDisposition,
  isAllowedOohBoard,
  isBlankStatus,
  isCanSaveOfficeAppt,
  isDuplicate,
  isOpenLead,
  isSaleResult,
  laClock,
  laWallMinutesFromUtc,
  lastNameOf,
  lateReportCheck,
  matchByLastNameAndRep,
  matchTarget,
  offBlockSourceText,
  oohUpdateKey,
  parseOohForm,
  parsePaymentDetails,
  planDisposition,
  planRelease,
  productsDropdownLabels,
  reloadDropdownLabels,
  sameCustomer,
  secondReportOutcome,
  soldFollowupMissing,
  sourceCodeToWrite,
  timeInHouseMins,
  type AppliedOp,
  type ColMap,
  type DayItem,
  type MondayValue,
  type MondayWriter,
  type OohForm,
} from "../supabase/functions/monday-ooh-report/engine";
import {
  isMyLeadVisible,
  oohHasDisposition,
  oohIsOpenLead,
  planNextLeadToIssue,
} from "../src/lib/ooh";
import {
  sendImessageToRecipients,
  type InkboxConfig,
  type InkboxFetch,
} from "../supabase/functions/monday-ooh-report/inkbox";
import {
  DISPATCH_CONFIG,
  type DispatchLead,
  type DispatchRep,
  type WatchdogLead,
  attendanceWithOverride,
  buildFreeRepsLine,
  buildIssuedText,
  buildMissingReportText,
  buildNeverAloneText,
  decidePairing,
  detectRequestedLanguage,
  driveMinutes,
  findLateReporters,
  firstName,
  hardRuleCheck,
  haversineMiles,
  inWatchdogWindow,
  isCanSaveMarker,
  isFreeRep,
  isJobWalkMarker,
  isOlderHomeownerMarker,
  isRehashMarker,
  nowWallMinutes as dispatchNowWall,
  planIssue,
  planMissingReports,
  planWatchdog,
  sameRep,
  scoreCandidate,
  strengthBonus,
  wallClock12,
} from "../supabase/functions/monday-ooh-report/dispatch";

let failures = 0;
function expectEq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`✗ ${label}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}
function expect(label: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`✗ ${label}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// PT (PDT, UTC−7) wall time → UTC instant.
const pdt = (isoDate: string, h: number, m = 0) => {
  const [y, mo, d] = isoDate.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, h, m) + 7 * 60 * 60 * 1000;
};

// ── column-value builders ──────────────────────────────────────────────────
const status = (index: number, text = "") => ({ text, value: JSON.stringify({ index }) });
const text = (t: string) => ({ text: t, value: JSON.stringify(t) });
const num = (n: number) => ({ text: String(n), value: JSON.stringify(String(n)) });
const hour = (h: number, m: number) => ({
  text: `${h}:${String(m).padStart(2, "0")}`,
  value: JSON.stringify({ hour: h, minute: m }),
});
const date = (d: string, t?: string) => ({
  text: t ? `${d} ${t}` : d,
  value: JSON.stringify({ date: d, ...(t ? { time: t } : {}) }),
});

/** A minimal form col-map; override per test. */
function form(overrides: ColMap): ColMap {
  return { ...overrides };
}

// ── Mock Monday client (records calls; NEVER hits the API) ──────────────────
type Recorded = {
  type: "columns" | "status";
  boardId: string;
  itemId: string;
  values?: Record<string, MondayValue>;
  col?: string;
  label?: string;
};
class MockMonday implements MondayWriter {
  calls: Recorded[] = [];
  async setColumns(boardId: string, itemId: string, values: Record<string, MondayValue>) {
    this.calls.push({ type: "columns", boardId, itemId, values });
  }
  async setStatus(boardId: string, itemId: string, col: string, label: string) {
    this.calls.push({ type: "status", boardId, itemId, col, label });
  }
}

const SUBMIT = pdt("2026-10-04", 10, 8); // 10:08 PT

// ════════════════════════════════════════════════════════════════════════════
// 1) ORDER OF WRITES — mock Monday client (Rule 1)
// ════════════════════════════════════════════════════════════════════════════
{
  const f = parseOohForm(
    "900",
    form({
      [FORM_COL.repName]: status(4, "Jaxon Heilman"),
      [FORM_COL.result]: status(RESULT.SOLD),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.leadId]: text("12345"),
      [FORM_COL.salePrice]: num(34900),
    }),
  );
  const plan = planDisposition(f);
  const cols: Record<string, MondayValue> = {
    ...plan.fieldWrites,
    [BLOCK_COL.details]: { text: buildDetailsLine(f, SUBMIT) },
  };
  const mock = new MockMonday();
  const ops: AppliedOp[] = await applyDisposition(mock, "18432844990", "12345", cols, plan.status);

  expectEq("order: two calls", mock.calls.length, 2);
  expectEq("order: columns first", mock.calls[0].type, "columns");
  expectEq("order: status second", mock.calls[1].type, "status");
  expect(
    "order: columns call carries NO disposition status column",
    !([BLOCK_COL.sale, BLOCK_COL.pm, BLOCK_COL.rs, BLOCK_COL.ol, BLOCK_COL.bo] as string[]).some(
      (c) => Object.prototype.hasOwnProperty.call(mock.calls[0].values ?? {}, c),
    ),
  );
  expectEq(
    "order: exactly one status press",
    mock.calls.filter((c) => c.type === "status").length,
    1,
  );
  expectEq(
    "order: ops reflect both",
    ops.map((o) => o.kind),
    ["columns", "status"],
  );
  expectEq(
    "order: the one status is Sold on status9",
    { col: mock.calls[1].col, label: mock.calls[1].label },
    { col: BLOCK_COL.sale, label: LABEL.sold },
  );
}

// A result with no field writes (PM) makes a SINGLE call — the status — once the
// caller still always attaches Details. Here with no Details it's status-only.
{
  const f = parseOohForm(
    "901",
    form({
      [FORM_COL.result]: status(RESULT.PITCH_MISS),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.leadId]: text("22"),
    }),
  );
  const plan = planDisposition(f);
  const mock = new MockMonday();
  await applyDisposition(mock, "B", "22", plan.fieldWrites, plan.status); // no Details attached
  expectEq(
    "PM with no field writes → single status call",
    mock.calls.map((c) => c.type),
    ["status"],
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 2) DISPOSITION MAP (Rule 2) — each Result → its ONE status column + label
// ════════════════════════════════════════════════════════════════════════════
const mapCase = (result: number, onBlock: number, extra: ColMap = {}) =>
  planDisposition(
    parseOohForm(
      "m",
      form({ [FORM_COL.result]: status(result), [FORM_COL.onBlock]: status(onBlock), ...extra }),
    ),
  );

expectEq("Sold on-block → status9 Sold", mapCase(RESULT.SOLD, ON_BLOCK.YES).status, {
  col: BLOCK_COL.sale,
  label: LABEL.sold,
});
expectEq("Sold self-gen → status9 Sold", mapCase(RESULT.SOLD, ON_BLOCK.SELF_GEN).status, {
  col: BLOCK_COL.sale,
  label: LABEL.sold,
});
expectEq("Sold upsell → status9 Upsell", mapCase(RESULT.SOLD, ON_BLOCK.UPSELL).status, {
  col: BLOCK_COL.sale,
  label: LABEL.upsell,
});
expectEq("Sold reload → status9 Reload", mapCase(RESULT.SOLD, ON_BLOCK.RELOAD).status, {
  col: BLOCK_COL.sale,
  label: LABEL.saleReload,
});
expectEq("Pitch miss → status_1 PM", mapCase(RESULT.PITCH_MISS, ON_BLOCK.YES).status, {
  col: BLOCK_COL.pm,
  label: LABEL.pm,
});
expectEq(
  "PM w/ reset → status_1 PM w/ RS",
  mapCase(RESULT.PM_WITH_RESET, ON_BLOCK.YES, {
    [FORM_COL.resetDate]: date("2026-10-09", "18:00:00"),
  }).status,
  { col: BLOCK_COL.pm, label: LABEL.pmReset },
);
expectEq(
  "Reset → status_2 Reset",
  mapCase(RESULT.RESET, ON_BLOCK.YES, { [FORM_COL.resetDate]: date("2026-10-09", "18:00:00") })
    .status,
  { col: BLOCK_COL.rs, label: LABEL.reset },
);
expectEq("No demo → status4 No Demo", mapCase(RESULT.NO_DEMO, ON_BLOCK.YES).status, {
  col: BLOCK_COL.bo,
  label: LABEL.noDemo,
});
expectEq("No show final → status4 No Show", mapCase(RESULT.NO_SHOW_FINAL, ON_BLOCK.YES).status, {
  col: BLOCK_COL.bo,
  label: LABEL.noShow,
});
expectEq("At the door → status4 No show text", mapCase(RESULT.AT_THE_DOOR, ON_BLOCK.YES).status, {
  col: BLOCK_COL.bo,
  label: LABEL.noShowText,
});

// Reload maps the QUOTED products onto the Reloads dropdown (never "Room");
// Sold writes Sale Price.
expectEq(
  "Reload maps quoted products to the Reloads dropdown (not Room)",
  mapCase(RESULT.SOLD, ON_BLOCK.RELOAD, {
    [FORM_COL.quoted]: { text: "Roof, Turf", value: null },
  }).fieldWrites[BLOCK_COL.reloads],
  { labels: ["Roof", "Turf"] },
);
expect(
  "Reload with no quoted products writes nothing to the dropdown (never Room)",
  mapCase(RESULT.SOLD, ON_BLOCK.RELOAD).fieldWrites[BLOCK_COL.reloads] === undefined,
);
expectEq(
  "Sold writes Sale Price",
  mapCase(RESULT.SOLD, ON_BLOCK.YES, { [FORM_COL.salePrice]: num(50000) }).fieldWrites[
    BLOCK_COL.salePrice
  ],
  "50000",
);
// Only ONE disposition status is ever set (reset results need a date, else
// they queue — see section 4b).
for (const r of Object.values(RESULT)) {
  const extra: ColMap =
    r === RESULT.PM_WITH_RESET || r === RESULT.RESET
      ? { [FORM_COL.resetDate]: date("2026-10-09", "18:00:00") }
      : {};
  const p = mapCase(r, ON_BLOCK.YES, extra);
  expect(`single status for result ${r}`, p.status !== null && typeof p.status.col === "string");
}

// ════════════════════════════════════════════════════════════════════════════
// 3) BRANCH QUESTIONS (Rule 5 branches)
// ════════════════════════════════════════════════════════════════════════════
// One-legger: reset call done (0) → Reset to Confirmed, writes reset date.
{
  const p = mapCase(RESULT.ONE_LEGGER, ON_BLOCK.YES, {
    [FORM_COL.resetCall]: status(0),
    [FORM_COL.resetDate]: date("2026-10-09", "18:00:00"),
  });
  expectEq("OL + reset-call done → status_2 Reset", p.status, {
    col: BLOCK_COL.rs,
    label: LABEL.reset,
  });
  expectEq("OL + reset-call done writes Reset Date", p.fieldWrites[BLOCK_COL.resetDate], {
    date: "2026-10-09",
    time: "18:00:00",
  });
}
// One-legger: no reset (1) → OL to Blowout, no reset date.
{
  const p = mapCase(RESULT.ONE_LEGGER, ON_BLOCK.YES, { [FORM_COL.resetCall]: status(1) });
  expectEq("OL + no reset → status_3 OL", p.status, { col: BLOCK_COL.ol, label: LABEL.ol });
  expect("OL + no reset writes NO reset date", p.fieldWrites[BLOCK_COL.resetDate] === undefined);
}
// PM w/ reset + Reset both write reset date before the status.
expectEq(
  "PM w/ reset writes Reset Date",
  mapCase(RESULT.PM_WITH_RESET, ON_BLOCK.YES, {
    [FORM_COL.resetDate]: date("2026-10-07", "17:30:00"),
  }).fieldWrites[BLOCK_COL.resetDate],
  { date: "2026-10-07", time: "17:30:00" },
);
expectEq(
  "Reset writes Reset Date",
  mapCase(RESULT.RESET, ON_BLOCK.YES, { [FORM_COL.resetDate]: date("2026-10-07") }).fieldWrites[
    BLOCK_COL.resetDate
  ],
  { date: "2026-10-07" },
);
// Branch answers land in the Details line.
{
  const f = parseOohForm(
    "b1",
    form({
      [FORM_COL.result]: status(RESULT.ONE_LEGGER),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.whoMissing]: status(0, "Spouse / partner"),
      [FORM_COL.inspection]: status(0),
      [FORM_COL.resetCall]: status(1),
      [FORM_COL.dropCall]: status(2, "Jorge"),
    }),
  );
  const line = buildDetailsLine(f, SUBMIT);
  expect(
    "OL details mention missing + inspection + no reset",
    /missing/i.test(line) && /inspection done/i.test(line) && /no reset/i.test(line),
  );
  expect("OL details carry the drop call", /Drop: Jorge/.test(line));
}
{
  const f = parseOohForm(
    "b2",
    form({
      [FORM_COL.result]: status(RESULT.NO_DEMO),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.whyNoDemo]: status(1, "Work we don't do"),
      [FORM_COL.whatHappened]: text("wants plumbing"),
    }),
  );
  expect(
    "No-demo details carry reason",
    /Work we don't do: wants plumbing/.test(buildDetailsLine(f, SUBMIT)),
  );
}
{
  const f = parseOohForm(
    "b3",
    form({
      [FORM_COL.result]: status(RESULT.NO_SHOW_FINAL),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.minutesWaited]: num(20),
      [FORM_COL.calledTexted]: status(0, "Yes"),
    }),
  );
  expect(
    "No-show details carry waited + called/texted",
    /waited 20 min/.test(buildDetailsLine(f, SUBMIT)) &&
      /called \+ texted/.test(buildDetailsLine(f, SUBMIT)),
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 4) SOURCE CODE FILL (Rule 4)
// ════════════════════════════════════════════════════════════════════════════
expectEq("Room → 2", sourceCodeToWrite(RESULT.SOLD, null, "Room"), {
  code: 2,
  unknownSource: false,
});
expectEq("Self Gen → 1", sourceCodeToWrite(RESULT.SOLD, null, "Self Gen"), {
  code: 1,
  unknownSource: false,
});
expectEq("Canvass → 1", sourceCodeToWrite(RESULT.SOLD, null, "Canvass"), {
  code: 1,
  unknownSource: false,
});
expectEq("Rep Reset → 1", sourceCodeToWrite(RESULT.SOLD, null, "Rep Reset"), {
  code: 1,
  unknownSource: false,
});
expectEq("QR Code → 1", sourceCodeToWrite(RESULT.SOLD, null, "QR Code"), {
  code: 1,
  unknownSource: false,
});
expectEq("Job Walk → blank", sourceCodeToWrite(RESULT.SOLD, null, "Job Walk"), {
  code: null,
  unknownSource: false,
});
expectEq("Can Save → blank", sourceCodeToWrite(RESULT.SOLD, null, "Can Save"), {
  code: null,
  unknownSource: false,
});
expectEq("existing code is never overwritten", sourceCodeToWrite(RESULT.SOLD, 1, "Room"), {
  code: null,
  unknownSource: false,
});
expectEq("non-Sold fills nothing", sourceCodeToWrite(RESULT.PITCH_MISS, null, "Room"), {
  code: null,
  unknownSource: false,
});
expectEq("unknown source → 1 (flagged)", sourceCodeToWrite(RESULT.SOLD, null, "Mystery"), {
  code: 1,
  unknownSource: true,
});
expectEq(
  "Upsell needs no code (plan)",
  mapCase(RESULT.SOLD, ON_BLOCK.UPSELL).fillSourceCodeIfBlank,
  false,
);
expectEq(
  "Reload needs no code (plan)",
  mapCase(RESULT.SOLD, ON_BLOCK.RELOAD).fillSourceCodeIfBlank,
  false,
);
expectEq(
  "Sold on-block fills code if blank (plan)",
  mapCase(RESULT.SOLD, ON_BLOCK.YES).fillSourceCodeIfBlank,
  true,
);

// ════════════════════════════════════════════════════════════════════════════
// 5) DETAILS one-liner + time-in-house PT math (Rule 3)
// ════════════════════════════════════════════════════════════════════════════
expectEq("laClock no-pad hour", laClock(pdt("2026-10-04", 4, 42)), "4:42");
expectEq("laClock two-digit hour", laClock(SUBMIT), "10:08");
{
  // arrival 8:16 PT, submit 10:08 PT → 112 min = 1:52 (brief example)
  const f = parseOohForm(
    "d1",
    form({
      [FORM_COL.result]: status(RESULT.PITCH_MISS),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.arrival]: hour(8, 16),
    }),
  );
  expectEq("time in house 8:16→10:08 = 112 min", timeInHouseMins(f, SUBMIT, null), 112);
  const line = buildDetailsLine(f, SUBMIT);
  expect("details end with out-of-house time", line.endsWith("(10:08)"));
  expect("details include In 1:52", line.includes("In 1:52"));
}
{
  // arrival blank → falls back to appointment time (9:00 PT appt)
  const f = parseOohForm(
    "d2",
    form({
      [FORM_COL.result]: status(RESULT.PITCH_MISS),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
    }),
  );
  expectEq(
    "arrival blank uses appt fallback",
    timeInHouseMins(f, SUBMIT, { hour: 9, minute: 0 }),
    68,
  );
  expectEq("no arrival + no fallback → null", timeInHouseMins(f, SUBMIT, null), null);
}
{
  const f = parseOohForm(
    "d3",
    form({
      [FORM_COL.result]: status(RESULT.PITCH_MISS),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.quantities]: text("Roof 28 sq + fascia 160ft"),
      [FORM_COL.highPrice]: num(34900),
      [FORM_COL.lowPrice]: num(27500),
      [FORM_COL.objection]: status(3, "Want more bids"),
      [FORM_COL.dropCall]: status(0, "Tyler"),
      [FORM_COL.arrival]: hour(8, 16),
    }),
  );
  const line = buildDetailsLine(f, SUBMIT);
  expect("PM line has prefix + quantities", line.startsWith("PM – Roof 28 sq + fascia 160ft"));
  expect("PM line has High/Low", line.includes("High $34,900") && line.includes("Low $27,500"));
  expect("PM line has objection", line.includes("Obj: Want more bids"));
  console.log(`   e.g. → ${line}`);
}

// ════════════════════════════════════════════════════════════════════════════
// 6) ONE LEAD AT A TIME — release on report (Rule 7)
// ════════════════════════════════════════════════════════════════════════════
const JAXON = "Jaxon Heilman";
const di = (
  id: string,
  reps: string[],
  statusLabel: string | null,
  timeMs: number | null,
  dispo: Partial<Pick<DayItem, "pm" | "rs" | "ol" | "bo" | "sale">> = {},
): DayItem => ({ id, reps, statusLabel, timeMs, ...dispo });
{
  const dayItems = [
    di("A", [JAXON], LABEL.notIssued, pdt("2026-10-04", 9, 0)), // before reported — skip
    di("B", [JAXON], LABEL.notIssued, pdt("2026-10-04", 13, 0)), // earliest after — pick
    di("C", [JAXON], LABEL.notIssued, pdt("2026-10-04", 15, 0)),
  ];
  expectEq(
    "release: earliest Not-Issued after reported lead",
    planRelease({
      atTheDoor: false,
      rep: JAXON,
      dayItems,
      reportedLeadTimeMs: pdt("2026-10-04", 11, 0),
    }),
    { action: "issue", itemId: "B" },
  );
}
{
  const dayItems = [di("X", [JAXON], LABEL.iss, pdt("2026-10-04", 13, 0))]; // already issued, not Not-Issued
  expectEq(
    "release: nothing left to issue → hold",
    planRelease({
      atTheDoor: false,
      rep: JAXON,
      dayItems,
      reportedLeadTimeMs: pdt("2026-10-04", 11, 0),
    }).action,
    "hold",
  );
}
{
  // excluded statuses are never auto-issued
  const dayItems = [
    di("R", [JAXON], "Reload", pdt("2026-10-04", 13, 0)),
    di("O", [JAXON], "Office Appt", pdt("2026-10-04", 14, 0)),
  ];
  expectEq(
    "release: excluded statuses never issue",
    planRelease({
      atTheDoor: false,
      rep: JAXON,
      dayItems,
      reportedLeadTimeMs: pdt("2026-10-04", 11, 0),
    }).action,
    "hold",
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 6b) PAIRS (Rule 7)
// ════════════════════════════════════════════════════════════════════════════
const NICK = "Nick Schoeben";
{
  // next lead B is paired (Jaxon + Nick); Nick still holds an Iss lead (P) → hold
  const dayItems = [
    di("B", [JAXON, NICK], LABEL.notIssued, pdt("2026-10-04", 13, 0)),
    di("P", [NICK], LABEL.iss, pdt("2026-10-04", 12, 0)),
  ];
  expectEq(
    "pairs: partner still holds Iss → hold",
    planRelease({
      atTheDoor: false,
      rep: JAXON,
      dayItems,
      reportedLeadTimeMs: pdt("2026-10-04", 11, 0),
    }).action,
    "hold",
  );
}
{
  // same paired lead, but Nick is free now → issue B
  const dayItems = [di("B", [JAXON, NICK], LABEL.notIssued, pdt("2026-10-04", 13, 0))];
  expectEq(
    "pairs: both reps free → issue paired lead",
    planRelease({
      atTheDoor: false,
      rep: JAXON,
      dayItems,
      reportedLeadTimeMs: pdt("2026-10-04", 11, 0),
    }),
    { action: "issue", itemId: "B" },
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 7) LATE REPORT = NO LEAD (Rule 7)
// ════════════════════════════════════════════════════════════════════════════
expectEq("nothing is auto-issued without a report", AUTO_ISSUE_WITHOUT_REPORT, false);
{
  // 45-min window: appt in 30 min, report missing → alert + keep held
  const now = pdt("2026-10-04", 12, 30);
  const appt = pdt("2026-10-04", 13, 0);
  expectEq(
    "late report alerts within 45 min, lead stays held",
    lateReportCheck({
      reportMissing: true,
      apptTimeMs: appt,
      nowMs: now,
      leadStatusLabel: LABEL.notIssued,
    }),
    { alert: true, keepHeld: true },
  );
}
{
  // appt 2 hours out, report missing → no alert yet, still held
  const now = pdt("2026-10-04", 11, 0);
  const appt = pdt("2026-10-04", 13, 0);
  expectEq(
    "late report: >45 min out → no alert, still held",
    lateReportCheck({
      reportMissing: true,
      apptTimeMs: appt,
      nowMs: now,
      leadStatusLabel: LABEL.notIssued,
    }),
    { alert: false, keepHeld: true },
  );
}
{
  // report present → no alert, lead free to follow normal release
  expectEq(
    "report present → no alert",
    lateReportCheck({
      reportMissing: false,
      apptTimeMs: pdt("2026-10-04", 13, 0),
      nowMs: pdt("2026-10-04", 12, 30),
      leadStatusLabel: LABEL.notIssued,
    }),
    { alert: false, keepHeld: true },
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 8) AT THE DOOR (Rule 6)
// ════════════════════════════════════════════════════════════════════════════
{
  const f = parseOohForm(
    "door",
    form({
      [FORM_COL.result]: status(RESULT.AT_THE_DOOR),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.leadId]: text("77"),
      [FORM_COL.arrival]: hour(9, 0),
    }),
  );
  const plan = planDisposition(f);
  expectEq("at the door → status4 No show text", plan.status, {
    col: BLOCK_COL.bo,
    label: LABEL.noShowText,
  });
  expectEq("at the door is flagged", plan.atTheDoor, true);
  expectEq(
    "at the door releases NOTHING",
    planRelease({
      atTheDoor: true,
      rep: JAXON,
      dayItems: [di("B", [JAXON], LABEL.notIssued, pdt("2026-10-04", 13, 0))],
      reportedLeadTimeMs: pdt("2026-10-04", 9, 0),
    }).action,
    "hold",
  );
  const line = buildDetailsLine(f, SUBMIT);
  expect(
    "at the door details note the no-answer time, no In-house",
    line.startsWith("No answer at door") && line.endsWith("(10:08)") && !line.includes("In "),
  );
}
// A stray/hidden objection or price must NOT leak onto an at-the-door line
// (gated by Result, not by presence — regression from the live E2E test).
{
  const f = parseOohForm(
    "door2",
    form({
      [FORM_COL.result]: status(RESULT.AT_THE_DOOR),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.objection]: status(5, "Financing didn't work"),
      [FORM_COL.highPrice]: num(40000),
      [FORM_COL.quoted]: { text: "Roof", value: null },
    }),
  );
  const line = buildDetailsLine(f, SUBMIT);
  expect(
    "at the door drops stray objection / price / quote",
    !line.includes("Obj:") && !line.includes("High $") && !line.includes("Roof"),
  );
}
// Objection only rides Pitch-miss lines, never a Reset line.
{
  const pm = parseOohForm(
    "pmobj",
    form({
      [FORM_COL.result]: status(RESULT.PITCH_MISS),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.objection]: status(3, "Want more bids"),
    }),
  );
  expect(
    "pitch miss keeps objection",
    buildDetailsLine(pm, SUBMIT).includes("Obj: Want more bids"),
  );
  const reset = parseOohForm(
    "rsobj",
    form({
      [FORM_COL.result]: status(RESULT.RESET),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.objection]: status(3, "Want more bids"),
    }),
  );
  expect("reset drops objection", !buildDetailsLine(reset, SUBMIT).includes("Obj:"));
}

// ════════════════════════════════════════════════════════════════════════════
// 9) IDEMPOTENCY (Rule)
// ════════════════════════════════════════════════════════════════════════════
expectEq("processed form id is a duplicate", isDuplicate(["900", "901"], "900"), true);
expectEq("fresh form id is not a duplicate", isDuplicate(["900"], "902"), false);

// ── matching ────────────────────────────────────────────────────────────────
expectEq(
  "match: lead id → write that item",
  matchTarget(
    parseOohForm(
      "x",
      form({ [FORM_COL.leadId]: text("555"), [FORM_COL.onBlock]: status(ON_BLOCK.YES) }),
    ),
  ),
  { kind: "write", leadId: "555" },
);
expectEq(
  "match: self-gen no lead → create",
  matchTarget(parseOohForm("x", form({ [FORM_COL.onBlock]: status(ON_BLOCK.SELF_GEN) }))).kind,
  "create",
);
expectEq(
  "match: upsell no lead → create",
  matchTarget(parseOohForm("x", form({ [FORM_COL.onBlock]: status(ON_BLOCK.UPSELL) }))).kind,
  "create",
);
expectEq(
  "match: on-block Yes but no lead id → queue",
  matchTarget(parseOohForm("x", form({ [FORM_COL.onBlock]: status(ON_BLOCK.YES) }))).kind,
  "queue",
);
expectEq(
  "match: non-numeric lead id ignored → queue",
  matchTarget(
    parseOohForm(
      "x",
      form({ [FORM_COL.leadId]: text("not-a-number"), [FORM_COL.onBlock]: status(ON_BLOCK.YES) }),
    ),
  ).kind,
  "queue",
);

// ── parse sanity ────────────────────────────────────────────────────────────
{
  const f: OohForm = parseOohForm(
    "1001",
    form({
      [FORM_COL.repName]: status(4, "Jaxon Heilman"),
      [FORM_COL.partner]: status(10, "Nick Schoeben"),
      [FORM_COL.result]: status(RESULT.SOLD),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.leadId]: text("12345"),
      [FORM_COL.salePrice]: num(42000),
    }),
  );
  expectEq("parse rep name", f.repName, "Jaxon Heilman");
  expectEq("parse partner", f.partner, "Nick Schoeben");
  expectEq("parse result", f.result, RESULT.SOLD);
  expectEq("parse lead id", f.leadId, "12345");
  expectEq("parse sale price", f.salePrice, 42000);
}

// ════════════════════════════════════════════════════════════════════════════
// 10) FIX-UP PASS (review against the live boards) — #1–#12
// ════════════════════════════════════════════════════════════════════════════

// — #1 open-lead rule: a dispositioned lead KEEPS its Iss label ---------------
expectEq("isBlankStatus empty", isBlankStatus(""), true);
expectEq("isBlankStatus None", isBlankStatus("None"), true);
expectEq("isBlankStatus Sold", isBlankStatus("Sold"), false);
expectEq(
  "hasExistingDisposition: all blank → false",
  hasExistingDisposition({ pm: null, rs: null, ol: null, bo: null, sale: null }),
  false,
);
expectEq(
  "hasExistingDisposition: None labels → false",
  hasExistingDisposition({ pm: "None", rs: "None", ol: "None", bo: "None", sale: "None" }),
  false,
);
expectEq(
  "hasExistingDisposition: a Sold → true",
  hasExistingDisposition({ pm: null, rs: null, ol: null, bo: null, sale: "Sold" }),
  true,
);
expectEq(
  "hasExistingDisposition: No show text alone → false (still open)",
  hasExistingDisposition({ pm: null, rs: null, ol: null, bo: "No show text", sale: null }),
  false,
);
expectEq(
  "hasExistingDisposition: No Show (final) → true",
  hasExistingDisposition({ pm: null, rs: null, ol: null, bo: "No Show", sale: null }),
  true,
);
expectEq(
  "isOpenLead: Iss + no disposition → open",
  isOpenLead({ iss: "Iss", pm: null, rs: null, ol: null, bo: null, sale: null }),
  true,
);
expectEq(
  "isOpenLead: dispositioned (keeps Iss) → not open",
  isOpenLead({ iss: "Iss", pm: null, rs: null, ol: null, bo: null, sale: "Sold" }),
  false,
);
expectEq(
  "isOpenLead: Not Issued → not open",
  isOpenLead({ iss: "Not Issued", pm: null, rs: null, ol: null, bo: null, sale: null }),
  false,
);
expectEq(
  "isOpenLead: Iss + No show text → still open (at the door)",
  isOpenLead({ iss: "Iss", pm: null, rs: null, ol: null, bo: "No show text", sale: null }),
  true,
);

// a rep with 3 leads, the first reported → next lead releases (the whole bug)
{
  const dayItems = [
    di("L1", [JAXON], LABEL.iss, pdt("2026-10-04", 9, 0), { sale: LABEL.sold }), // reported
    di("L2", [JAXON], LABEL.notIssued, pdt("2026-10-04", 11, 0)), // next — pick
    di("L3", [JAXON], LABEL.notIssued, pdt("2026-10-04", 13, 0)),
  ];
  expectEq(
    "release: first-of-three reported → issues the next (excludes reported id)",
    planRelease({
      atTheDoor: false,
      rep: JAXON,
      dayItems,
      reportedLeadTimeMs: pdt("2026-10-04", 9, 0),
      reportedLeadId: "L1",
    }),
    { action: "issue", itemId: "L2" },
  );
  // even without the id exclusion, the dispositioned L1 no longer blocks
  expectEq(
    "release: dispositioned Iss lead no longer blocks the rep",
    planRelease({
      atTheDoor: false,
      rep: JAXON,
      dayItems,
      reportedLeadTimeMs: pdt("2026-10-04", 9, 0),
    }),
    { action: "issue", itemId: "L2" },
  );
}
// pairs: partner's OTHER lead is reported (dispositioned) → no longer busy
{
  const dayItems = [
    di("B", [JAXON, NICK], LABEL.notIssued, pdt("2026-10-04", 13, 0)),
    di("P", [NICK], LABEL.iss, pdt("2026-10-04", 12, 0), { pm: LABEL.pm }), // Nick reported
  ];
  expectEq(
    "pairs: partner's reported lead no longer blocks → issue",
    planRelease({
      atTheDoor: false,
      rep: JAXON,
      dayItems,
      reportedLeadTimeMs: pdt("2026-10-04", 11, 0),
    }),
    { action: "issue", itemId: "B" },
  );
}

// — #2 Monday stores date columns in UTC → read as Pacific wall-minutes -------
// 1 PM PDT is stored "20:00" UTC same day; 7 PM PDT is "02:00" UTC the NEXT day.
expectEq(
  "1 PM PT from UTC 20:00 → 780 wall-min",
  laWallMinutesFromUtc("2026-10-04", "20:00:00"),
  780,
);
expectEq(
  "7 PM PT from UTC 02:00 (next day) → 1140 wall-min",
  laWallMinutesFromUtc("2026-10-05", "02:00:00"),
  1140,
);
expect("later-PT appt sorts after earlier one once converted", 780 < 1140);
expectEq("no time → null", laWallMinutesFromUtc("2026-10-04", null), null);
{
  // the brief's case: a 7 PM lead and a 1 PM lead, the 1 PM reported first.
  const onePm = laWallMinutesFromUtc("2026-10-04", "20:00:00")!; // 780
  const sevenPm = laWallMinutesFromUtc("2026-10-05", "02:00:00")!; // 1140
  const dayItems = [
    di("ONE", [JAXON], LABEL.iss, onePm, { sale: LABEL.sold }), // 1 PM, reported
    di("SEVEN", [JAXON], LABEL.notIssued, sevenPm), // 7 PM, next
  ];
  expectEq(
    "release: 7 PM lead issues after the 1 PM one is reported (UTC→PT fix)",
    planRelease({
      atTheDoor: false,
      rep: JAXON,
      dayItems,
      reportedLeadTimeMs: onePm,
      reportedLeadId: "ONE",
    }),
    { action: "issue", itemId: "SEVEN" },
  );
}
// reset time in the Details text reads in Pacific, not UTC.
{
  // UTC 02:30 Oct 10 = 7:30 PM PDT Fri Oct 9.
  const f = parseOohForm(
    "rsla",
    form({
      [FORM_COL.result]: status(RESULT.PM_WITH_RESET),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.resetDate]: date("2026-10-10", "02:30:00"),
    }),
  );
  const line = buildDetailsLine(f, SUBMIT);
  expect("reset time shown in Pacific (Fri 10/9 7:30pm)", line.includes("reset Fri 10/9 7:30pm"));
}

// — #3 already-dispositioned block: guard helper ------------------------------
expectEq(
  "guard: office already pressed Sold → already dispositioned",
  hasExistingDisposition({ pm: null, rs: null, ol: null, bo: null, sale: "Sold" }),
  true,
);
expectEq(
  "guard: only No show text → not yet dispositioned (write allowed)",
  hasExistingDisposition({ pm: null, rs: null, ol: null, bo: "No show text", sale: null }),
  false,
);

// — #4 reset result with no reset date → queue, press nothing -----------------
{
  const pm = mapCase(RESULT.PM_WITH_RESET, ON_BLOCK.YES);
  expectEq(
    "PM w/ reset + no date → needsReview, no status",
    { status: pm.status, needsReview: pm.needsReview },
    { status: null, needsReview: "PM w/ reset but no reset date" },
  );
  const rs = mapCase(RESULT.RESET, ON_BLOCK.YES);
  expectEq(
    "Reset + no date → needsReview, no status",
    { status: rs.status, needsReview: rs.needsReview },
    { status: null, needsReview: "Reset but no reset date" },
  );
  const ok = mapCase(RESULT.PM_WITH_RESET, ON_BLOCK.YES, {
    [FORM_COL.resetDate]: date("2026-10-09", "18:00:00"),
  });
  expect(
    "PM w/ reset + date → presses, no review",
    ok.needsReview === null && ok.status?.label === LABEL.pmReset,
  );
}

// — #5 missing-reports uses the same open-lead rule (app-side mirror) ----------
expectEq(
  "app mirror: dispositioned lead is not open (not 'missing')",
  oohIsOpenLead({ iss: "Iss", pm: null, rs: null, ol: null, bo: null, sale: "Sold" }),
  false,
);
expectEq(
  "app mirror: Iss + no disposition is open (truly missing)",
  oohIsOpenLead({ iss: "Iss", pm: null, rs: null, ol: null, bo: null, sale: null }),
  true,
);
expectEq(
  "app mirror matches engine on No show text",
  oohHasDisposition({ pm: null, rs: null, ol: null, bo: "No show text", sale: null }),
  hasExistingDisposition({ pm: null, rs: null, ol: null, bo: "No show text", sale: null }),
);

// — #6 Details falls back to the appointment time when arrival is blank -------
{
  const f = parseOohForm(
    "fb",
    form({
      [FORM_COL.result]: status(RESULT.PITCH_MISS),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
    }),
  );
  const line = buildDetailsLine(f, SUBMIT, { hour: 9, minute: 0 }); // appt 9:00 → 68 min
  expect("blank arrival uses the appt fallback in the Details line", line.includes("In 1:08"));
}

// — #7 the activity-log update key is per SUBMISSION (unique per form item) ----
expect("update key is per form item", oohUpdateKey("900") !== oohUpdateKey("901"));
expectEq("update key shape", oohUpdateKey("900"), "ooh-update-900");

// — #8 only the form board drives a disposition -------------------------------
expectEq("accept: the form board", isAllowedOohBoard("18433859050"), true);
expectEq("ignore: a different board", isAllowedOohBoard("18432844990"), false);
expectEq("accept: no board id present", isAllowedOohBoard(null), true);

// — #9 every queue/error row keeps rep + lead detail --------------------------
{
  const f = parseOohForm(
    "q1",
    form({
      [FORM_COL.repName]: status(4, "Jaxon Heilman"),
      [FORM_COL.partner]: status(10, "Nick Schoeben"),
      [FORM_COL.result]: status(RESULT.SOLD),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.leadId]: text("12345"),
    }),
  );
  const row = buildBaseQueueRow(f, buildDetailsLine(f, SUBMIT), planDisposition(f));
  expect(
    "queue row keeps rep / partner / lead / details",
    row.rep_name === "Jaxon Heilman" &&
      row.partner === "Nick Schoeben" &&
      row.lead_id === "12345" &&
      typeof row.details_line === "string" &&
      (row.details_line as string).length > 0,
  );
}

// — #10 Reloads: quoted products map to the dropdown; never "Room" ------------
expectEq("reload map: Roof, Turf", reloadDropdownLabels("Roof, Turf"), ["Roof", "Turf"]);
expectEq("reload map keeps canonical order", reloadDropdownLabels("Turf, Roof"), ["Roof", "Turf"]);
expectEq(
  "reload map: slash label survives (Stucco/Paint)",
  reloadDropdownLabels("Stucco/Paint, Gutters"),
  ["Gutters", "Stucco/Paint"],
);
expectEq("reload map: case-insensitive + GT Trim", reloadDropdownLabels("gt trim"), ["GT Trim"]);
expectEq("reload map: unknown product dropped (never Room)", reloadDropdownLabels("Room"), []);
expectEq("reload map: empty", reloadDropdownLabels(null), []);

// — #11 My Leads shows only issued / office / reported leads ------------------
expectEq(
  "myleads: Iss lead is visible",
  isMyLeadVisible({ iss: "Iss", pm: null, rs: null, ol: null, bo: null, sale: null }),
  true,
);
expectEq(
  "myleads: Office Appt is visible",
  isMyLeadVisible({ iss: "Office Appt", pm: null, rs: null, ol: null, bo: null, sale: null }),
  true,
);
expectEq(
  "myleads: Not Issued lead is HIDDEN",
  isMyLeadVisible({ iss: "Not Issued", pm: null, rs: null, ol: null, bo: null, sale: null }),
  false,
);
expectEq(
  "myleads: a reported lead (keeps Iss) stays visible",
  isMyLeadVisible({ iss: "Iss", pm: null, rs: null, ol: null, bo: null, sale: "Sold" }),
  true,
);
expectEq(
  "myleads: CTC / Add Rep hidden",
  isMyLeadVisible({ iss: "CTC", pm: null, rs: null, ol: null, bo: null, sale: null }),
  false,
);

// — #12 Push lead = the rep's NEXT not-issued lead (earliest after now) --------
{
  const now = pdt("2026-10-04", 12, 0);
  const items = [
    {
      itemId: "A",
      name: "Early",
      reps: [JAXON],
      iss: "Not Issued",
      apptMs: pdt("2026-10-04", 10, 0),
    }, // before now
    {
      itemId: "LATE",
      name: "The late lead",
      reps: [JAXON],
      iss: "Iss",
      apptMs: pdt("2026-10-04", 11, 0),
    }, // already Iss (the one pressed before — wrong)
    {
      itemId: "NEXT",
      name: "Up next",
      reps: [JAXON],
      iss: "Not Issued",
      apptMs: pdt("2026-10-04", 13, 0),
    }, // earliest Not-Issued after now
    {
      itemId: "LATER",
      name: "Later still",
      reps: [JAXON],
      iss: "Not Issued",
      apptMs: pdt("2026-10-04", 15, 0),
    },
  ];
  expectEq(
    "push: picks the earliest Not-Issued after now",
    planNextLeadToIssue(items, JAXON, now)?.itemId,
    "NEXT",
  );
  expectEq(
    "push: none upcoming → null",
    planNextLeadToIssue(
      [{ itemId: "X", name: "x", reps: [JAXON], iss: "Iss", apptMs: pdt("2026-10-04", 13, 0) }],
      JAXON,
      now,
    ),
    null,
  );
  expectEq(
    "push: matches only this rep's leads",
    planNextLeadToIssue(
      [
        {
          itemId: "Y",
          name: "y",
          reps: [NICK],
          iss: "Not Issued",
          apptMs: pdt("2026-10-04", 13, 0),
        },
      ],
      JAXON,
      now,
    ),
    null,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 11) SALE alert to leadership (Tyler / Shai / Jorge)
// ════════════════════════════════════════════════════════════════════════════
expectEq(
  "isSaleResult: Sold → true",
  isSaleResult(parseOohForm("s", form({ [FORM_COL.result]: status(RESULT.SOLD) }))),
  true,
);
expectEq(
  "isSaleResult: Pitch miss → false",
  isSaleResult(parseOohForm("s", form({ [FORM_COL.result]: status(RESULT.PITCH_MISS) }))),
  false,
);
{
  const f = parseOohForm(
    "sale1",
    form({
      [FORM_COL.repName]: status(4, "Jaxon Heilman"),
      [FORM_COL.partner]: status(10, "Nick Schoeben"),
      [FORM_COL.result]: status(RESULT.SOLD),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.quantities]: text("Roof 28 sq + gutters"),
      [FORM_COL.salePrice]: num(34900),
    }),
  );
  const msg = buildSaleAlert(f, "John Smith");
  expect("sale alert has a SALE banner", msg.includes("SALE"));
  expect("sale alert shows the amount", msg.includes("$34,900"));
  expect("sale alert lists both reps", msg.includes("Jaxon Heilman & Nick Schoeben"));
  expect("sale alert says what sold", msg.includes("Sold: Roof 28 sq + gutters"));
  expect("sale alert names the customer", msg.includes("Customer: John Smith"));
  console.log(`   e.g. →\n${msg.replace(/^/gm, "      ")}`);
}
{
  // Upsell keeps its label; blank Sale Price omits the money line (never invent).
  const f = parseOohForm(
    "sale2",
    form({
      [FORM_COL.repName]: status(4, "Solo Rep"),
      [FORM_COL.result]: status(RESULT.SOLD),
      [FORM_COL.onBlock]: status(ON_BLOCK.UPSELL),
      [FORM_COL.quoted]: { text: "Windows", value: null },
    }),
  );
  const msg = buildSaleAlert(f, null);
  expect("upsell alert uses the Upsell label", msg.includes("Upsell: Windows"));
  expect("no sale price → no money line", !msg.includes("$"));
  expect(
    "single rep renders without an ampersand",
    msg.includes("Rep: Solo Rep") && !msg.includes(" & "),
  );
  expect("no customer → no Customer line", !msg.includes("Customer:"));
}

// ════════════════════════════════════════════════════════════════════════════
// 12) INKBOX send — real API contract, mocked fetch (one 1:1 request per number)
// ════════════════════════════════════════════════════════════════════════════
const AGENT_ID = "2d0dbf34-9276-4f6a-b413-2ef1c5a71cfa";
const inkboxCfg = (recipients: string[], apiKey: string | null = "test-key"): InkboxConfig => ({
  apiKey,
  recipients,
  baseUrl: "https://inkbox.ai/api/v1",
  agentIdentityId: AGENT_ID,
});
{
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const mockFetch: InkboxFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { ok: true, status: 200, text: async () => "" };
  };
  const res = await sendImessageToRecipients(
    inkboxCfg(["+15551112222", "+15553334444", "+15555556666"]),
    "🟩 SALE",
    mockFetch,
  );
  expectEq("inkbox: one request per recipient (1:1)", calls.length, 3);
  expectEq(
    "inkbox: result counts all delivered",
    { sent: res.sent, delivered: res.delivered, attempted: res.attempted },
    { sent: true, delivered: 3, attempted: 3 },
  );
  expectEq(
    "inkbox: URL hits /imessage/messages with agent_identity_id",
    calls[0].url,
    `https://inkbox.ai/api/v1/imessage/messages?agent_identity_id=${AGENT_ID}`,
  );
  expect(
    "inkbox: X-API-Key header (NOT Bearer)",
    calls[0].headers["X-API-Key"] === "test-key" &&
      !("Authorization" in calls[0].headers) &&
      calls[0].headers["Content-Type"] === "application/json",
  );
  expectEq("inkbox: body is {to,text} for the first recipient", JSON.parse(calls[0].body), {
    to: "+15551112222",
    text: "🟩 SALE",
  });
  expectEq(
    "inkbox: each recipient gets their own request",
    calls.map((c) => JSON.parse(c.body).to),
    ["+15551112222", "+15553334444", "+15555556666"],
  );
}
{
  // one recipient fails → captured in errors, the others still delivered, never throws
  const mockFetch: InkboxFetch = async (_url, init) => {
    const to = JSON.parse(init.body).to as string;
    return to === "+bad"
      ? { ok: false, status: 500, text: async () => "boom" }
      : { ok: true, status: 200, text: async () => "" };
  };
  const res = await sendImessageToRecipients(inkboxCfg(["+good", "+bad"]), "hi", mockFetch);
  expectEq(
    "inkbox: partial failure still delivers the good recipient",
    { delivered: res.delivered, attempted: res.attempted, sent: res.sent },
    { delivered: 1, attempted: 2, sent: true },
  );
  expect(
    "inkbox: the failed recipient + status is captured",
    (res.errors ?? []).some((e) => e.includes("+bad") && e.includes("500")),
  );
}
{
  // a thrown fetch (network) is caught per-recipient, never propagates
  const mockFetch: InkboxFetch = async () => {
    throw new Error("network down");
  };
  const res = await sendImessageToRecipients(inkboxCfg(["+1"]), "hi", mockFetch);
  expectEq(
    "inkbox: thrown fetch is caught (sent=false, not configured skip absent)",
    { sent: res.sent, delivered: res.delivered, skipped: res.skipped ?? null },
    { sent: false, delivered: 0, skipped: null },
  );
  expect(
    "inkbox: network error captured",
    (res.errors ?? []).some((e) => e.includes("network down")),
  );
}
{
  // not configured → skipped, zero requests
  const calls: string[] = [];
  const mockFetch: InkboxFetch = async () => {
    calls.push("x");
    return { ok: true, status: 200, text: async () => "" };
  };
  const noKey = await sendImessageToRecipients(inkboxCfg(["+1"], null), "hi", mockFetch);
  expectEq(
    "inkbox: no API key → skipped, no request",
    { skipped: noKey.skipped, calls: calls.length },
    { skipped: "INKBOX_API_KEY not set", calls: 0 },
  );
  const noRecip = await sendImessageToRecipients(inkboxCfg([]), "hi", mockFetch);
  expectEq(
    "inkbox: no recipients → skipped",
    noRecip.skipped,
    "INKBOX_DISPATCH_RECIPIENTS not set",
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 13) LIVE DISPATCH (Step 7) — drive time, free rep, hard rules, scoring,
//     the planner, manager texts, the watchdog, markers + language.
// ════════════════════════════════════════════════════════════════════════════
const SD_A = { lat: 32.8, lng: -117.1 };
const SD_NEAR = { lat: 32.81, lng: -117.11 };
const SD_FAR = { lat: 32.98, lng: -117.26 };

function mkLead(over: Partial<DispatchLead>): DispatchLead {
  return {
    itemId: "L",
    name: "Lead",
    boardId: "B",
    reps: [],
    issLabel: "Not Issued",
    apptWallMinutes: 14 * 60,
    coords: null,
    products: [],
    isReset: false,
    isJobWalk: false,
    isCanSave: false,
    isRehash: false,
    excludedReps: [],
    jobWalkReps: [],
    requestedLanguage: null,
    olderHomeowner: false,
    ...over,
  };
}
function mkRep(over: Partial<DispatchRep>): DispatchRep {
  return {
    name: "Rep Name",
    office: "SD",
    working: true,
    off: false,
    openLeadCount: 0,
    lastCoords: null,
    ...over,
  };
}

// ── drive time ──
{
  expectEq("drive: same point = 0 min", driveMinutes(SD_A, SD_A), 0);
  expectEq(
    "drive: missing coords → default padding",
    driveMinutes(null, SD_A),
    DISPATCH_CONFIG.defaultDriveMinutes,
  );
  expect("drive: distinct points > 0 min", driveMinutes(SD_A, SD_FAR) > 0);
  expect("haversine: SD_A→SD_FAR is several miles", haversineMiles(SD_A, SD_FAR) > 5);
  expect("drive: near < far", driveMinutes(SD_A, SD_NEAR) < driveMinutes(SD_A, SD_FAR));
}

// ── free rep ──
{
  expect("free: working, zero open leads", isFreeRep(mkRep({ openLeadCount: 0 })));
  expect("not free: holds an open lead", !isFreeRep(mkRep({ openLeadCount: 1 })));
  expect("not free: marked Off", !isFreeRep(mkRep({ off: true })));
  expect("not free: not working", !isFreeRep(mkRep({ working: false })));
}

// ── strength table ──
{
  expectEq(
    "strength: Yakup + roof",
    strengthBonus("Yakup Sancakli", mkLead({ products: ["roof"] })),
    3,
  );
  expectEq(
    "strength: Yakup + roof + older homeowner",
    strengthBonus("Yakup Sancakli", mkLead({ products: ["roof"], olderHomeowner: true })),
    5,
  );
  expectEq("strength: Jaxon + reset", strengthBonus("Jaxon Heilman", mkLead({ isReset: true })), 3);
  expectEq(
    "strength: Nick + stucco/paint",
    strengthBonus("Nick Doe", mkLead({ products: ["stucco/paint"] })),
    3,
  );
  expectEq(
    "strength: Josiah evening penalty",
    strengthBonus("Josiah Doe", mkLead({ apptWallMinutes: 18 * 60 })),
    -4,
  );
  expectEq("strength: Edward + reset", strengthBonus("Edward Doe", mkLead({ isReset: true })), 3);
  expectEq(
    "strength: unknown rep = 0",
    strengthBonus("Nobody Here", mkLead({ products: ["roof"] })),
    0,
  );
}

// ── scoring ──
{
  const rep = mkRep({ lastCoords: SD_A });
  const near = scoreCandidate(rep, mkLead({ itemId: "near", coords: SD_NEAR }), 10 * 60);
  const far = scoreCandidate(rep, mkLead({ itemId: "far", coords: SD_FAR }), 10 * 60);
  expect("score: nearer lead scores higher", near.score > far.score);
  expect("score: nearer has fewer drive minutes", near.driveMinutes < far.driveMinutes);
}

// ── hard rules ──
{
  const rep = mkRep({ name: "Jaxon Heilman" });
  const lang = hardRuleCheck(rep, mkLead({ requestedLanguage: "Spanish" }));
  expectEq("hard: language → manager", lang.ok === false && lang.disposition, "manager");
  const rehash = hardRuleCheck(rep, mkLead({ isRehash: true, excludedReps: ["Jaxon Heilman"] }));
  expectEq("hard: rehash to prior rep → skip", rehash.ok === false && rehash.disposition, "skip");
  const okRep = hardRuleCheck(rep, mkLead({ isRehash: true, excludedReps: ["Someone Else"] }));
  expect("hard: rehash to a fresh rep → ok", okRep.ok === true);
  const saver = hardRuleCheck(mkRep({ name: "Yakup Sancakli" }), mkLead({ isCanSave: true }));
  expect("hard: can-save to a designated saver → ok", saver.ok === true);
  const nonSaver = hardRuleCheck(rep, mkLead({ isCanSave: true }));
  expectEq(
    "hard: can-save to non-saver → skip",
    nonSaver.ok === false && nonSaver.disposition,
    "skip",
  );
  const jwOrig = hardRuleCheck(rep, mkLead({ isJobWalk: true, jobWalkReps: ["Jaxon Heilman"] }));
  expect("hard: job walk to its original rep → ok", jwOrig.ok === true);
  const jwOther = hardRuleCheck(rep, mkLead({ isJobWalk: true, jobWalkReps: ["Someone Else"] }));
  expectEq(
    "hard: job walk to another rep → skip",
    jwOther.ok === false && jwOther.disposition,
    "skip",
  );
  const jwOrphan = hardRuleCheck(rep, mkLead({ isJobWalk: true, jobWalkReps: [] }));
  expectEq(
    "hard: job walk w/ unknown original → manager",
    jwOrphan.ok === false && jwOrphan.disposition,
    "manager",
  );
}

// ── the planner ──
{
  const rep = mkRep({ name: "Jaxon Heilman", lastCoords: SD_A });
  // basic issue (Tier B, time ok)
  const basic = planIssue({
    rep,
    dayLeads: [mkLead({ itemId: "b1", apptWallMinutes: 14 * 60 })],
    nowWallMinutes: 10 * 60,
  });
  expectEq(
    "plan: free rep gets the open lead",
    basic.action === "issue" && basic.lead.itemId,
    "b1",
  );

  // not free
  expectEq(
    "plan: busy rep gets nothing",
    planIssue({ rep: mkRep({ openLeadCount: 1 }), dayLeads: [mkLead({})], nowWallMinutes: 600 })
      .action,
    "none",
  );

  // time rule: too soon for the normal 45-min rule (now 10:00 + 20 drive + 45
  // = 11:05; lead at 10:30). Since the 10/6 brief this NEARBY uncovered lead
  // is rescued by the back-to-back rule instead of going uncovered; the same
  // lead carried by ANOTHER rep is still plainly skipped.
  const soon = planIssue({
    rep,
    dayLeads: [mkLead({ itemId: "soon", apptWallMinutes: 630 })],
    nowWallMinutes: 600,
  });
  expect(
    "plan: too-soon uncovered lead falls to back-to-back",
    soon.action === "issue" && soon.reason.startsWith("back-to-back"),
  );
  expectEq(
    "plan: too-soon lead held by another rep is skipped",
    planIssue({
      rep,
      dayLeads: [mkLead({ itemId: "soon2", reps: ["Someone Else"], apptWallMinutes: 630 })],
      nowWallMinutes: 600,
    }).action,
    "none",
  );

  // Tier A (own reset) beats a nearer Tier B lead
  const tier = planIssue({
    rep,
    dayLeads: [
      mkLead({
        itemId: "A",
        reps: ["Jaxon Heilman"],
        isReset: true,
        coords: SD_FAR,
        apptWallMinutes: 14 * 60,
      }),
      mkLead({ itemId: "B", coords: SD_NEAR, apptWallMinutes: 14 * 60 }),
    ],
    nowWallMinutes: 600,
  });
  expectEq("plan: own reset/job walk goes first", tier.action === "issue" && tier.lead.itemId, "A");

  // nearest Tier B wins
  const nearest = planIssue({
    rep,
    dayLeads: [
      mkLead({ itemId: "near", coords: SD_NEAR, apptWallMinutes: 14 * 60 }),
      mkLead({ itemId: "far", coords: SD_FAR, apptWallMinutes: 14 * 60 }),
    ],
    nowWallMinutes: 600,
  });
  expectEq(
    "plan: nearest open lead wins",
    nearest.action === "issue" && nearest.lead.itemId,
    "near",
  );

  // strength breaks a drive tie (both coordless → equal drive)
  const tieBreak = planIssue({
    rep: mkRep({ name: "Yakup Sancakli" }),
    dayLeads: [
      mkLead({ itemId: "plain", apptWallMinutes: 14 * 60 }),
      mkLead({ itemId: "roof", products: ["roof"], apptWallMinutes: 14 * 60 }),
    ],
    nowWallMinutes: 600,
  });
  expectEq(
    "plan: strength breaks a drive-time tie",
    tieBreak.action === "issue" && tieBreak.lead.itemId,
    "roof",
  );

  // own-flow Iss statuses never auto-issue
  expectEq(
    "plan: Office Appt is never issued",
    planIssue({
      rep,
      dayLeads: [mkLead({ issLabel: "Office Appt", apptWallMinutes: 14 * 60 })],
      nowWallMinutes: 600,
    }).action,
    "none",
  );

  // language lead → manager
  const mgr = planIssue({
    rep,
    dayLeads: [mkLead({ itemId: "es", requestedLanguage: "Spanish", apptWallMinutes: 14 * 60 })],
    nowWallMinutes: 600,
  });
  expectEq("plan: language lead → manager", mgr.action === "manager" && mgr.lead.itemId, "es");

  // can-save only to a saver
  expectEq(
    "plan: can-save to non-saver → none",
    planIssue({
      rep,
      dayLeads: [mkLead({ isCanSave: true, apptWallMinutes: 14 * 60 })],
      nowWallMinutes: 600,
    }).action,
    "none",
  );
  expectEq(
    "plan: can-save to a saver → issue",
    planIssue({
      rep: mkRep({ name: "Jonathan Paz" }),
      dayLeads: [mkLead({ itemId: "cs", isCanSave: true, apptWallMinutes: 14 * 60 })],
      nowWallMinutes: 600,
    }).action,
    "issue",
  );
}

// ── manager texts ──
{
  const text = buildIssuedText({
    repName: "jaxon heilman",
    lead: mkLead({ name: "Valley View", products: ["roof"], apptWallMinutes: 13 * 60 }),
    outOfLeadName: "Ingebretson",
    outOfResultLabel: "PM",
    dryRun: false,
  });
  expect(
    "text: Issued line names the rep + lead + out-of",
    /^Issued: Jaxon → 1pm Valley View \(roof\) – out of Ingebretson \(PM\)\.$/.test(text),
  );
  const dry = buildIssuedText({
    repName: "jaxon",
    lead: mkLead({ name: "Valley View", apptWallMinutes: 13 * 60 }),
    outOfLeadName: null,
    outOfResultLabel: null,
    dryRun: true,
  });
  expect("text: dry-run prefix", dry.startsWith("[DRY RUN] would issue: Jaxon →"));
  expectEq(
    "text: free-reps line",
    buildFreeRepsLine(["jaxon", "nick"]),
    "Free reps (no lead to give): Jaxon, Nick.",
  );
  expectEq("text: empty free-reps line", buildFreeRepsLine([]), "");
}

// ── watchdog ──
{
  const uncovered: WatchdogLead = {
    itemId: "u1",
    name: "Smith",
    apptWallMinutes: 640,
    reps: [],
    issLabel: "Not Issued",
  };
  const covered: WatchdogLead = {
    itemId: "c1",
    name: "Jones",
    apptWallMinutes: 640,
    reps: ["Al"],
    issLabel: "Iss",
  };
  const base = {
    nowWallMinutes: 600,
    leads: [uncovered, covered],
    lateReporters: ["Bob"],
    workingReps: [mkRep({ name: "Al" })],
    alreadyAlerted: new Set<string>(),
  };
  const r1 = planWatchdog({ ...base, freeReps: [] });
  expectEq("watchdog: alerts the uncovered lead when nobody is free", r1.alerts.length, 1);
  expectEq("watchdog: the alerted lead is the uncovered one", r1.alerts[0]?.lead.itemId, "u1");
  expectEq("watchdog: passes the late reporters through", r1.lateReporters, ["Bob"]);
  const r2 = planWatchdog({ ...base, freeReps: [mkRep({ name: "Al" })] });
  expectEq("watchdog: a free rep means no alert", r2.alerts.length, 0);
  const r3 = planWatchdog({ ...base, freeReps: [], alreadyAlerted: new Set(["u1"]) });
  expectEq("watchdog: never alerts the same lead twice", r3.alerts.length, 0);
  const far: WatchdogLead = {
    itemId: "f1",
    name: "Far",
    apptWallMinutes: 800,
    reps: [],
    issLabel: "Not Issued",
  };
  const r4 = planWatchdog({ ...base, leads: [far], freeReps: [] });
  expectEq("watchdog: a lead beyond the window is not alerted", r4.alerts.length, 0);
}

// ── late reporters ──
{
  const late = findLateReporters({
    nowWallMinutes: 600,
    leads: [
      { reps: ["Bob"], issLabel: "Iss", apptWallMinutes: 540, disposition: false }, // overdue
      { reps: ["Al"], issLabel: "Iss", apptWallMinutes: 540, disposition: true }, // reported
      { reps: ["Cy"], issLabel: "Iss", apptWallMinutes: 660, disposition: false }, // future
      { reps: ["Dan"], issLabel: "Not Issued", apptWallMinutes: 540, disposition: false }, // not issued
    ],
  });
  expectEq("late: only the overdue, unreported, issued lead counts", late, ["Bob"]);
}

// ── window + clock + markers + language ──
{
  expect("window: 7am in", inWatchdogWindow(7));
  expect("window: 6am out", !inWatchdogWindow(6));
  expect("window: 8pm in", inWatchdogWindow(20));
  expect("window: 9pm out", !inWatchdogWindow(21));

  expectEq("clock: 1pm", wallClock12(13 * 60), "1pm");
  expectEq("clock: 1:30pm", wallClock12(13 * 60 + 30), "1:30pm");
  expectEq("clock: 9am", wallClock12(9 * 60), "9am");
  expectEq("clock: midnight", wallClock12(0), "12am");
  expectEq("nowWall: 10:08 PT", dispatchNowWall(pdt("2026-10-04", 10, 8)), 608);

  expectEq("firstName: Yakup", firstName("Yakup Sancakli"), "yakup");
  // Attendance match is by FIRST NAME — the SD board labels rows loosely.
  expectEq("firstName: annotated SD row", firstName("Jaxon no day off reply"), "jaxon");
  expect(
    "sameRep: Jaxon full ↔ 'Jaxon no day off reply'",
    sameRep("Jaxon Heilman", "Jaxon no day off reply"),
  );
  expect("sameRep: Josh O'Connor ↔ O'Conner typo", sameRep("Josh O'Connor", "Josh O'Conner"));
  expect("sameRep: Nick Schoeben ↔ 'Nick S'", sameRep("Nick Schoeben", "Nick S"));
  expect("sameRep: Jovanny Paz ≠ Jonathan Paz", !sameRep("Jovanny Paz unsure", "Jonathan Paz"));
  expect("sameRep: empty never matches", !sameRep("", "Anyone"));
  expectEq("lang: prefers spanish", detectRequestedLanguage("HO prefers Spanish only"), "Spanish");
  expectEq("lang: habla espanol", detectRequestedLanguage("cliente habla espanol"), "Spanish");
  expectEq("lang: none", detectRequestedLanguage("regular roof lead"), null);
  expect("marker: rehash", isRehashMarker("REHASH from last week"));
  expect("marker: can/save", isCanSaveMarker("Can/Save — call back"));
  expect("marker: job walk", isJobWalkMarker("job walk for the sold roof"));
  expect("marker: older homeowner", isOlderHomeownerMarker("elderly homeowner, be patient"));
  expect("marker: no false rehash", !isRehashMarker("fresh canvass lead"));
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 7 FOLLOW-UP RULES (owner brief 2026-10-06)
// ════════════════════════════════════════════════════════════════════════════

// ── per-office Source Code column (the one id that differs SD vs OC) ─────────
{
  expectEq("source code col: SD", SOURCE_CODE_COL.SD, "numeric_mm35kwnj");
  expectEq("source code col: OC", SOURCE_CODE_COL.OC, "numeric_mm35nm4y");
  expect("source code col: ids differ", SOURCE_CODE_COL.SD !== SOURCE_CODE_COL.OC);
}

// ── matching fallback: customer last name + rep on today's group ────────────
{
  const items = [
    { itemId: "1", name: "Smith, John", reps: ["Jaxon Heilman"] },
    { itemId: "2", name: "Garcia Maria", reps: ["Nick Schoeben"] },
  ];
  expectEq(
    "match: last name + rep → the one item",
    matchByLastNameAndRep({
      customerName: "John Smith",
      repName: "Jaxon Heilman",
      partner: null,
      items,
    }),
    { kind: "match", itemId: "1" },
  );
  expectEq(
    "match: partner on the card also matches",
    matchByLastNameAndRep({
      customerName: "John Smith",
      repName: "Somebody Else",
      partner: "Jaxon Heilman",
      items,
    }),
    { kind: "match", itemId: "1" },
  );
  expectEq(
    "match: right name, wrong rep → none",
    matchByLastNameAndRep({
      customerName: "John Smith",
      repName: "Nick Schoeben",
      partner: null,
      items,
    }),
    { kind: "none" },
  );
  expectEq(
    "match: two hits → ambiguous (Needs review)",
    matchByLastNameAndRep({
      customerName: "John Smith",
      repName: "Jaxon Heilman",
      partner: null,
      items: [...items, { itemId: "3", name: "Bob Smith", reps: ["Jaxon Heilman"] }],
    }),
    { kind: "ambiguous", count: 2 },
  );
  expectEq("lastNameOf: strips (copy)", lastNameOf("Smith, John (copy 2)"), "john");
  expect("sameCustomer: containment both ways", sameCustomer("John Smith", "john smith (copy)"));
  expect("sameCustomer: different people", !sameCustomer("John Smith", "Maria Garcia"));
}

// ── payment details from the rep's words (Sold follow-up) ────────────────────
{
  const p1 = parsePaymentDetails("29sq 250 debit , balance 20k service / 10249 on synchrony");
  expectEq("pay: '250 debit' → $250 deposit", p1.depositAmount, 250);
  expectEq("pay: deposit method debit", p1.depositMethod, "debit");
  expectEq("pay: balance methods after 'balance'", p1.financeLabels, [
    "Synchrony",
    "Service Finance",
  ]);
  expectEq("pay: no membership stated → null", p1.advantage, null);

  const p2 = parsePaymentDetails("Advantage+ member. 500 check, balance on homerun");
  expectEq("pay: Advantage+", p2.advantage, ADVANTAGE_LABEL.member);
  expectEq("pay: $500 check deposit", p2.depositAmount, 500);
  expectEq("pay: Homerun balance", p2.financeLabels, ["Homerun"]);

  expectEq(
    "pay: non member wins over 'member'",
    parsePaymentDetails("went non member").advantage,
    ADVANTAGE_LABEL.nonMember,
  );
  expectEq("pay: '20k down' → 20000", parsePaymentDetails("20k down, renew").depositAmount, 20000);
  const empty = parsePaymentDetails("32sq wants other bids");
  expectEq("pay: nothing stated → all null (never invent)", empty, {
    depositAmount: null,
    depositMethod: null,
    financeLabels: [],
    advantage: null,
  });

  const soldForm = parseOohForm(
    "f1",
    form({
      [FORM_COL.repName]: status(4, "Jaxon Heilman"),
      [FORM_COL.result]: status(RESULT.SOLD),
      [FORM_COL.dropCall]: status(0, "Tyler"),
    }),
  );
  expectEq(
    "missing: full report → nothing missing",
    soldFollowupMissing(soldForm, {
      depositAmount: 250,
      depositMethod: "debit",
      financeLabels: ["Synchrony"],
      advantage: ADVANTAGE_LABEL.member,
    }),
    [],
  );
  const bare = parseOohForm(
    "f2",
    form({
      [FORM_COL.result]: status(RESULT.SOLD),
      [FORM_COL.dropCall]: status(4, "No drop call"),
    }),
  );
  expectEq("missing: bare report lists all five", soldFollowupMissing(bare, empty), [
    "deposit amount",
    "deposit method",
    "balance method",
    "drop call",
    "Advantage+",
  ]);
  expect(
    "missing text names the customer + items",
    buildSalesProcMissingText("Smith", ["deposit amount", "Advantage+"]).includes(
      "Smith: missing deposit amount, Advantage+",
    ),
  );
  expectEq("salesproc: board id", SALESPROC_BOARD_ID, "4155553389");
  expectEq("salesproc: column ids", SALESPROC_COL, {
    deposit: "numbers5",
    finance: "dropdown6",
    advantage: "color_mkwkmx6g",
    reloads: "dup__of_product9",
  });
}

// ── every Sold: add-on Reloads beyond the main product + future reloads ─────
{
  expectEq(
    "reloads: gutters sold with a roof lead",
    addOnReloadLabels({ quoted: "Roof, Gutters", blockProducts: ["roof"], notes: null }),
    ["Gutters"],
  );
  expectEq(
    "reloads: 'will reload turf' in the notes",
    addOnReloadLabels({
      quoted: "Roof",
      blockProducts: ["roof"],
      notes: "will reload turf next month",
    }),
    ["Turf"],
  );
  expectEq(
    "reloads: product named without 'reload' doesn't count",
    addOnReloadLabels({ quoted: "Roof", blockProducts: ["roof"], notes: "talked about turf" }),
    [],
  );
  expectEq(
    "reloads: quoted = the lead's own product → none",
    addOnReloadLabels({ quoted: "Roof", blockProducts: ["roof"], notes: null }),
    [],
  );
}

// ── off-block add (upsell / reload / self-gen) ───────────────────────────────
{
  expectEq(
    "off-block: products map",
    productsDropdownLabels(
      "Roof, Paint / stucco / CoolWall, Solar R&R, Trim / eaves / fascia, Other",
    ),
    ["Roof", "Stucco/Paint", "Solar R/R", "Eaves/Fascia"],
  );
  expectEq("off-block: flat roof beats roof", productsDropdownLabels("Flat roof"), ["Flat Roof"]);

  expectEq("off-block: source text upsell", offBlockSourceText(ON_BLOCK.UPSELL), "Upsell");
  expectEq("off-block: source text self-gen", offBlockSourceText(ON_BLOCK.SELF_GEN), "Self Gen");
  expectEq("off-block: on-block Yes → no channel", offBlockSourceText(ON_BLOCK.YES), null);

  const selfGen = parseOohForm(
    "f3",
    form({
      [FORM_COL.repName]: status(4, "Jaxon Heilman"),
      [FORM_COL.result]: status(RESULT.SOLD),
      [FORM_COL.onBlock]: status(ON_BLOCK.SELF_GEN),
      [FORM_COL.phone]: text("6191234567"),
      [FORM_COL.quoted]: text("Roof"),
      [FORM_COL.address]: text("123 Main St"),
      [FORM_COL.salePrice]: num(12000),
    }),
  );
  const create = buildOffBlockCreate({
    form: selfGen,
    customerName: "John Smith",
    submitMs: SUBMIT,
    office: "SD",
    repUserIds: ["111", "222"],
  });
  expect("off-block create: built", create !== null);
  if (create) {
    expectEq("off-block create: name = customer", create.name, "John Smith");
    expectEq(
      "off-block create: self-gen status pre-set to Iss (103) — no lead text",
      create.columnValues[BLOCK_COL.iss],
      { index: ISS_CREATE_INDEX.iss },
    );
    expectEq(
      "off-block create: Source = Self Gen",
      create.columnValues[BLOCK_COL.source],
      "Self Gen",
    );
    expectEq(
      "off-block create: date9 = submit time in UTC",
      create.columnValues[BLOCK_COL.apptDateTime],
      { date: "2026-10-04", time: "17:08:00" },
    );
    expectEq(
      "off-block create: Source Code 1 (SD col)",
      create.columnValues[SOURCE_CODE_COL.SD],
      "1",
    );
    expectEq("off-block create: phone", create.columnValues[BLOCK_COL.phone], {
      phone: "6191234567",
      countryShortName: "US",
    });
    expectEq("off-block create: both reps on people6", create.columnValues[BLOCK_COL.reps], {
      personsAndTeams: [
        { id: 111, kind: "person" },
        { id: 222, kind: "person" },
      ],
    });
    expectEq("off-block create: quoted products", create.columnValues[BLOCK_COL.products], {
      labels: ["Roof"],
    });
    expectEq(
      "off-block create: address kept in Comments",
      create.columnValues[BLOCK_COL.comments],
      {
        text: "123 Main St",
      },
    );
  }
  const upsell = buildOffBlockCreate({
    form: { ...selfGen, onBlock: ON_BLOCK.UPSELL },
    customerName: "John Smith",
    submitMs: SUBMIT,
    office: "OC",
    repUserIds: [],
  });
  expectEq(
    "off-block create: upsell status pre-set to Reload (1)",
    upsell?.columnValues[BLOCK_COL.iss],
    { index: ISS_CREATE_INDEX.reload },
  );
  expect(
    "off-block create: OC uses the OC Source Code col",
    upsell?.columnValues[SOURCE_CODE_COL.OC] === "1" &&
      upsell?.columnValues[SOURCE_CODE_COL.SD] === undefined,
  );
  expectEq(
    "off-block text",
    buildOffBlockText({ ...selfGen, onBlock: ON_BLOCK.UPSELL }, "Smith"),
    "Off-block Upsell: Jaxon Heilman – Smith – $12,000 (Upsell). Added to today's block.",
  );
}

// ── can-saves: Details only, press NO button ─────────────────────────────────
{
  expect(
    "can-save: Office Appt + marker",
    isCanSaveOfficeAppt({ issLabel: "Office Appt", freeText: "Can/Save — WCC cancelled" }),
  );
  expect(
    "can-save: Iss status is not a can-save",
    !isCanSaveOfficeAppt({ issLabel: "Iss", freeText: "Can/Save" }),
  );
  expect(
    "can-save: Office Appt without the marker is a job walk/appt",
    !isCanSaveOfficeAppt({ issLabel: "Office Appt", freeText: "job walk" }),
  );
  const pmForm = parseOohForm(
    "f4",
    form({
      [FORM_COL.result]: status(RESULT.PITCH_MISS),
      [FORM_COL.notes]: text("upset about price, no save"),
    }),
  );
  expectEq(
    "can-save details: no save + notes + out time",
    buildCanSaveDetails(pmForm, SUBMIT),
    "Can-save – no save. upset about price, no save (10:08)",
  );
  const savedForm = parseOohForm(
    "f5",
    form({ [FORM_COL.result]: status(RESULT.SOLD), [FORM_COL.salePrice]: num(9000) }),
  );
  expectEq(
    "can-save details: a save shows SAVED + the price",
    buildCanSaveDetails(savedForm, SUBMIT),
    "Can-save – SAVED. Sale $9,000 (10:08)",
  );
}

// ── pairing table (Daniel never alone; best/avoid pairs) ─────────────────────
{
  const jaxon = mkRep({ name: "Jaxon Heilman" });
  const daniel = mkRep({ name: "Daniel Figueiredo" });
  const yakup = mkRep({ name: "Yakup Sancakli" });

  expectEq("pair: one plain rep goes solo", decidePairing([jaxon]).groups, [[jaxon]]);
  const dAlone = decidePairing([daniel]);
  expectEq("pair: Daniel alone is held for the managers", dAlone.holdAlone, [daniel]);
  expectEq("pair: Daniel alone gets no group", dAlone.groups, []);
  expectEq(
    "pair: Daniel freed with a partner rides WITH them (one lead)",
    decidePairing([daniel, jaxon]).groups,
    [[daniel, jaxon]],
  );
  expectEq("pair: two plain reps split", decidePairing([jaxon, yakup]).groups, [[jaxon], [yakup]]);

  const bestCfg = {
    ...DISPATCH_CONFIG,
    pairing: { neverAlone: [], best: [["jaxon", "yakup"]], avoid: [] },
  } as typeof DISPATCH_CONFIG;
  expectEq("pair: a best pair stays together", decidePairing([jaxon, yakup], bestCfg).groups, [
    [jaxon, yakup],
  ]);
  const avoidCfg = {
    ...DISPATCH_CONFIG,
    pairing: { neverAlone: ["daniel"], best: [], avoid: [["daniel", "jaxon"]] },
  } as typeof DISPATCH_CONFIG;
  const avoided = decidePairing([daniel, jaxon], avoidCfg);
  expectEq("pair: an avoid pair splits", avoided.groups, [[jaxon]]);
  expectEq("pair: the neverAlone half of an avoid pair is held", avoided.holdAlone, [daniel]);
  expect(
    "pair: never-alone text names the rep",
    buildNeverAloneText("Daniel Figueiredo").startsWith("Daniel is free but never rides alone"),
  );
}

// ── joint issuing (a pair shares ONE lead; hard rules bind BOTH) ─────────────
{
  const jaxon = mkRep({ name: "Jaxon Heilman", lastCoords: SD_A });
  const yakup = mkRep({ name: "Yakup Sancakli", lastCoords: SD_A });
  const now = 10 * 60;
  // A can-save: Yakup is a designated saver, Jaxon is not → the PAIR can't take it.
  const canSave = mkLead({ itemId: "cs", isCanSave: true, apptWallMinutes: now + 120 });
  const p1 = planIssue({ rep: yakup, coRep: jaxon, dayLeads: [canSave], nowWallMinutes: now });
  expectEq("joint: can-save blocked when the partner isn't a saver", p1.action, "none");
  // The partner's own Not-Issued reset is Tier A for the pair.
  const partnersReset = mkLead({
    itemId: "rs",
    reps: ["Jaxon Heilman"],
    isReset: true,
    apptWallMinutes: now + 120,
  });
  const p2 = planIssue({
    rep: yakup,
    coRep: jaxon,
    dayLeads: [partnersReset],
    nowWallMinutes: now,
  });
  expect(
    "joint: partner's reset is Tier A for the pair",
    p2.action === "issue" && p2.lead.itemId === "rs",
  );
  // Strength of the pair = the stronger rep's fit (Yakup on a roof).
  const roof = mkLead({ itemId: "rf", products: ["roof"], apptWallMinutes: now + 120 });
  const p3 = planIssue({ rep: jaxon, coRep: yakup, dayLeads: [roof], nowWallMinutes: now });
  expect("joint: pair strength = the stronger fit", p3.action === "issue" && p3.strength === 3);
}

// ── back-to-back exception (near/past uncovered lead, nearby) ────────────────
{
  const rep = mkRep({ name: "Jaxon Heilman", lastCoords: SD_A });
  const now = 13 * 60;
  // Started 10 minutes ago, same neighborhood (drive 0) → issue, ~10 min late.
  const passed = mkLead({ itemId: "late1", coords: SD_A, apptWallMinutes: now - 10 });
  const p1 = planIssue({ rep, dayLeads: [passed], nowWallMinutes: now });
  expect(
    "b2b: near/past uncovered lead goes to the freed rep",
    p1.action === "issue" && p1.lead.itemId === "late1",
  );
  expectEq("b2b: lateness is measured", p1.action === "issue" ? p1.lateMinutes : null, 10);
  // Too far away → not back-to-back.
  const farLate = mkLead({ itemId: "late2", coords: SD_FAR, apptWallMinutes: now - 10 });
  expectEq(
    "b2b: a lead too far away is not resurrected",
    planIssue({ rep, dayLeads: [farLate], nowWallMinutes: now }).action,
    "none",
  );
  // Started too long ago → gone.
  const ancient = mkLead({ itemId: "late3", coords: SD_A, apptWallMinutes: now - 70 });
  expectEq(
    "b2b: a lead started >60 min ago is not resurrected",
    planIssue({ rep, dayLeads: [ancient], nowWallMinutes: now }).action,
    "none",
  );
  // A normal future candidate still wins over a back-to-back one.
  const future = mkLead({ itemId: "fut", coords: SD_A, apptWallMinutes: now + 120 });
  const p2 = planIssue({ rep, dayLeads: [passed, future], nowWallMinutes: now });
  expect(
    "b2b: a normal candidate beats the late one",
    p2.action === "issue" && p2.lead.itemId === "fut",
  );
  // The Issued text carries the late warning.
  const txt = buildIssuedText({
    repName: "Jaxon Heilman",
    partnerName: "Daniel Figueiredo",
    lead: mkLead({ name: "Valley", apptWallMinutes: 13 * 60, products: ["roof"] }),
    outOfLeadName: "Ingebretson",
    outOfResultLabel: "PM",
    dryRun: false,
    lateMinutes: 12,
  });
  expectEq(
    "text: pair + late note",
    txt,
    "Issued: Jaxon & Daniel → 1pm Valley (roof) – out of Ingebretson (PM). Running ~12 min late, office please call customer.",
  );
}

// ── attendance overrides beat the board ──────────────────────────────────────
{
  expectEq(
    "override: 'on' turns a board-Off rep on",
    attendanceWithOverride({ working: false, off: true }, "on"),
    { working: true, off: false },
  );
  expectEq(
    "override: 'off' benches a board-On rep",
    attendanceWithOverride({ working: true, off: false }, "off"),
    { working: false, off: true },
  );
  expectEq(
    "override: none → the board stands",
    attendanceWithOverride({ working: true, off: false }, null),
    { working: true, off: false },
  );
}

// ── missing-report watchdog (3+ hours past start, once) ──────────────────────
{
  const now = 16 * 60; // 4 pm
  const leads = [
    // 1 pm start, no report → 3h late → alert.
    {
      itemId: "m1",
      name: "Smith",
      reps: ["Jaxon Heilman"],
      issLabel: "Iss",
      apptWallMinutes: 13 * 60,
      disposition: false,
    },
    // 2 pm start → only 2h → not yet.
    {
      itemId: "m2",
      name: "Jones",
      reps: ["Nick S"],
      issLabel: "Iss",
      apptWallMinutes: 14 * 60,
      disposition: false,
    },
    // 1 pm but reported → fine.
    {
      itemId: "m3",
      name: "Lee",
      reps: ["Yakup"],
      issLabel: "Iss",
      apptWallMinutes: 13 * 60,
      disposition: true,
    },
    // Not issued → the uncovered watchdog's problem, not this one's.
    {
      itemId: "m4",
      name: "Kim",
      reps: [],
      issLabel: "Not Issued",
      apptWallMinutes: 12 * 60,
      disposition: false,
    },
  ];
  const hits = planMissingReports({ nowWallMinutes: now, leads, alreadyAlerted: new Set() });
  expectEq(
    "missing-report: only the 3h+ unreported issued lead",
    hits.map((h) => h.itemId),
    ["m1"],
  );
  const again = planMissingReports({ nowWallMinutes: now, leads, alreadyAlerted: new Set(["m1"]) });
  expectEq("missing-report: never alerts the same lead twice", again.length, 0);
  expectEq(
    "missing-report: the one manager text",
    buildMissingReportText(hits),
    "⏰ No report 3+ hrs after start: Jaxon – Smith (1pm). Please chase the report.",
  );
}

// ── paired reps: the second report on the same lead is a duplicate ──────────
{
  expectEq(
    "second report: untouched lead proceeds",
    secondReportOutcome({ alreadyDispositioned: false, writtenByUs: false }),
    "proceed",
  );
  expectEq(
    "second report: we already wrote it → duplicate (Processed, no writes)",
    secondReportOutcome({ alreadyDispositioned: true, writtenByUs: true }),
    "duplicate",
  );
  expectEq(
    "second report: a human pressed it → Needs review",
    secondReportOutcome({ alreadyDispositioned: true, writtenByUs: false }),
    "needs_review",
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll OOH write-back assertions passed.");
