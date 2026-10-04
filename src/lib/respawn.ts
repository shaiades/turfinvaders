// ═══════════════════════════════════════════════════════════════════════════
// RESPAWN — sales-rep shift-off requests (Close Kombat, owner ask 2026-10-03).
//
// A "closer" steps off the floor to recharge and comes back for the next
// fight: reps request AM/PM shifts off, weeks in advance; Tyler / Shai / Jorge
// approve them; approved shifts flow into the Monday attendance boards so the
// nightly lineup knows who is off. This module is PURE (no React, no network)
// so the verify script and both the client and the server share one source of
// truth for: the 14 shift keys, the Monday column maps, the Sunday-noon PT
// deadline / "late" rule, and the Fri 6 PM → Sun 12 PM reminder window.
//
// Named distinct from the van-crew `day_off_requests` system (per-day
// captain-approved absences, migration 20261002180000) — different people,
// different shape, different approvers. See [[van-crew day_off]] in that file.
// ═══════════════════════════════════════════════════════════════════════════
import { addDaysISO, laDateISO, laMidnightUtcISO, weekStartOfISO } from "@/lib/dates";
import { type OfficeLocation } from "@/lib/offices";

export type RepOffice = "SD" | "OC";
// "partial" = the approver granted some but not all requested shifts.
export type RespawnStatus = "pending" | "approved" | "denied" | "partial";

// Mon–Sun, AM then PM: 14 half-day shifts. Order is the canonical display and
// storage order (the Monday dropdown + the day grid both read it).
export type ShiftKey =
  | "mon_am"
  | "mon_pm"
  | "tue_am"
  | "tue_pm"
  | "wed_am"
  | "wed_pm"
  | "thu_am"
  | "thu_pm"
  | "fri_am"
  | "fri_pm"
  | "sat_am"
  | "sat_pm"
  | "sun_am"
  | "sun_pm";

export const SHIFT_KEYS: readonly ShiftKey[] = [
  "mon_am",
  "mon_pm",
  "tue_am",
  "tue_pm",
  "wed_am",
  "wed_pm",
  "thu_am",
  "thu_pm",
  "fri_am",
  "fri_pm",
  "sat_am",
  "sat_pm",
  "sun_am",
  "sun_pm",
] as const;

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayKey = (typeof DAY_KEYS)[number];
export const DAY_LABEL: Record<DayKey, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

/** Human label for a shift, e.g. "Mon AM". Doubles as the Monday Day-Off
 *  board dropdown label (`multi_selecti4knd3v6`) — they are kept identical. */
export const SHIFT_LABEL: Record<ShiftKey, string> = {
  mon_am: "Mon AM",
  mon_pm: "Mon PM",
  tue_am: "Tue AM",
  tue_pm: "Tue PM",
  wed_am: "Wed AM",
  wed_pm: "Wed PM",
  thu_am: "Thu AM",
  thu_pm: "Thu PM",
  fri_am: "Fri AM",
  fri_pm: "Fri PM",
  sat_am: "Sat AM",
  sat_pm: "Sat PM",
  sun_am: "Sun AM",
  sun_pm: "Sun PM",
};

export function shiftDay(s: ShiftKey): DayKey {
  return s.slice(0, 3) as DayKey;
}
export function shiftHalf(s: ShiftKey): "AM" | "PM" {
  return s.endsWith("_am") ? "AM" : "PM";
}

// ── Monday.com boards ──────────────────────────────────────────────────────
// Read live 2026-10-03 (board 18433859047 "Rep Day-Off Requests", SD/OC Rep
// Attendance). Column ids are board-stable; the attendance boards share the
// SAME shift→column ids (only the board id differs by office).

export const DAY_OFF_BOARD_ID = "18433859047";
export const DAY_OFF_GROUP_ID = "topics"; // "Incoming responses"
export const DAY_OFF_COL = {
  office: "single_selectuvuk01x",
  week: "datex7dtl6mv",
  shifts: "multi_selecti4knd3v6",
  reason: "long_textmogqw8bd",
  approval: "color_mm7t97g7",
} as const;

export const ATTENDANCE_BOARD_ID: Record<RepOffice, string> = {
  SD: "5291879937",
  OC: "18411800909",
};

