/** Assertions for the Respawn (sales-rep shift-off) engine in
 *  src/lib/respawn.ts — run with `npm run verify:respawn`.
 *
 *  Guards the pure logic the UI, the server fns, and the Monday sync all lean
 *  on: the 14-shift maps, the Sunday-noon PT deadline / "late" rule, the
 *  Fri 6 PM → Sun 12 PM reminder window, week_start math, and office coding.
 *  October 2026 is PDT (UTC−7), so a PT wall time T is the instant T+7:00Z. */
import {
  ATTENDANCE_BOARD_ID,
  OFFICE_DAYOFF_LABEL,
  SHIFT_ATTENDANCE_COL,
  SHIFT_KEYS,
  SHIFT_LABEL,
  attendanceWeekStartISO,
  canWithdrawRespawn,
  comingWeekStartISO,
  inReminderWindow,
  isLateForWeek,
  isMondayISO,
  laWeekdayHour,
  mondayApprovalLabel,
  normalizeShifts,
  officeToRep,
  resolveRosterOffice,
  respawnDeadlineMs,
  settleApproval,
  shiftsToRevertOnResubmit,
  summarizeShifts,
  type ShiftKey,
} from "../src/lib/respawn";

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

// PT (PDT, UTC−7) wall time → UTC instant. Offset added as ms so hours that
// cross midnight (e.g. 8 PM PT = 03:00Z next day) normalize correctly.
const pdt = (isoDate: string, h: number, m = 0) => {
  const [y, mo, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, m) + 7 * 60 * 60 * 1000);
};

// ── shift maps ─────────────────────────────────────────────────────────────
expectEq("14 shift keys", SHIFT_KEYS.length, 14);
expectEq("shift keys unique", new Set(SHIFT_KEYS).size, 14);
expectEq("every shift has a label", SHIFT_KEYS.filter((s) => SHIFT_LABEL[s]).length, 14);
expectEq(
  "every shift maps to an attendance column",
  SHIFT_KEYS.filter((s) => SHIFT_ATTENDANCE_COL[s]).length,
  14,
);
expectEq(
  "attendance columns are distinct",
  new Set(SHIFT_KEYS.map((s) => SHIFT_ATTENDANCE_COL[s])).size,
  14,
);
// The exact Monday column ids read live from the SD/OC Rep Attendance boards.
expectEq("mon_am → color0", SHIFT_ATTENDANCE_COL.mon_am, "color0");
expectEq("mon_pm → dup__of_mon_am", SHIFT_ATTENDANCE_COL.mon_pm, "dup__of_mon_am");
expectEq("tue_am → status", SHIFT_ATTENDANCE_COL.tue_am, "status");
expectEq("sun_pm → status_mkn3rnr9", SHIFT_ATTENDANCE_COL.sun_pm, "status_mkn3rnr9");
expectEq("SD/OC attendance boards differ", ATTENDANCE_BOARD_ID.SD !== ATTENDANCE_BOARD_ID.OC, true);
expectEq("monday label pending", mondayApprovalLabel("pending"), "Pending");
expectEq("monday label partial reads Approved", mondayApprovalLabel("partial"), "Approved");
expectEq("monday label denied", mondayApprovalLabel("denied"), "Denied");
expectEq("office label OC", OFFICE_DAYOFF_LABEL.OC, "Orange County");

// ── partial approval resolver ───────────────────────────────────────────────
const req3 = ["thu_am", "fri_pm", "sat_am"] as ShiftKey[];
expectEq("grant all → approved", settleApproval(req3, req3, true), {
  status: "approved",
  approvedShifts: ["thu_am", "fri_pm", "sat_am"],
  declinedShifts: [],
});
expectEq("grant none specified → approved (defaults to all)", settleApproval(req3, null, true), {
  status: "approved",
  approvedShifts: ["thu_am", "fri_pm", "sat_am"],
  declinedShifts: [],
});
expectEq(
  "grant subset → partial (Thu–Sat, keep Fri+Sat)",
  settleApproval(req3, ["fri_pm", "sat_am"] as ShiftKey[], true),
  {
    status: "partial",
    approvedShifts: ["fri_pm", "sat_am"],
    declinedShifts: ["thu_am"],
  },
);
expectEq("grant empty → denied", settleApproval(req3, [], true), {
  status: "denied",
  approvedShifts: [],
  declinedShifts: ["thu_am", "fri_pm", "sat_am"],
});
expectEq("deny → denied regardless of granted", settleApproval(req3, req3, false), {
  status: "denied",
  approvedShifts: [],
  declinedShifts: ["thu_am", "fri_pm", "sat_am"],
});
expectEq(
  "granted shift not in request is dropped",
  settleApproval(req3, ["fri_pm", "sun_am"] as ShiftKey[], true),
  {
    status: "partial",
    approvedShifts: ["fri_pm"],
    declinedShifts: ["thu_am", "sat_am"],
  },
);

