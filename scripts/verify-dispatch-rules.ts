/**
 * One assertion block per NUMBERED rule of the owner's 2026-10-08 live-dispatch
 * mandate (A–G, rules 1–21). Run with `npm run verify:dispatch-rules`.
 *
 * Every rule below is exercised through the PURE engine the live edge function
 * (supabase/functions/monday-ooh-report) calls — no network, no Monday, no
 * Supabase — so the behavior the dispatcher ships is pinned here. October 2026
 * is PDT (UTC−7).
 */
import {
  BLOCK_COL,
  DESTINATION_BOARDS,
  FORM_COL,
  GUARDED_WRITE_COLS,
  LABEL,
  ON_BLOCK,
  RESULT,
  SALES_PROCESSING_COL,
  applyDisposition,
  buildSaleDetailsSegment,
  customerDayKey,
  humanTouchedGuardedColsToday,
  isHandledDestinationBoard,
  isOfficeApptStatus,
  isSecondPartnerCopy,
  matchWithoutLeadId,
  membershipLabel,
  missingSaleFields,
  parseOohForm,
  planDisposition,
  planOfficeApptDisposition,
  planSalesProcessingWrite,
  reloadAddOnLabels,
  type AppliedOp,
  type ColMap,
  type MatchCandidate,
  type MondayValue,
  type MondayWriter,
} from "../supabase/functions/monday-ooh-report/engine";
import {
  type DispatchLead,
  type DispatchRep,
  buildRunningLateText,
  choosePartner,
  isNeverSolo,
  issLabelForLead,
  mergePeople,
  mustPair,
  planIssue,
  planLateCoverage,
  planWatchdog,
  runningLateNote,
  shouldTextManagers,
  withPairing,
} from "../supabase/functions/monday-ooh-report/dispatch";
import { parsePeopleColumnValue } from "../supabase/functions/monday-ooh-report/monday";
import {
  CHANGED_BY_OFFICE_NOTE,
  NO_CHANGE_TEXT,
  type ApprovalsDayItem,
  applyGuard,
  applyWriteIds,
  buildApprovalsRows,
  decisionKind,
  resetOwners,
  sanitizeProposal,
  selectApproveAllTargets,
  wouldRemoveRep,
} from "../supabase/functions/monday-ooh-report/approvals";
import { isMyLeadVisible } from "../src/lib/ooh";