/** shift → attendance-board status column id (same on both office boards). */
export const SHIFT_ATTENDANCE_COL: Record<ShiftKey, string> = {
  mon_am: "color0",
  mon_pm: "dup__of_mon_am",
  tue_am: "status",
  tue_pm: "dup__of_tuesday",
  wed_am: "dup__of_status",
  wed_pm: "dup__of_wednesday",
  thu_am: "color",
  thu_pm: "dup__of_thursday",
  fri_am: "color2",
  fri_pm: "dup__of_fri_am",
  sat_am: "color22",
  sat_pm: "dup__of_sat_am",
  sun_am: "color7",
  sun_pm: "status_mkn3rnr9",
};

/** The Day-Off board Office status label for our short office code. */
export const OFFICE_DAYOFF_LABEL: Record<RepOffice, string> = {
  SD: "San Diego",
  OC: "Orange County",
};
/** The Day-Off board Approval status label for a request status. The board's
 *  Approval column has only Pending/Approved/Denied, so a PARTIAL grant reads
 *  as Approved there (the granted/declined detail rides the reason note). */
export function mondayApprovalLabel(status: RespawnStatus): string {
  if (status === "pending") return "Pending";
  if (status === "denied") return "Denied";
  return "Approved"; // approved + partial
}
/** The attendance boards mark a shift OFF by this exact label (not index — the
 *  Sunday PM column uses a different index than the rest). */
export const ATTENDANCE_OFF_LABEL = "Off";

// ── Office mapping ─────────────────────────────────────────────────────────
// profiles.office_location is the full string ("San Diego" / "Orange County",
// null → San Diego, the pre-OC default). We store the short SD/OC code.

export function officeToRep(office: string | null | undefined): RepOffice {
  const o = (office ?? "").toLowerCase();
  if (o.includes("orange") || o.includes("oc")) return "OC";
  return "SD";
}
export function repOfficeToLocation(o: RepOffice): OfficeLocation {
  return o === "OC" ? "Orange County" : "San Diego";
}
export function isRepOffice(x: unknown): x is RepOffice {
  return x === "SD" || x === "OC";
}

// ── Shift validation ───────────────────────────────────────────────────────

export function isShiftKey(x: unknown): x is ShiftKey {
  return typeof x === "string" && (SHIFT_KEYS as readonly string[]).includes(x);
}

/** Keep only valid shift keys, dedupe, and return them in canonical order. */
export function normalizeShifts(arr: unknown): ShiftKey[] {
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  for (const x of arr) if (isShiftKey(x)) seen.add(x);
  return SHIFT_KEYS.filter((k) => seen.has(k));
}

/** Monday-start check: a legal week_start is the Monday of its own week. */
export function isMondayISO(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && weekStartOfISO(iso) === iso;
}

// ── Deadline / late (America/Los_Angeles) ──────────────────────────────────
// Requests for a week are due SUNDAY 12:00 PM PT — i.e. noon on the Sunday
// BEFORE that Monday (week_start − 1 day). Submitted or edited after that, the
// request still lands but is flagged "late" for the approver.

export function respawnDeadlineMs(weekStartISO: string): number {
  const sundayBefore = addDaysISO(weekStartISO, -1);
  // laMidnightUtcISO gives the UTC instant of LA midnight that date (DST-safe);
  // noon is +12h.
  return Date.parse(laMidnightUtcISO(sundayBefore)) + 12 * 60 * 60 * 1000;
}

export function isLateForWeek(weekStartISO: string, nowMs: number = Date.now()): boolean {
  return nowMs > respawnDeadlineMs(weekStartISO);
}

// ── Reminder popup window (Fri 6 PM → Sun 12 PM PT) ─────────────────────────

const LA_HOUR_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour: "2-digit",
  hour12: false,
});

/** LA weekday (0=Sun..6=Sat) and wall-clock hour (0–23) for an instant. */
export function laWeekdayHour(now: Date = new Date()): { weekday: number; hour: number } {
  const iso = laDateISO(now);
  const [y, m, d] = iso.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  const rawHour = LA_HOUR_FMT.format(now);
  const hour = Number(rawHour === "24" ? "0" : rawHour);
  return { weekday, hour };
}

/** True from Friday 6:00 PM PT through Sunday 11:59 AM PT. */
export function inReminderWindow(now: Date = new Date()): boolean {
  const { weekday, hour } = laWeekdayHour(now);
  if (weekday === 5) return hour >= 18; // Fri from 6 PM
  if (weekday === 6) return true; // all Saturday
  if (weekday === 0) return hour < 12; // Sun until noon
  return false;
}

