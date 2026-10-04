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
  AUTO_ISSUE_WITHOUT_REPORT,
  BLOCK_COL,
  FORM_COL,
  LABEL,
  ON_BLOCK,
  RESULT,
  applyDisposition,
  buildDetailsLine,
  isDuplicate,
  laClock,
  lateReportCheck,
  matchTarget,
  parseOohForm,
  planDisposition,
  planRelease,
  sourceCodeToWrite,
  timeInHouseMins,
  type AppliedOp,
  type ColMap,
  type DayItem,
  type MondayValue,
  type MondayWriter,
  type OohForm,
} from "../supabase/functions/monday-ooh-report/engine";

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
expectEq("PM w/ reset → status_1 PM w/ RS", mapCase(RESULT.PM_WITH_RESET, ON_BLOCK.YES).status, {
  col: BLOCK_COL.pm,
  label: LABEL.pmReset,
});
expectEq("Reset → status_2 Reset", mapCase(RESULT.RESET, ON_BLOCK.YES).status, {
  col: BLOCK_COL.rs,
  label: LABEL.reset,
});
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

// Reload also writes the Reloads dropdown "Room"; Sold writes Sale Price.
expectEq(
  "Reload writes Reloads=Room",
  mapCase(RESULT.SOLD, ON_BLOCK.RELOAD).fieldWrites[BLOCK_COL.reloads],
  { labels: ["Room"] },
);
expectEq(
  "Sold writes Sale Price",
  mapCase(RESULT.SOLD, ON_BLOCK.YES, { [FORM_COL.salePrice]: num(50000) }).fieldWrites[
    BLOCK_COL.salePrice
  ],
  "50000",
);
// Only ONE disposition status is ever set.
for (const r of Object.values(RESULT)) {
  const p = mapCase(r, ON_BLOCK.YES);
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
): DayItem => ({ id, reps, statusLabel, timeMs });
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

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll OOH write-back assertions passed.");