// ── shift normalization ──────────────────────────────────────────────────
expectEq(
  "normalize filters + dedupes + orders",
  normalizeShifts(["sun_pm", "mon_am", "nope", "mon_am", 42]),
  ["mon_am", "sun_pm"] as ShiftKey[],
);
expectEq("normalize empty", normalizeShifts(null), []);
expectEq(
  "summarize keeps canonical order",
  summarizeShifts(["fri_pm", "mon_am"] as ShiftKey[]),
  "Mon AM · Fri PM",
);

// ── week_start / coming week ────────────────────────────────────────────────
expectEq("Monday 2026-10-12 is a Monday", isMondayISO("2026-10-12"), true);
expectEq("Tuesday 2026-10-13 is not", isMondayISO("2026-10-13"), false);
expectEq("garbage is not a Monday", isMondayISO("hello"), false);
// Fri / Sat / Sun across the reminder window all point at the same upcoming
// Monday (2026-10-12).
expectEq("coming week from Fri 10-09", comingWeekStartISO(pdt("2026-10-09", 20)), "2026-10-12");
expectEq("coming week from Sat 10-10", comingWeekStartISO(pdt("2026-10-10", 3)), "2026-10-12");
expectEq("coming week from Sun 10-11", comingWeekStartISO(pdt("2026-10-11", 9)), "2026-10-12");

// ── deadline / late (Sunday noon PT before the week) ────────────────────────
// Week of Mon 2026-10-12 → deadline Sun 2026-10-11 12:00 PT = 2026-10-11T19:00Z.
expectEq(
  "deadline is Sun noon PT",
  respawnDeadlineMs("2026-10-12"),
  Date.parse("2026-10-11T19:00:00Z"),
);
expectEq(
  "one minute before deadline → not late",
  isLateForWeek("2026-10-12", pdt("2026-10-11", 11, 59).getTime()),
  false,
);
expectEq(
  "one minute after deadline → late",
  isLateForWeek("2026-10-12", pdt("2026-10-11", 12, 1).getTime()),
  true,
);
// A week three weeks out, requested today, is never late.
expectEq(
  "far-future week is not late",
  isLateForWeek("2026-11-02", pdt("2026-10-11", 9).getTime()),
  false,
);
// Mid-week request for the current week is late (deadline already passed).
expectEq(
  "current-week mid-week request is late",
  isLateForWeek("2026-10-05", pdt("2026-10-08", 9).getTime()),
  true,
);

// ── reminder window (Fri 6 PM → Sun 12 PM PT) ───────────────────────────────
expectEq("Fri 5:59 PM → closed", inReminderWindow(pdt("2026-10-09", 17, 59)), false);
expectEq("Fri 6:00 PM → open", inReminderWindow(pdt("2026-10-09", 18, 0)), true);
expectEq("Fri 11 PM → open", inReminderWindow(pdt("2026-10-09", 23, 0)), true);
expectEq("Sat 3 AM → open", inReminderWindow(pdt("2026-10-10", 3, 0)), true);
expectEq("Sat 11 PM → open", inReminderWindow(pdt("2026-10-10", 23, 0)), true);
expectEq("Sun 11:59 AM → open", inReminderWindow(pdt("2026-10-11", 11, 59)), true);
expectEq("Sun 12:00 PM → closed", inReminderWindow(pdt("2026-10-11", 12, 0)), false);
expectEq("Mon 9 AM → closed", inReminderWindow(pdt("2026-10-12", 9, 0)), false);
expectEq("Thu 9 PM → closed", inReminderWindow(pdt("2026-10-08", 21, 0)), false);
// weekday/hour sanity: Fri 6 PM PT is weekday 5, hour 18 in LA.
expectEq("laWeekdayHour Fri 6 PM", laWeekdayHour(pdt("2026-10-09", 18)), { weekday: 5, hour: 18 });

// ── office coding ────────────────────────────────────────────────────────
expectEq("San Diego → SD", officeToRep("San Diego"), "SD");
expectEq("Orange County → OC", officeToRep("Orange County"), "OC");
expectEq("null office → SD (pre-OC default)", officeToRep(null), "SD");
expectEq("SD Corporate → SD", officeToRep("SD Corporate"), "SD");
expectEq("short code OC → OC", officeToRep("OC"), "OC");

// ── FIX-UP PASS (review against the live boards) — #13–#15 ───────────────────