/** The Monday of the "coming week" a Fri–Sun reminder is about: always the
 *  upcoming Monday (this week's Monday + 7) across the whole window. */
export function comingWeekStartISO(now: Date = new Date()): string {
  return addDaysISO(weekStartOfISO(laDateISO(now)), 7);
}

// ── Attendance "current week" (Sunday-noon rollover) ────────────────────────
// Which week the attendance boards currently represent for WRITES. Normally the
// LA Mon–Sun week containing `now`; from Sunday 12:00 PM PT onward it rolls to
// the COMING week, so a weekend approval for next week actually reaches
// attendance (before this, `laWeekStartISO(now)` never matched a coming-week
// request on a Sun afternoon, and the write was silently skipped).

export function attendanceWeekStartISO(now: Date = new Date()): string {
  const thisWeek = weekStartOfISO(laDateISO(now));
  const { weekday, hour } = laWeekdayHour(now);
  if (weekday === 0 && hour >= 12) return addDaysISO(thisWeek, 7); // Sun ≥ noon → next week
  return thisWeek;
}

// ── Withdraw / edit rules ───────────────────────────────────────────────────

/** Who may WITHDRAW a request: an approver (admin) may withdraw any; the rep who
 *  owns it may withdraw ONLY while it is still pending (an approved/denied one
 *  must be EDITED, which sends it back to pending first). */
export function canWithdrawRespawn(input: {
  isOwner: boolean;
  isAdmin: boolean;
  status: RespawnStatus;
}): boolean {
  if (input.isAdmin) return true;
  if (input.isOwner) return input.status === "pending";
  return false;
}

/** The granted shifts whose attendance writes must be REVERTED (set back On)
 *  when a request is edited back to pending — only when it had actually been
 *  applied: a previously approved/partial request for the current attendance
 *  week. [] otherwise. */
export function shiftsToRevertOnResubmit(
  prev: { status: RespawnStatus; approvedShifts: unknown; weekStart: string } | null,
  attendanceWeek: string,
): ShiftKey[] {
  if (!prev) return [];
  if (prev.weekStart !== attendanceWeek) return [];
  if (prev.status !== "approved" && prev.status !== "partial") return [];
  return normalizeShifts(prev.approvedShifts);
}

// ── Office validation (roster, not self-reported) ───────────────────────────

/** Resolve the office to store on a respawn request from the rep's ROSTER
 *  office (profiles.office_location) — never a value the rep typed. Returns the
 *  roster office plus whether a supplied answer disagreed (for logging). e.g.
 *  Sam Corona's roster is OC, so an "answer" of "San Diego" is ignored. */
export function resolveRosterOffice(
  rosterOfficeLocation: string | null | undefined,
  answeredOffice?: string | null,
): { office: RepOffice; mismatch: boolean } {
  const office = officeToRep(rosterOfficeLocation);
  const mismatch = answeredOffice != null && officeToRep(answeredOffice) !== office;
  return { office, mismatch };
}

// ── Shared summary helpers (UI chips + Monday notes) ────────────────────────

/** "Mon AM · Mon PM · Fri AM" from a shift list, in canonical order. */
export function summarizeShifts(shifts: ShiftKey[]): string {
  return normalizeShifts(shifts)
    .map((s) => SHIFT_LABEL[s])
    .join(" · ");
}

/** Resolve a review decision. The approver may grant a SUBSET of what was
 *  requested (trim-then-approve); `granted` is clamped to the requested set.
 *  - deny, or grant nothing → "denied" (approvedShifts empty)
 *  - grant every requested shift → "approved"
 *  - grant some but not all → "partial"
 *  declinedShifts is what the rep asked for but didn't get. */
export function settleApproval(
  requested: ShiftKey[],
  granted: ShiftKey[] | null | undefined,
  approve: boolean,
): { status: RespawnStatus; approvedShifts: ShiftKey[]; declinedShifts: ShiftKey[] } {
  const req = normalizeShifts(requested);
  if (!approve) return { status: "denied", approvedShifts: [], declinedShifts: req };
  const g = normalizeShifts(granted ?? req).filter((s) => req.includes(s));
  const declined = req.filter((s) => !g.includes(s));
  if (g.length === 0) return { status: "denied", approvedShifts: [], declinedShifts: req };
  if (declined.length === 0) return { status: "approved", approvedShifts: g, declinedShifts: [] };
  return { status: "partial", approvedShifts: g, declinedShifts: declined };
}