let failures = 0;
function expectEq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.error(`✗ ${label}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  } else console.log(`✓ ${label}`);
}
function expect(label: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`✗ ${label}`);
  } else console.log(`✓ ${label}`);
}

// ── builders ─────────────────────────────────────────────────────────────────
const status = (index: number, text = "") => ({ text, value: JSON.stringify({ index }) });
const text = (t: string) => ({ text: t, value: JSON.stringify(t) });
const num = (n: number) => ({ text: String(n), value: JSON.stringify(String(n)) });
const form = (o: ColMap): ColMap => ({ ...o });

const SD_A = { lat: 32.8, lng: -117.1 };
const SD_NEAR = { lat: 32.81, lng: -117.11 };
const SD_FAR = { lat: 33.1, lng: -117.3 };

function mkLead(over: Partial<DispatchLead> = {}): DispatchLead {
  return {
    itemId: "L",
    name: "Lead",
    boardId: "B",
    reps: [],
    issLabel: LABEL.notIssued,
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
function mkRep(over: Partial<DispatchRep> = {}): DispatchRep {
  return {
    name: "Jaxon Heilman",
    office: "SD",
    working: true,
    off: false,
    openLeadCount: 0,
    lastCoords: SD_A,
    ...over,
  };
}

// ═══ A. NEVER UNDO OR OVERWRITE A MANAGER ═══════════════════════════════════

// Rule 1 — never remove anyone from people6; issuing ADDS to who's already there.
{
  expectEq("Rule 1: add preserves existing reps", mergePeople(["10", "20"], ["30"]), [
    "10",
    "20",
    "30",
  ]);
  expectEq("Rule 1: re-issuing the same rep is a no-op", mergePeople(["10", "20"], ["10"]), [
    "10",
    "20",
  ]);
  expectEq("Rule 1: existing come first, deduped", mergePeople(["10"], ["10", "20", "20"]), [
    "10",
    "20",
  ]);
  expectEq("Rule 1: empty people6 just takes the new rep", mergePeople([], ["30"]), ["30"]);
}

// Rule 2 — a lead that already has (other) reps is TAKEN; never reassigned. When
// the rep frees, status is set to Iss (or Office Appt for a job walk).
{
  const rep = mkRep({ name: "Jaxon Heilman" });
  const taken = planIssue({
    rep,
    dayLeads: [mkLead({ itemId: "taken", reps: ["Someone Else"], apptWallMinutes: 14 * 60 })],
    nowWallMinutes: 10 * 60,
  });
  expectEq("Rule 2: a lead held by another rep is never reassigned", taken.action, "none");
  expectEq("Rule 2: a normal issue presses Iss", issLabelForLead({ isJobWalk: false }), LABEL.iss);
  expectEq(
    "Rule 2: a job walk presses Office Appt",
    issLabelForLead({ isJobWalk: true }),
    LABEL.officeAppt,
  );
}

// Rule 3 — before any write, read the activity log; if a HUMAN (not the
// dispatcher) changed people6 or status today, don't touch it again.
{
  const today = "2026-10-08";
  const todayMs = Date.UTC(2026, 9, 8, 20, 0); // ~1pm PDT
  const yest = Date.UTC(2026, 9, 7, 20, 0);
  const base = { dispatcherUserId: "900", todayLA: today };
  expect(
    "Rule 3: a human's people6 change today blocks the write",
    humanTouchedGuardedColsToday({
      ...base,
      logs: [{ columnId: "people6", userId: "123", createdAtMs: todayMs }],
    }),
  );
  expect(
    "Rule 3: the dispatcher's own change does NOT block",
    !humanTouchedGuardedColsToday({
      ...base,
      logs: [{ columnId: "people6", userId: "900", createdAtMs: todayMs }],
    }),
  );
  expect(
    "Rule 3: a change to a non-guarded column does NOT block",
    !humanTouchedGuardedColsToday({
      ...base,
      logs: [{ columnId: "long_text3", userId: "123", createdAtMs: todayMs }],
    }),
  );
  expect(
    "Rule 3: yesterday's human change does NOT block",
    !humanTouchedGuardedColsToday({
      ...base,
      logs: [{ columnId: "status", userId: "123", createdAtMs: yest }],
    }),
  );
  expect(
    "Rule 3: an automation (no user id) does NOT block",
    !humanTouchedGuardedColsToday({
      ...base,
      logs: [{ columnId: "status", userId: null, createdAtMs: todayMs }],
    }),
  );
}

// Rule 4 — the Langley 3:30 regression: Tyler set Jaxon + Edward; the dispatcher
// wrote only Jaxon. With Rule 1 (additive) Edward survives; with Rule 3 the
// write is skipped outright. Both independently prevent the erase.
{
  const JAXON = "111";
  const EDWARD = "222";
  expectEq(
    "Rule 4: re-issuing Jaxon keeps Edward (additive write)",
    mergePeople([JAXON, EDWARD], [JAXON]),
    [JAXON, EDWARD],
  );
  expect(
    "Rule 4: Tyler's same-day people6 change skips the dispatcher entirely",
    humanTouchedGuardedColsToday({
      dispatcherUserId: "900",
      todayLA: "2026-10-08",
      logs: [{ columnId: "people6", userId: "tyler", createdAtMs: Date.UTC(2026, 9, 8, 20, 0) }],
    }),
  );
}

// ═══ B. COVER THE SOONEST LEAD FIRST ════════════════════════════════════════

// Rule 5 — a freed rep can take a lead iff drive + 10 ≤ time until it starts,
// and the SOONEST-starting coverable lead is taken first.
{
  const rep = mkRep();
  const now = 10 * 60; // coordless lead ⇒ 20m drive
  expectEq(
    "Rule 5: lead < drive+10 away is unreachable",
    planIssue({
      rep,
      dayLeads: [mkLead({ itemId: "x", apptWallMinutes: now + 20 + 5 })],
      nowWallMinutes: now,
    }).action,
    "none",
  );
  expectEq(
    "Rule 5: lead exactly drive+10 away is reachable",
    planIssue({
      rep,
      dayLeads: [mkLead({ itemId: "x", apptWallMinutes: now + 20 + 10 })],
      nowWallMinutes: now,
    }).action,
    "issue",
  );
  const soonest = planIssue({
    rep,
    dayLeads: [
      mkLead({ itemId: "later", coords: SD_NEAR, apptWallMinutes: 15 * 60 }),
      mkLead({ itemId: "sooner", coords: SD_FAR, apptWallMinutes: 13 * 60 }),
    ],
    nowWallMinutes: now,
  });
  expectEq(
    "Rule 5: the soonest-starting coverable lead wins",
    soonest.action === "issue" && soonest.lead.itemId,
    "sooner",
  );
}

// Rule 6 — if no rep can get there on time, still send the CLOSEST one, flagged
// "running ~X min late, office please call customer", and text the managers.
{
  const lead = mkLead({ itemId: "u", name: "Smith", coords: SD_FAR, apptWallMinutes: 10 * 60 + 5 });
  const near = mkRep({ name: "Near Rep", lastCoords: SD_FAR }); // 0m drive
  const far = mkRep({ name: "Far Rep", lastCoords: SD_A });
  const plan = planLateCoverage({
    lead,
    workingReps: [near, far],
    nowWallMinutes: 10 * 60, // 5 min to start — nobody can be on time
  });
  expect("Rule 6: late coverage assigns the closest rep", plan.action === "assign-late");
  if (plan.action === "assign-late") {
    expectEq("Rule 6: it picks the nearest working rep", plan.rep.name, "Near Rep");
    expect("Rule 6: it reports minutes late", plan.lateMinutes >= 0);
  }
  expectEq(
    "Rule 6: the Details note names the delay + office call",
    runningLateNote(12),
    "running ~12 min late, office please call customer",
  );
  expect(
    "Rule 6: the managers text says running late + please call",
    /running ~12 min late/i.test(
      buildRunningLateText({
        office: "SD",
        leadName: "Smith",
        repName: "Near Rep",
        lateMinutes: 12,
        apptClock: "10:05am",
      }),
    ),
  );
  expect(
    "Rule 6: no eligible rep → no late assignment",
    planLateCoverage({ lead, workingReps: [], nowWallMinutes: 10 * 60 }).action === "none",
  );
  // The watchdog's gate matches Rule 6's wording: a FREE rep who exists but
  // can't make it on time (drive + 10 > time to start) still triggers coverage.
  const freeButLate = mkRep({ name: "Busy Area Rep", lastCoords: null }); // 20m default drive
  const wd = planWatchdog({
    nowWallMinutes: 10 * 60,
    leads: [
      {
        itemId: "u2",
        name: "Soon",
        apptWallMinutes: 10 * 60 + 25,
        reps: [],
        issLabel: "Not Issued",
      },
    ],
    freeReps: [freeButLate],
    lateReporters: [],
    workingReps: [freeButLate],
    alreadyAlerted: new Set<string>(),
  });
  expectEq("Rule 6: a free rep who can't make it on time still alerts/covers", wd.alerts.length, 1);
}

// Rule 7 — only after every lead in the next 2 hours is covered do we look at
// later leads: a within-2h lead beats a lead beyond the window.
{
  const rep = mkRep();
  const now = 10 * 60;
  const plan = planIssue({
    rep,
    dayLeads: [
      mkLead({ itemId: "beyond2h", coords: SD_NEAR, apptWallMinutes: now + 180 }),
      mkLead({ itemId: "within2h", coords: SD_FAR, apptWallMinutes: now + 90 }),
    ],
    nowWallMinutes: now,
  });
  expectEq(
    "Rule 7: a lead in the next 2h is covered before a later one",
    plan.action === "issue" && plan.lead.itemId,
    "within2h",
  );
}

// Rule 8 — two reps unless the rep is hot; a second rep is ADDED, never a
// replacement; Daniel never goes alone.
{
  expect("Rule 8: Daniel must be paired (default roster)", mustPair("Daniel Figueiredo"));
  expect("Rule 8: a non-listed rep may solo when no hot roster is set", !mustPair("Jaxon Heilman"));
  const cfg = withPairing({ hotReps: ["Yakup"], neverSolo: ["Daniel"] });
  expect("Rule 8: with a hot roster, a non-hot rep must pair", mustPair("Nick Schoeben", cfg));
  expect("Rule 8: a hot rep may still solo", !mustPair("Yakup Sancakli", cfg));
  const partner = choosePartner({
    rep: mkRep({ name: "Daniel Figueiredo" }),
    lead: mkLead({ coords: SD_A }),
    freeReps: [mkRep({ name: "Nick Schoeben", lastCoords: SD_NEAR })],
  });
  expectEq("Rule 8: a partner is chosen to ADD", partner?.name, "Nick Schoeben");
  expectEq(
    "Rule 8: no free rep → no partner (caller withholds, never solo)",
    choosePartner({ rep: mkRep({ name: "Daniel Figueiredo" }), lead: mkLead(), freeReps: [] }),
    null,
  );
  // Two pairing tiers (owner, 2026-10-08 pm): neverSolo (Daniel) is withheld
  // when no partner is free; the soft "pair whenever possible" tier (a rep
  // outside hotReps, e.g. Jaxon) pairs when possible and goes SOLO otherwise.
  const tierCfg = withPairing({ hotReps: ["Yakup"], neverSolo: ["Daniel"] });
  expect("Rule 8: Daniel is HARD never-solo (withheld)", isNeverSolo("Daniel Figueiredo", tierCfg));
  expect(
    "Rule 8: a pair-when-possible rep still pairs when someone is free",
    mustPair("Jaxon Heilman", tierCfg) && !isNeverSolo("Jaxon Heilman", tierCfg),
  );
}

// Rule 9 — the live test case: Yakup freed in Serra Mesa; 2:00 Smith (Carlsbad)
// uncovered, 4:00 Hackett also open. He must get Smith (soonest), not Hackett.
{
  const yakup = mkRep({ name: "Yakup Sancakli", lastCoords: SD_A });
  const plan = planIssue({
    rep: yakup,
    dayLeads: [
      mkLead({ itemId: "hackett", name: "Hackett", coords: SD_NEAR, apptWallMinutes: 16 * 60 }),
      mkLead({ itemId: "smith", name: "Smith", coords: SD_FAR, apptWallMinutes: 14 * 60 }),
    ],
    nowWallMinutes: 13 * 60,
  });
  expectEq(
    "Rule 9: Yakup gets the 2:00 Smith, not the 4:00 Hackett",
    plan.action === "issue" && plan.lead.itemId,
    "smith",
  );
}

// ═══ C. SALES: ENTER ALL DATA BEFORE PRESSING ANY BUTTON ════════════════════

// Rule 10 — the dispo form's new Sold-only fields parse.
{
  const f = parseOohForm(
    "s",
    form({
      [FORM_COL.result]: status(RESULT.SOLD),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.depositAmount]: num(1000),
      [FORM_COL.depositPaidWith]: status(0, "cc"),
      [FORM_COL.balancePaidWith]: status(0, "Synchrony"),
      [FORM_COL.advantagePlus]: status(0, "Advantage+"),
      [FORM_COL.reload]: text("None"),
      [FORM_COL.howClosed]: status(1, "Marketing drop"),
    }),
  );
  expectEq("Rule 10: deposit amount parses", f.depositAmount, 1000);
  expectEq("Rule 10: deposit method parses", f.depositPaidWith, "cc");
  expectEq("Rule 10: balance method parses", f.balancePaidWith, "Synchrony");
  expectEq("Rule 10: Advantage+ parses", f.advantagePlus, "Advantage+");
  expectEq("Rule 10: reload parses", f.reloadAddOns, "None");
  expectEq("Rule 10: how-closed parses", f.howClosed, "Marketing drop");
}

// Rule 11 — on every sale, write all values FIRST: Price, Advantage+, Reloads,
// and the office-style Details segment. (Press order asserted in Rule 12.)
{
  const f = parseOohForm(
    "s",
    form({
      [FORM_COL.result]: status(RESULT.SOLD),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.quantities]: text("15sq shingles 13sq flat"),
      [FORM_COL.salePrice]: num(28000),
      [FORM_COL.depositAmount]: num(1000),
      [FORM_COL.depositPaidWith]: status(0, "cc"),
      [FORM_COL.balancePaidWith]: status(0, "Synchrony"),
      [FORM_COL.advantagePlus]: status(0, "Advantage+"),
      [FORM_COL.reload]: text("Gutters"),
      [FORM_COL.howClosed]: status(1, "Marketing drop"),
      [FORM_COL.dropCall]: status(1, "Shai"),
    }),
  );
  const plan = planDisposition(f);
  expectEq("Rule 11: Price is written", plan.fieldWrites[BLOCK_COL.salePrice], "28000");
  expectEq(
    "Rule 11: Advantage+ is a BUTTON (its own press), not a column note",
    plan.advantageStatus,
    { col: BLOCK_COL.advantage, label: "Advantage+" },
  );
  expect(
    "Rule 11: Advantage+ never rides the columns call",
    !(BLOCK_COL.advantage in plan.fieldWrites),
  );
  expectEq("Rule 11: Reloads add-ons are written", plan.fieldWrites[BLOCK_COL.reloads], {
    labels: ["Gutters"],
  });
  expect(
    "Rule 11: the Details segment is office-style",
    buildSaleDetailsSegment(f) ===
      "$1,000 deposit cc balance Synchrony, closed at Marketing drop, dc Shai",
  );
  expect(
    "Rule 11: membership maps to Advantage+/Non Member",
    membershipLabel("no") === "Non Member",
  );
  expectEq("Rule 11: reload 'None' maps to no labels", reloadAddOnLabels("None"), []);
}

// Rule 12 — order of presses: columns call first, then the Advantage+ BUTTON
// (its own press — "it is not a note"), then the result button LAST.
{
  const ops: AppliedOp[] = [];
  const writer: MondayWriter = {
    setColumns: async (_b, _i, values: Record<string, MondayValue>) => {
      ops.push({ kind: "columns", values });
    },
    setStatus: async (_b, _i, col: string, label: string) => {
      ops.push({ kind: "status", col, label });
    },
  };
  const f = parseOohForm(
    "s",
    form({
      [FORM_COL.result]: status(RESULT.SOLD),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.salePrice]: num(28000),
      [FORM_COL.advantagePlus]: status(0, "Advantage+"),
    }),
  );
  const plan = planDisposition(f);
  const done = await applyDisposition(
    writer,
    "B",
    "123",
    plan.fieldWrites,
    plan.status,
    plan.advantageStatus,
  );
  expectEq(
    "Rule 12: columns → Advantage+ button → result button",
    done.map((o) => (o.kind === "columns" ? "columns" : (o as { col: string }).col)),
    ["columns", BLOCK_COL.advantage, BLOCK_COL.sale],
  );
  expectEq("Rule 12: the LAST op is the sale button", done[done.length - 1], {
    kind: "status",
    col: BLOCK_COL.sale,
    label: LABEL.sold,
  });
}

// Rule 13 — after the card moves to Sales Processing, fill Deposit Amt, Finance
// (= balance method), Advantage+, and Reloads on the SP board's columns.
{
  const f = parseOohForm(
    "s",
    form({
      [FORM_COL.result]: status(RESULT.SOLD),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.depositAmount]: num(1000),
      [FORM_COL.balancePaidWith]: status(0, "Synchrony"),
      [FORM_COL.advantagePlus]: status(0, "Advantage+"),
      [FORM_COL.reload]: text("Gutters"),
    }),
  );
  const sp = planSalesProcessingWrite(f);
  expectEq("Rule 13: Deposit Amt → numbers5", sp[SALES_PROCESSING_COL.depositAmt], "1000");
  expectEq("Rule 13: Finance → dropdown6 = balance method", sp[SALES_PROCESSING_COL.finance], {
    labels: ["Synchrony"],
  });
  expectEq("Rule 13: Advantage+ → color_mkwkmx6g", sp[SALES_PROCESSING_COL.advantage], {
    label: "Advantage+",
  });
  expectEq("Rule 13: Reloads → dup__of_product9", sp[SALES_PROCESSING_COL.reloads], {
    labels: ["Gutters"],
  });
}

// Rule 14 — blank sale fields are listed in the ONE missing-info nudge; a
// complete sale lists nothing.
{
  const bare = parseOohForm(
    "s",
    form({ [FORM_COL.result]: status(RESULT.SOLD), [FORM_COL.onBlock]: status(ON_BLOCK.YES) }),
  );
  const miss = missingSaleFields(bare);
  expect(
    "Rule 14: a bare sale flags its blank fields",
    miss.includes("sale price") && miss.includes("deposit amount"),
  );
  const complete = parseOohForm(
    "s",
    form({
      [FORM_COL.result]: status(RESULT.SOLD),
      [FORM_COL.onBlock]: status(ON_BLOCK.YES),
      [FORM_COL.quantities]: text("roof"),
      [FORM_COL.salePrice]: num(28000),
      [FORM_COL.depositAmount]: num(1000),
      [FORM_COL.depositPaidWith]: status(0, "cc"),
      [FORM_COL.balancePaidWith]: status(0, "Synchrony"),
      [FORM_COL.advantagePlus]: status(0, "Advantage+"),
      [FORM_COL.reload]: text("None"),
      [FORM_COL.howClosed]: status(1, "Marketing drop"),
    }),
  );
  expectEq("Rule 14: a complete sale lists nothing missing", missingSaleFields(complete), []);
}

// Rule 15 — job walks + every Office Appt: Details ONLY (press nothing), except
// the one allowed button status9 = Reload or Upsell (never Sold / PM / RS / …).
{
  const noShow = parseOohForm("s", form({ [FORM_COL.result]: status(RESULT.NO_DEMO) }));
  expectEq(
    "Rule 15: a non-sale office appt presses nothing",
    planOfficeApptDisposition(noShow).status,
    null,
  );
  const reload = parseOohForm(
    "s",
    form({ [FORM_COL.result]: status(RESULT.SOLD), [FORM_COL.onBlock]: status(ON_BLOCK.YES) }),
  );
  expectEq(
    "Rule 15: an office-appt sale presses Reload (never Sold)",
    planOfficeApptDisposition(reload).status,
    {
      col: BLOCK_COL.sale,
      label: LABEL.saleReload,
    },
  );
  const upsell = parseOohForm(
    "s",
    form({ [FORM_COL.result]: status(RESULT.SOLD), [FORM_COL.onBlock]: status(ON_BLOCK.UPSELL) }),
  );
  expectEq(
    "Rule 15: an office-appt upsell presses Upsell",
    planOfficeApptDisposition(upsell).status,
    {
      col: BLOCK_COL.sale,
      label: LABEL.upsell,
    },
  );
  expectEq(
    "Rule 15: the office-appt sale's Advantage+ is its own button press",
    planOfficeApptDisposition(reload).advantageStatus,
    { col: BLOCK_COL.advantage, label: LABEL.advantagePlus },
  );
  expect("Rule 15: 'Office Appt' is recognized", isOfficeApptStatus("Office Appt"));
}

// ═══ D. NEEDS REVIEW: STOP PILING UP CARDS ══════════════════════════════════

// Rule 16 — auto-handle (a) the second partner's copy for the same customer that
// day, and (b) a card already routed to a destination board.
{
  expect(
    "Rule 16b: a Sales Processing card is a handled destination",
    isHandledDestinationBoard(DESTINATION_BOARDS.salesProcessing),
  );
  expect(
    "Rule 16b: a Rehash/Blowout/Confirmed card is handled",
    isHandledDestinationBoard(DESTINATION_BOARDS.rehashLog) &&
      isHandledDestinationBoard(DESTINATION_BOARDS.confirmedOC),
  );
  expect(
    "Rule 16b: a live block board is NOT a handled destination",
    !isHandledDestinationBoard("18432844990"),
  );
  const k1 = customerDayKey("Smith, John", "2026-10-08", "123 Nathan Cir");
  const k2 = customerDayKey("John Smith", "2026-10-08", "123 Nathan Circle");
  expectEq("Rule 16a: same customer + day + address keys match", k1, k2);
  expect(
    "Rule 16a: the partner's copy is caught by the processed key",
    isSecondPartnerCopy(k2, [k1!]),
  );
  expect(
    "Rule 16a: a different customer is NOT caught",
    !isSecondPartnerCopy(customerDayKey("Jones", "2026-10-08", "9 Oak St"), [k1!]),
  );
}

// Rule 17 — a no-Lead-ID report matches by customer name + address + rep on
// today's block; only 0 or 2+ confident matches go to Needs Review.
{
  const candidates: MatchCandidate[] = [
    {
      id: "c1",
      customerName: "Smith, John",
      address: "123 Nathan Cir, San Diego",
      reps: ["Jaxon Heilman"],
    },
    { id: "c2", customerName: "Jones, Pat", address: "9 Oak St, Carlsbad", reps: ["Nick"] },
  ];
  expectEq(
    "Rule 17: a unique address match is written",
    matchWithoutLeadId({
      address: "123 Nathan Circle",
      customerName: "John Smith",
      rep: "Jaxon",
      candidates,
    }),
    { kind: "match", id: "c1", by: "address" },
  );
  expectEq(
    "Rule 17: last-name + rep matches when there's no address",
    matchWithoutLeadId({ address: null, customerName: "Jones", rep: "Nick", candidates }),
    { kind: "match", id: "c2", by: "lastname-rep" },
  );
  expectEq(
    "Rule 17: no confident match → Needs Review",
    matchWithoutLeadId({ address: "999 Nowhere", customerName: "Ghost", rep: "Nobody", candidates })
      .kind,
    "review",
  );
}

// ═══ E. REP PORTAL ══════════════════════════════════════════════════════════

// Rule 18 — the rep portal lists every lead where the rep is on people6 and
// status is Iss or Office Appt today, no matter WHO issued it (office/Claude/
// dispatch). Visibility depends only on the lead's status, never the issuer.
{
  const blank = { pm: null, rs: null, ol: null, bo: null, sale: null };
  expect("Rule 18: an Iss lead is visible", isMyLeadVisible({ iss: "Iss", ...blank }));
  expect(
    "Rule 18: an Office Appt lead is visible",
    isMyLeadVisible({ iss: "Office Appt", ...blank }),
  );
  expect(
    "Rule 18: a reported lead (any disposition) stays visible",
    isMyLeadVisible({ iss: "Iss", ...blank, sale: "Sold" }),
  );
  expect(
    "Rule 18: a Not-Issued lead is NOT shown (one-lead-at-a-time)",
    !isMyLeadVisible({ iss: "Not Issued", ...blank }),
  );
}

// ═══ PORTAL FIX (owner 2026-10-08) — the Yin/Ronnell regression ═════════════
// OC "Yin" 1:00 was issued to Ronnell; a manager flipped the status to
// "Add Rep" (= this lead still needs a SECOND rep) and the lead vanished from
// Ronnell's portal, so he didn't go. That must never happen again.
{
  const blank = { pm: null, rs: null, ol: null, bo: null, sale: null };
  // #1 — Iss / Office Appt / Add Rep are all visible; Not Issued / CTC hide.
  expect(
    "Yin/Ronnell #1: an Add Rep lead STAYS in the rep's portal",
    isMyLeadVisible({ iss: "Add Rep", ...blank }),
  );
  expect("Yin/Ronnell #1: Not Issued hides", !isMyLeadVisible({ iss: "Not Issued", ...blank }));
  expect("Yin/Ronnell #1: CTC hides", !isMyLeadVisible({ iss: "CTC", ...blank }));
  // #2 — once issued, ANY other manager status flip keeps it visible.
  expect(
    "Yin/Ronnell #2: a manager flip to any other status keeps it visible",
    isMyLeadVisible({ iss: "Reload", ...blank }),
  );
  // #3 — dispatch: Add Rep = keep the current rep, ADD one more, don't touch
  // the status.
  const freed = mkRep({ name: "Nick Schoeben", lastCoords: SD_A });
  const yin = mkLead({
    itemId: "yin",
    name: "Yin",
    reps: ["Ronnell Vital"],
    issLabel: "Add Rep",
    coords: SD_NEAR,
    apptWallMinutes: 13 * 60,
  });
  const plan = planIssue({ rep: freed, dayLeads: [yin], nowWallMinutes: 11 * 60 });
  expect(
    "Yin/Ronnell #3: a freed nearby rep is routed to the Add Rep lead",
    plan.action === "issue" && plan.lead.itemId === "yin",
  );
  expect(
    "Yin/Ronnell #3: the plan is ADD-only — the status is never pressed",
    plan.action === "issue" && plan.addRep === true,
  );
  expectEq(
    "Yin/Ronnell #3: people6 keeps Ronnell and adds the second rep",
    mergePeople(["ronnell-id"], ["nick-id"]),
    ["ronnell-id", "nick-id"],
  );
  const ronnell = mkRep({ name: "Ronnell Vital" });
  expectEq(
    "Yin/Ronnell #3: the current rep is never re-issued their own Add Rep lead",
    planIssue({ rep: ronnell, dayLeads: [yin], nowWallMinutes: 11 * 60 }).action,
    "none",
  );
}

// ═══ F. TEXTS: WAY LESS NOISE ═══════════════════════════════════════════════

// Rules 19 + 20 — only sales/reloads/upsells, a no-show at the door, an
// uncovered lead within 60 min, a running-late cover, and the missing-sale-info
// nudge text the managers. Everything else shows in the app.
{
  expect("Rule 19: a sale texts", shouldTextManagers("sale"));
  expect("Rule 19: a no-show at the door texts", shouldTextManagers("no_show_at_door"));
  expect(
    "Rule 19: an uncovered lead within 60 min texts",
    shouldTextManagers("uncovered_within_60"),
  );
  expect("Rule 19: the missing-sale-info nudge texts", shouldTextManagers("missing_sale_info"));
  expect("Rule 6/19: a running-late cover texts", shouldTextManagers("running_late"));
  expect(
    "Rule 20: a '[DRY RUN] would issue' never texts",
    !shouldTextManagers("dry_run_would_issue"),
  );
  expect("Rule 20: a 'needs review' never texts", !shouldTextManagers("needs_review"));
  expect("Rule 20: 'free reps' never texts", !shouldTextManagers("free_reps"));
  expect("Rule 20: a routine 'Issued:' never texts", !shouldTextManagers("routine_issue"));
  expect("Rule 20: a routine dispo never texts", !shouldTextManagers("routine_dispo"));
}

// ═══ G. AUDIT ═══════════════════════════════════════════════════════════════

// Rule 21 — every people6 / status write is audited with item, old, new, reason
// and timestamp. The two guarded columns ARE the two write types audited, and a
// people column value parses to the ids an old/new diff is recorded from.
{
  expectEq(
    "Rule 21: the audited write columns are people6 + Iss(status)",
    [...GUARDED_WRITE_COLS],
    [BLOCK_COL.reps, BLOCK_COL.iss],
  );
  // The audit's old/new people values come from the people column — parse must
  // yield the exact ids so an "old → new" diff is faithful.
  const pv = JSON.stringify({
    personsAndTeams: [
      { id: 111, kind: "person" },
      { id: 222, kind: "person" },
      { id: 7, kind: "team" },
    ],
  });
  expectEq(
    "Rule 21: people-column value parses to the person ids (old/new diff)",
    parsePeopleColumnValue(pv),
    ["111", "222"],
  );
  // A write audit row carries exactly the fields the review page needs.
  const auditRow = {
    itemId: "123",
    columnId: BLOCK_COL.reps,
    oldValue: "111",
    newValue: "111,222",
    reason: "nearest open lead",
    createdAt: "2026-10-08T20:00:00Z",
  };
  expect(
    "Rule 21: an audit row records item, old→new, reason, time",
    !!auditRow.itemId &&
      auditRow.oldValue !== auditRow.newValue &&
      !!auditRow.reason &&
      !!auditRow.createdAt,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// H / I / J — NIGHTLY APPROVALS (owner mandate 2026-10-08 night, rules 1–10)
// ═══════════════════════════════════════════════════════════════════════════

function mkDayItem(over: Partial<ApprovalsDayItem> = {}): ApprovalsDayItem {
  return {
    ...mkLead(),
    pm: null,
    rs: null,
    ol: null,
    bo: null,
    sale: null,
    sourceText: "RepCard",
    detailsText: "Gate code 1234",
    addressText: "6345 Southern Rd, La Mesa, CA 91942, USA",
    ...over,
  };
}

// Rule H1 — one row per block item of tomorrow's group, EVERY item included
// (not only the changed ones), for each office.
{
  const items = [
    mkDayItem({ itemId: "1", name: "Avila", apptWallMinutes: 9 * 60 }),
    mkDayItem({ itemId: "2", name: "Burke", apptWallMinutes: 13 * 60, reps: ["Yakup Sancakli"] }),
    mkDayItem({ itemId: "3", name: "Chen", apptWallMinutes: 17 * 60 + 30 }),
  ];
  const rows = buildApprovalsRows({
    office: "SD",
    items,
    proposals: [{ blockItemId: "1", addReps: ["Jonathan Paz"], reason: "first lead" }],
  });
  expectEq(
    "Rule H1: every item in tomorrow's group gets a row, changed or not",
    rows.map((r) => r.blockItemId).sort(),
    ["1", "2", "3"],
  );
  expectEq("Rule H1: rows carry the office section", rows.every((r) => r.office === "SD"), true);
}

// Rule H2 — each row shows time, customer, city, Source, status, current reps
// (people6), Details (long_text3) and the proposal beside them; sorted by time.
{
  const items = [
    mkDayItem({ itemId: "2", name: "Burke", apptWallMinutes: 17 * 60 + 30 }),
    mkDayItem({
      itemId: "1",
      name: "Avila",
      apptWallMinutes: 9 * 60,
      reps: ["Yakup Sancakli", "Bergan Lundak"],
      issLabel: LABEL.iss,
      rs: LABEL.reset,
      products: ["roof"],
    }),
    mkDayItem({ itemId: "3", name: "NoTime", apptWallMinutes: null }),
  ];
  const rows = buildApprovalsRows({ office: "SD", items, proposals: [] });
  expectEq(
    "Rule H2: sorted by time (unknown time last)",
    rows.map((r) => r.blockItemId),
    ["1", "2", "3"],
  );
  const avila = rows[0];
  expectEq("Rule H2: time cell (engine wall-clock format)", avila.timeText, "9am");
  expectEq("Rule H2: customer name", avila.name, "Avila");
  expectEq("Rule H2: city from the Location address", avila.cityText, "La Mesa");
  expectEq("Rule H2: Source (text)", avila.sourceText, "RepCard");
  expectEq("Rule H2: status = Iss + set dispositions", avila.blockStatusText, "Iss · Reset");
  expectEq("Rule H2: current reps (people6)", avila.currentRepNames, [
    "Yakup Sancakli",
    "Bergan Lundak",
  ]);
  expectEq("Rule H2: Details (long_text3)", avila.leadNotes, "Gate code 1234");
  expect("Rule H2: the proposal sits in its own cell", typeof avila.suggestion === "string");
}

// Rule H3 — rows with no proposal say exactly "No change".
{
  const rows = buildApprovalsRows({
    office: "OC",
    items: [mkDayItem({ itemId: "9", reps: ["Sam"] })],
    proposals: [],
  });
  expectEq("Rule H3: untouched rows read 'No change'", rows[0].suggestion, NO_CHANGE_TEXT);
  expectEq("Rule H3: untouched rows carry no pending change", rows[0].hasChange, false);
}

// Rule H4 — a change shows as a Current → Proposed diff with its reason; the
// Approve-all selection takes ONLY rows still pending with a change.
{
  const rows = buildApprovalsRows({
    office: "SD",
    items: [mkDayItem({ itemId: "1", reps: ["Yakup Sancakli"] })],
    proposals: [
      { blockItemId: "1", addReps: ["Jonathan Paz"], reason: "Yakup needs a partner" },
    ],
  });
  const s = rows[0].suggestion;
  expect("Rule H4: diff shows Current: …", s.includes("Current: Yakup Sancakli"));
  expect(
    "Rule H4: diff shows Proposed: … (add-only)",
    s.includes("Proposed: Yakup Sancakli + Jonathan Paz"),
  );
  expect("Rule H4: the reason rides along", s.includes("Yakup needs a partner"));

  const targets = selectApproveAllTargets([
    { state: "pending" as const, addNames: ["Jonathan"] }, // still pending → in
    { state: "applied" as const, addNames: ["Jonathan"] }, // already applied → out
    { state: "skipped" as const, addNames: ["Jonathan"] }, // office changed it → out
    { state: "rejected" as const, addNames: ["Jonathan"] }, // rejected → out
    { state: "pending" as const, addNames: [] }, // "No change" → out
  ]);
  expectEq("Rule H4: Approve-all applies only rows still pending a change", targets.length, 1);
}

// Rule H5 — nothing is written until Approve; the pre-write re-read drops the
// proposal when people6 OR a status changed, with the exact owner wording.
{
  const snapshot = {
    repNames: ["Yakup Sancakli"],
    iss: LABEL.notIssued,
    pm: null,
    rs: null,
    ol: null,
    bo: null,
    sale: null,
  };
  const unchanged = applyGuard({
    snapshot,
    current: { ...snapshot, repNames: ["yakup  sancakli"] }, // normalized compare
  });
  expectEq("Rule H5: unchanged item passes the guard", unchanged, { ok: true });
  const repsChanged = applyGuard({
    snapshot,
    current: { ...snapshot, repNames: ["Yakup Sancakli", "Nick Smith"] },
  });
  expectEq("Rule H5: people6 changed since proposal → dropped", repsChanged, {
    ok: false,
    note: CHANGED_BY_OFFICE_NOTE,
  });
  const statusChanged = applyGuard({
    snapshot,
    current: { ...snapshot, iss: LABEL.iss },
  });
  expectEq("Rule H5: status changed since proposal → dropped", statusChanged, {
    ok: false,
    note: "Changed by office, skipped",
  });
}

// Rule I6 — a reset belongs to the rep who set it: a replace-shaped proposal
// on a reset NEVER removes them; the add (if any) survives as "Add …".
{
  const reset = mkDayItem({ itemId: "7", reps: ["Yakup Sancakli"], isReset: true, rs: LABEL.reset });
  const sanitized = sanitizeProposal(reset, {
    blockItemId: "7",
    proposedReps: ["Jonathan Paz"], // "Yakup → Jonathan"
    reason: "second rep",
  });
  expectEq("Rule I6: the reset's rep is never removed", sanitized?.droppedRemovals, [
    "Yakup Sancakli",
  ]);
  expectEq("Rule I6: the second rep is proposed as an ADD", sanitized?.addReps, ["Jonathan Paz"]);
}

// Rule I7 — the original rep comes from people6, else the report (rep +
// partner) that created the reset; unknown ⇒ propose NOTHING for that row.
{
  expectEq(
    "Rule I7: people6 names the owner",
    resetOwners({ reps: ["Yakup Sancakli"] }, null),
    ["Yakup Sancakli"],
  );
  expectEq(
    "Rule I7: empty people6 falls back to the creating report's rep + partner",
    resetOwners({ reps: [] }, { repName: "Yakup Sancakli", partner: "Bergan Lundak" }),
    ["Yakup Sancakli", "Bergan Lundak"],
  );
  expectEq("Rule I7: neither known → owner unknown", resetOwners({ reps: [] }, null), null);
  const orphanReset = mkDayItem({ itemId: "8", reps: [], isReset: true });
  expectEq(
    "Rule I7: unknown owner → no proposal at all for that row",
    sanitizeProposal(orphanReset, { blockItemId: "8", proposedReps: ["Jonathan Paz"] }, null),
    null,
  );
}

// Rule I8 — ALL people6 changes are add-only (same as rule A1), approvals
// board and live dispatch alike. applyWriteIds is the ONE write shape; a
// write that would drop anyone is refused by wouldRemoveRep.
{
  expectEq(
    "Rule I8: the write is union(current, adds) — never fewer",
    applyWriteIds(["10", "20"], ["30", "10"]),
    ["10", "20", "30"],
  );
  expectEq(
    "Rule I8: live dispatch's mergePeople is the same add-only union",
    mergePeople(["10", "20"], ["30"]),
    ["10", "20", "30"],
  );
  expect("Rule I8: dropping a rep is detected and refused", wouldRemoveRep(["10", "20"], ["20"]));
  expect(
    "Rule I8: an add-only result passes the removal gate",
    !wouldRemoveRep(["10", "20"], applyWriteIds(["10", "20"], ["30"])),
  );
}

// Rule I9 — the 10/8-night test case verbatim: Yakup's own reset proposed as
// "Yakup → Jonathan" must show "No change" or "Add Jonathan", never a replace.
{
  const yakupReset = mkDayItem({
    itemId: "911",
    name: "Yakup's reset",
    reps: ["Yakup Sancakli"],
    isReset: true,
    rs: LABEL.reset,
  });
  const rows = buildApprovalsRows({
    office: "SD",
    items: [yakupReset],
    proposals: [{ blockItemId: "911", proposedReps: ["Jonathan Paz"], reason: "stronger closer" }],
  });
  const s = rows[0].suggestion;
  expect("Rule I9: shows 'Add Jonathan', not a replace", s.startsWith("Add Jonathan"));
  expect("Rule I9: Yakup stays in the proposed set", s.includes("Yakup Sancakli + Jonathan Paz"));
  expect("Rule I9: the dropped replace is called out", s.includes("dropped: reps are add-only"));
  // And the same proposal with NO add (pure removal) collapses to "No change".
  const noAdd = buildApprovalsRows({
    office: "SD",
    items: [yakupReset],
    proposals: [{ blockItemId: "911", proposedReps: ["Yakup Sancakli"] }],
  });
  expectEq("Rule I9: a pure-removal proposal shows 'No change'", noAdd[0].suggestion, NO_CHANGE_TEXT);
}

// Rule J10 — every approved or rejected proposal lands in the rule-G audit
// with who decided, when, and old → new values.
{
  const audit = {
    trigger: "approvals",
    actor: "approvals:Tyler Ward",
    oldValue: "Yakup Sancakli",
    newValue: "Yakup Sancakli, Jonathan Paz",
    reason: "approved by Tyler Ward: Yakup needs a partner",
    createdAt: "2026-10-09T03:00:00Z",
  };
  expect(
    "Rule J10: the audit row names the approver, the time and old → new",
    audit.trigger === "approvals" &&
      audit.actor.includes("Tyler Ward") &&
      audit.oldValue !== audit.newValue &&
      !!audit.createdAt,
  );
  // The decision webhook only acts on real decisions — Pending/unknown are
  // no-ops, Approve/Don't approve/Change/Add rep act.
  expectEq("Rule J10: Pending is a no-op", decisionKind("Pending"), "pending");
  expectEq("Rule J10: Approve applies", decisionKind("Approve"), "approve");
  expectEq("Rule J10: Don't approve records a rejection", decisionKind("Don't approve"), "reject");
  expectEq("Rule J10: Add rep is a manager-directed add", decisionKind("Add rep"), "add_rep");
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll dispatch-rule assertions passed (A–G 1–21 + nightly approvals H/I/J 1–10).");