// — #14 attendance "current week" rolls to the coming week from Sunday noon PT
// Week of Mon 2026-10-05; Mon 2026-10-12 is the coming week.
expectEq(
  "attendance week: a weekday → this week's Monday",
  attendanceWeekStartISO(pdt("2026-10-07", 14)),
  "2026-10-05",
);
expectEq(
  "attendance week: Sat → still this week",
  attendanceWeekStartISO(pdt("2026-10-10", 20)),
  "2026-10-05",
);
expectEq(
  "attendance week: Sun 11 AM → still this week",
  attendanceWeekStartISO(pdt("2026-10-11", 11)),
  "2026-10-05",
);
expectEq(
  "attendance week: Sun 12 PM → rolls to coming week",
  attendanceWeekStartISO(pdt("2026-10-11", 12)),
  "2026-10-12",
);
expectEq(
  "attendance week: Sun 3 PM → coming week",
  attendanceWeekStartISO(pdt("2026-10-11", 15)),
  "2026-10-12",
);
expectEq(
  "attendance week: Mon 9 AM → this (new) week",
  attendanceWeekStartISO(pdt("2026-10-12", 9)),
  "2026-10-12",
);

// — #13 who may WITHDRAW: reps only their own PENDING; approvers anything -------
expectEq(
  "withdraw: admin withdraws any",
  canWithdrawRespawn({ isOwner: false, isAdmin: true, status: "approved" }),
  true,
);
expectEq(
  "withdraw: owner withdraws pending",
  canWithdrawRespawn({ isOwner: true, isAdmin: false, status: "pending" }),
  true,
);
expectEq(
  "withdraw: owner CANNOT withdraw approved",
  canWithdrawRespawn({ isOwner: true, isAdmin: false, status: "approved" }),
  false,
);
expectEq(
  "withdraw: owner CANNOT withdraw partial",
  canWithdrawRespawn({ isOwner: true, isAdmin: false, status: "partial" }),
  false,
);
expectEq(
  "withdraw: owner CANNOT withdraw denied",
  canWithdrawRespawn({ isOwner: true, isAdmin: false, status: "denied" }),
  false,
);
expectEq(
  "withdraw: a stranger cannot",
  canWithdrawRespawn({ isOwner: false, isAdmin: false, status: "pending" }),
  false,
);
expectEq(
  "withdraw: owner who is also admin can withdraw approved",
  canWithdrawRespawn({ isOwner: true, isAdmin: true, status: "approved" }),
  true,
);

// — #13 editing an approved request reverts its attendance writes first --------
const attWeek = "2026-10-12";
expectEq(
  "revert: approved current-week → its granted shifts go back On",
  shiftsToRevertOnResubmit(
    { status: "approved", approvedShifts: ["mon_am", "tue_pm"], weekStart: attWeek },
    attWeek,
  ),
  ["mon_am", "tue_pm"] as ShiftKey[],
);
expectEq(
  "revert: partial current-week → the granted subset",
  shiftsToRevertOnResubmit(
    { status: "partial", approvedShifts: ["fri_pm"], weekStart: attWeek },
    attWeek,
  ),
  ["fri_pm"] as ShiftKey[],
);
expectEq(
  "revert: pending → nothing to revert",
  shiftsToRevertOnResubmit({ status: "pending", approvedShifts: [], weekStart: attWeek }, attWeek),
  [],
);
expectEq(
  "revert: approved but a DIFFERENT week → nothing (never applied yet)",
  shiftsToRevertOnResubmit(
    { status: "approved", approvedShifts: ["mon_am"], weekStart: "2026-11-02" },
    attWeek,
  ),
  [],
);
expectEq("revert: no previous row → nothing", shiftsToRevertOnResubmit(null, attWeek), []);

// — #15 office comes from the rep's ROSTER, not the answer they typed ----------
expectEq(
  "office: roster OC ignores a typed 'San Diego' (Sam Corona)",
  resolveRosterOffice("Orange County", "San Diego"),
  { office: "OC", mismatch: true, rosterProvided: true },
);
expectEq("office: roster SD + matching answer", resolveRosterOffice("San Diego", "San Diego"), {
  office: "SD",
  mismatch: false,
  rosterProvided: true,
});
expectEq("office: no answer → roster, no mismatch", resolveRosterOffice("Orange County"), {
  office: "OC",
  mismatch: false,
  rosterProvided: true,
});
// Blank / missing roster office → defaulted to SD, FLAGGED so the office can
// fix the roster (a wrong office writes the day-off to the wrong board).
expectEq("office: null roster → SD, flagged not provided", resolveRosterOffice(null), {
  office: "SD",
  mismatch: false,
  rosterProvided: false,
});
expectEq("office: empty-string roster → SD, flagged not provided", resolveRosterOffice(""), {
  office: "SD",
  mismatch: false,
  rosterProvided: false,
});
expectEq("office: whitespace roster → SD, flagged not provided", resolveRosterOffice("   "), {
  office: "SD",
  mismatch: false,
  rosterProvided: false,
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll respawn assertions passed.");
