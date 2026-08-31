// Block-day attribution verification suite — the rules behind the 2026-08-31
// Command-vs-marketing-report fix as executable checks.
// Run:  npm run verify:blockday   (or: npx tsx scripts/verify-block-day.ts)
//
// Covers: board-name → week parsing, group-title → block-day derivation
// (all seven weekday groups, prefixed titles, Needs-Assignment fallback),
// and the new-appointment copy comparator (a copy counted in a different
// weekday group is a re-run appointment, never a transition).
// Pure module in, assertions out — no network, no database, no browser.
// Exits non-zero on any failure. Extend it whenever attribution changes.

import {
  deriveCardDate,
  findIssCol,
  isNewAppointmentCopy,
  isOfficeIss,
  isSameStateRerun,
  mondayOfISO,
  parseBoardWeekStart,
  type MondayCol,
} from "../supabase/functions/monday-live-dispatch/block-cards";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — expected ${String(expected)}, got ${String(actual)}`}`);
};

console.log("— mondayOfISO —");
check("Monday maps to itself", mondayOfISO("2026-08-24"), "2026-08-24");
check("Saturday maps back to its Monday", mondayOfISO("2026-08-29"), "2026-08-24");
check("Sunday belongs to the PRECEDING Monday", mondayOfISO("2026-08-30"), "2026-08-24");

console.log("— parseBoardWeekStart —");
check("rotation name (zero-padded)", parseBoardWeekStart("SD Block 8/24/26-8/30/26"), "2026-08-24");
check("manual name with spaces", parseBoardWeekStart("OC Block 8/3/26 - 8/8/26"), "2026-08-03");
check("4-digit year", parseBoardWeekStart("SD Block 12/28/2026 - 1/3/2027"), "2026-12-28");
check("mid-week start normalizes to Monday", parseBoardWeekStart("SD Block 8/26/26 - 8/30/26"), "2026-08-24");
check("no date → null", parseBoardWeekStart("TEMPLATE — Block (do not use)"), null);
check("junk numbers → null", parseBoardWeekStart("Block 88/99/26"), null);

console.log("— deriveCardDate —");
const WK = "2026-08-24";
const days: Array<[string, string]> = [
  ["Monday", "2026-08-24"],
  ["Tuesday", "2026-08-25"],
  ["Wednesday", "2026-08-26"],
  ["Thursday", "2026-08-27"],
  ["Friday", "2026-08-28"],
  ["Saturday", "2026-08-29"],
  ["Sunday", "2026-08-30"],
];
for (const [title, iso] of days) check(`group "${title}"`, deriveCardDate(title, WK, null), iso);
check("prefixed title (\"Monday 8/24\")", deriveCardDate("Monday 8/24", WK, null), "2026-08-24");
check("case-insensitive", deriveCardDate("saturday", WK, null), "2026-08-29");
check("Needs Assignment → fallback", deriveCardDate("Needs Assignment", WK, "2026-08-31"), "2026-08-31");
check("Needs Assignment, null fallback", deriveCardDate("Needs Assignment", WK, null), null);
check("weekday but no week → fallback", deriveCardDate("Friday", null, null), null);
check("null title → fallback", deriveCardDate(null, WK, null), null);

console.log("— isNewAppointmentCopy —");
check("different block days → new appointment", isNewAppointmentCopy("2026-08-28", "2026-08-25"), true);
check("same block day → transition/correction", isNewAppointmentCopy("2026-08-25", "2026-08-25"), false);
check("copy day unknown → conservative", isNewAppointmentCopy(null, "2026-08-25"), false);
check("sibling day unknown → conservative", isNewAppointmentCopy("2026-08-28", null), false);
check("sibling day undefined → conservative", isNewAppointmentCopy("2026-08-28", undefined), false);
check("both unknown → conservative", isNewAppointmentCopy(null, null), false);

console.log("— isSameStateRerun (Grace Barnett pattern) —");
check("same status, new block day → re-run counts", isSameStateRerun("blowouts", "blowouts", "2026-08-29", "2026-08-26"), true);
check("same status, same block day → no-op", isSameStateRerun("blowouts", "blowouts", "2026-08-26", "2026-08-26"), false);
check("different status → not a rerun (transition path)", isSameStateRerun("sit", "blowouts", "2026-08-29", "2026-08-26"), false);
check("unmarked card → never", isSameStateRerun(null, null, "2026-08-29", "2026-08-26"), false);
check("old marker without blockDay → inert", isSameStateRerun("blowouts", "blowouts", "2026-08-29", null), false);
check("old marker undefined blockDay → inert", isSameStateRerun("blowouts", "blowouts", "2026-08-29", undefined), false);
check("card without derivable block day → inert", isSameStateRerun("blowouts", "blowouts", null, "2026-08-26"), false);

console.log("— isOfficeIss: office bookings never credit a canvasser —");
check("exact label", isOfficeIss("Office Appt"), true);
check("board truncation", isOfficeIss("Office A…"), true);
check("case-insensitive", isOfficeIss("office appointment"), true);
check("issued lead keeps credit", isOfficeIss("Iss"), false);
check("blank Iss IS an issued lead", isOfficeIss(""), false);
check("null Iss IS an issued lead", isOfficeIss(null), false);
check("Not Issued is a pipeline state, not an office appt", isOfficeIss("Not Issued"), false);
check("CTC is a pipeline state", isOfficeIss("CTC"), false);
check("Add Rep is a pipeline state", isOfficeIss("Add Rep"), false);

console.log("— the gate must NOT catch knocked production —");
const col = (title: string, text: string | null): MondayCol => ({
  id: title.toLowerCase(), text, column: { id: title.toLowerCase(), title },
});
check("door upsell on an issued lead still credits",
  isOfficeIss(findIssCol([col("Iss", "Iss"), col("Sale", "Upsell")])?.text), false);
check("canvasser reset still credits",
  isOfficeIss(findIssCol([col("Iss", null), col("Canvass Stats", "Reset")])?.text), false);
check("a Job Walk Source alone never condemns a card",
  isOfficeIss(findIssCol([col("Iss", "Iss"), col("Source", "Job Walk")])?.text), false);
check("office reload IS caught",
  isOfficeIss(findIssCol([col("Iss", "Office Appt"), col("Sale", "Reload")])?.text), true);

console.log("— findIssCol —");
check("exact title beats a lookalike",
  findIssCol([col("Issues", "Office"), col("Iss", "Iss")])?.text, "Iss");
check("renamed column → undefined, gate fails OPEN",
  findIssCol([col("Sale", "Sold")]), undefined);
check("failing open keeps credit", isOfficeIss(findIssCol([col("Sale", "Sold")])?.text), false);

console.log("— Chemberlen regression (OC pulse 12898859448) —");
const chemberlen = [
  col("Iss", "Office Appt"), col("Source", "Job Walk"), col("Agent", ""),
  col("Canvass Stats", "Sale"), col("Sale", "Sold"), col("Sale Price", "25948"),
];
check("detected as office-generated", isOfficeIss(findIssCol(chemberlen)?.text), true);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll block-day attribution checks passed");
