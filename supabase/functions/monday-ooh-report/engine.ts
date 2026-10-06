// ═══════════════════════════════════════════════════════════════════════════
// OUT OF HOUSE (OOH) write-back engine — PURE logic (no network, no Deno/Node
// APIs) so the webhook receiver (Deno edge fn) and the verify script (tsx/Node)
// share ONE source of truth. Owner brief 2026-10-03.
//
// When a rep submits the Monday form "Out of House Reports" (board 18433859050)
// Turf Invaders writes the result onto that lead's BLOCK item the same way Jorge
// does by hand: type the notes/values, then press ONE disposition button. The
// block's existing Monday automations do ALL routing (Rehash / Blowout /
// Confirmed / Sales Processing, plus texts and stats). We never route anything
// ourselves and never touch the destination boards.
//
// Column ids + status label ids/text were read LIVE from boards 18433859050
// (form), 18432844990 (SD block) and 18432845324 (OC block) on 2026-10-03/04;
// SD and OC blocks share identical column ids and status labels.
// ═══════════════════════════════════════════════════════════════════════════

// ── Boards ───────────────────────────────────────────────────────────────────
export const FORM_BOARD_ID = "18433859050"; // "Out of House Reports"

/** The OOH form board's "Dispatcher" status column — the outcome Claude/edge-fn
 *  stamps on each submission so the office can see it at a glance. Labels read
 *  live 2026-10-05: New (default) / Processed / Needs review / Error. */
export const OOH_DISPATCHER_COL = "color_mm7vex4s";
export const DISPATCHER_LABEL = {
  processed: "Processed",
  needsReview: "Needs review",
  error: "Error",
} as const;
/** Destinations the block's own automations own — NEVER written here. For docs. */
export const DESTINATION_BOARDS = {
  salesProcessing: "4155553389",
  rehashLog: "4155519215",
  blowoutLog: "4155519525",
  confirmedSD: "4155519846",
  confirmedOC: "18411299428",
} as const;

// ── Form columns (board 18433859050) ────────────────────────────────────────
export const FORM_COL = {
  repName: "single_selectct0w80q", // "Your name" (status, rep labels)
  partner: "single_selectmrnw9q8", // "Who ran this appointment with you?"
  partnerPresent: "single_selectroga2h2", // "Was your partner there the whole time?"
  apptDate: "datellcnw3xg",
  address: "short_textcdqow6xq",
  onBlock: "single_selectg8mobdl", // 0 Yes | 1 Upsell | 2 Self-gen | 3 Reload
  phone: "phonejzri6m27",
  result: "single_selectorxwgbu", // 0..7 (see RESULT)
  quoted: "multi_selecte3yis8co", // dropdown (products)
  quantities: "long_text8phgep8l",
  highPrice: "number348v8ruv",
  lowPrice: "numberwcvqa8u3",
  salePrice: "numberpj7xiewz",
  objection: "single_selectqkvrrih",
  objectionDetails: "long_textx0f2pmjw",
  dropCall: "single_select2xq74gd", // 0 Tyler|1 Shai|2 Jorge|3 Other mgr|4 No drop call
  arrival: "houry34jj7ex", // "What time did you get to the house?"
  notes: "long_textvdslqv01",
  leadId: "short_texttlxjsw57", // block item id (auto); blank = self-gen/upsell/reload
  resetDate: "datepjz0z15u",
  whoMissing: "single_select55d5i6x",
  inspection: "single_selecte9k7kil", // 0 Yes | 1 No
  resetCall: "single_selectyucz7h0", // 0 Yes-reset set | 1 No reset
  whyNoDemo: "single_selectdqlakw6",
  whatHappened: "long_textpk8jpais",
  minutesWaited: "numberbudx8yh5",
  calledTexted: "single_selectiv9qswz", // 0 Yes | 1 No
} as const;

// ── Block columns (boards 18432844990 / 18432845324, identical except Source
// Code — see SOURCE_CODE_COL) ─────────────────────────────────────────────────
export const BLOCK_COL = {
  name: "name",
  reps: "people6", // max 2 (pairs)
  phone: "phone_1",
  source: "text", // "Source" — drives Rule 4
  agent: "text5", // "Agent" — free-text, marker scanning (rehash/job walk)
  comments: "long_text", // "Comments" — can/save + language markers
  location: "location", // "Location" — house coordinates (live-dispatch drive time)
  office: "color_mm2yd84r", // 0 Orange County | 1 San Diego
  apptDateTime: "date9", // "Date/Time" — Rule 3 arrival fallback
  details: "long_text3",
  products: "dropdown", // "Products" — quoted/booked products (strength table)
  salePrice: "numbers",
  resetDate: "date", // date + time
  advantage: "color_mkwkazqn", // "Advantage+" — 0 Non Member | 1 Advantage+ (Rule: every Sold)
  reloads: "dropdown2",
  sourceCode: "numeric_mm35kwnj", // SD id — OC differs; WRITE via SOURCE_CODE_COL
  // disposition status columns
  iss: "status", // Add Rep|Reload|CTC|Not Issued|Office Appt|Iss
  bo: "status4", // No Show|No show text|No Demo|None
  ol: "status_3", // OL|None
  rs: "status_2", // Reset|None
  pm: "status_1", // PM|PM w/ RS|None
  sale: "status9", // Sold|Upsell|Reload
} as const;

/**
 * Source Code column id PER OFFICE — the ONE block column whose id differs
 * between the SD and OC boards (read live 2026-10-06: SD `numeric_mm35kwnj`,
 * OC `numeric_mm35nm4y`). Writing the SD id on the OC board lands in a dead
 * column, so every Source Code write must go through this map.
 */
export const SOURCE_CODE_COL: Record<"SD" | "OC", string> = {
  SD: "numeric_mm35kwnj",
  OC: "numeric_mm35nm4y",
};

/** Block Advantage+ labels (color_mkwkazqn; identical on Sales Processing's
 *  color_mkwkmx6g): index 1 = Advantage+, index 0 = Non Member. Pressed by
 *  label text like every other status. */
export const ADVANTAGE_LABEL = { member: "Advantage+", nonMember: "Non Member" } as const;

/** Exact Monday status label text (press by LABEL, never numeric index). */
export const LABEL = {
  sold: "Sold",
  upsell: "Upsell",
  saleReload: "Reload",
  pm: "PM",
  pmReset: "PM w/ RS",
  reset: "Reset",
  ol: "OL",
  noShow: "No Show",
  noShowText: "No show text",
  noDemo: "No Demo",
  iss: "Iss",
  notIssued: "Not Issued",
  officeAppt: "Office Appt",
} as const;

/** Iss-column label INDEXES for creating an item with its status pre-set (read
 *  live 2026-10-06). Setting the status in the create_item call itself means no
 *  status-change automation fires — so an off-block add sends no lead text. */
export const ISS_CREATE_INDEX = { reload: 1, iss: 103, officeAppt: 16 } as const;

/** Block Iss-column labels that keep their OWN flow — never auto-released. */
export const RELEASE_EXCLUDED_STATUSES = ["Office Appt", "CTC", "Reload", "Add Rep"] as const;

/** A status label is "blank" when it's empty or the explicit Monday "None". */
export function isBlankStatus(label: string | null | undefined): boolean {
  const t = (label ?? "").trim();
  return t === "" || t.toLowerCase() === "none";
}

/** The five disposition columns on a block item (everything except Iss). */
export type DispositionLabels = {
  pm: string | null; // status_1
  rs: string | null; // status_2
  ol: string | null; // status_3
  bo: string | null; // status4
  sale: string | null; // status9
};

/**
 * True when a disposition column is already set on a block item — the rep or
 * office already dispositioned it, so the write-back must NOT press again
 * (Rule: a lead can never be routed twice). The at-the-door "No show text"
 * marker is the ONE exception: it holds the lead open (rep still waiting), so a
 * real report may still land on top of it.
 */
export function hasExistingDisposition(d: DispositionLabels): boolean {
  if (
    !isBlankStatus(d.pm) ||
    !isBlankStatus(d.rs) ||
    !isBlankStatus(d.ol) ||
    !isBlankStatus(d.sale)
  )
    return true;
  if (!isBlankStatus(d.bo) && (d.bo ?? "").trim() !== LABEL.noShowText) return true;
  return false;
}

/**
 * Rule 7 "open lead": the rep still holds the lead and owes a report. True iff
 * Iss is pressed AND no disposition column is set — with the single exception
 * that status4 = "No show text" (at the door) keeps the lead open. A lead that
 * was dispositioned KEEPS its Iss label, so counting it as "held" is the bug
 * that stranded every next lead — this rule is the fix.
 */
export function isOpenLead(d: DispositionLabels & { iss: string | null }): boolean {
  if ((d.iss ?? "").trim() !== LABEL.iss) return false;
  return !hasExistingDisposition(d);
}

/** Accept a webhook only from the OOH form board. An event with no resolvable
 *  boardId is allowed through (the webhook is registered on the form board);
 *  a resolvable board that is not the form board is ignored. */
export function isAllowedOohBoard(boardId: string | number | null | undefined): boolean {
  if (boardId === null || boardId === undefined || boardId === "") return true;
  return String(boardId) === FORM_BOARD_ID;
}

/** Idempotency key for the per-submission activity-log update. Keyed by the
 *  FORM item id (unique per submission) so a second report on the SAME block
 *  item still posts — keying by block item id dropped the second note. */
export const oohUpdateKey = (formItemId: string): string => `ooh-update-${formItemId}`;

/** Monday weekday (0=Sun..6=Sat) → block day-group id (same on SD + OC). */
export const BLOCK_DAY_GROUP: Record<number, string> = {
  1: "new_group67742", // Monday
  2: "new_group73798", // Tuesday
  3: "new_group7344", // Wednesday
  4: "new_group18616", // Thursday
  5: "new_group68787", // Friday
  6: "new_group69446", // Saturday
  0: "new_group", // Sunday
};

// Form "Result" (single_selectorxwgbu) index → meaning.
export const RESULT = {
  SOLD: 0,
  PITCH_MISS: 1,
  PM_WITH_RESET: 2,
  RESET: 3,
  ONE_LEGGER: 4,
  NO_DEMO: 5,
  NO_SHOW_FINAL: 6,
  AT_THE_DOOR: 7,
} as const;
export type ResultCode = (typeof RESULT)[keyof typeof RESULT];

// Form "On today's block?" (single_selectg8mobdl) index → meaning.
export const ON_BLOCK = { YES: 0, UPSELL: 1, SELF_GEN: 2, RELOAD: 3 } as const;

// ── Pacific-time helpers (self-contained; Intl works in Deno + Node) ─────────
const LA_TZ = "America/Los_Angeles";
const LA_HM = new Intl.DateTimeFormat("en-GB", {
  timeZone: LA_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const LA_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: LA_TZ,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const LA_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: LA_TZ });

/** LA wall "H:MM" (no leading-zero hour) for an instant — e.g. "(10:08)", "(4:42)". */
export function laClock(ms: number): string {
  const [h, m] = LA_HM.format(new Date(ms)).split(":");
  return `${Number(h)}:${m}`;
}
/** LA hour+minute of an instant. */
export function laHourMinute(ms: number): { hour: number; minute: number } {
  const [h, m] = LA_HM.format(new Date(ms)).split(":").map(Number);
  return { hour: h, minute: m };
}
/** LA calendar date (YYYY-MM-DD) of an instant. */
export function laDate(ms: number): string {
  return LA_DATE.format(new Date(ms));
}
/** LA weekday 0=Sun..6=Sat of an instant. */
export function laWeekday(ms: number): number {
  const wd = LA_PARTS.formatToParts(new Date(ms)).find((p) => p.type === "weekday")?.value ?? "Sun";
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? 0;
}

/**
 * LA wall-minutes (hour*60 + minute) for a Monday date-column value. Monday
 * stores a date column's {date,time} in UTC; this converts to the Pacific wall
 * clock so same-day ordering and "later than" comparisons use real local time
 * (a 5:30 PM PT appointment is stored "00:30" the NEXT UTC day — read raw, it
 * sorts before a 1 PM appointment). Returns null when there is no time.
 */
export function laWallMinutesFromUtc(
  date: string | null | undefined,
  time: string | null | undefined,
): number | null {
  if (!date || !time) return null;
  const [y, mo, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  if (![y, mo, d, hh].every(Number.isFinite)) return null;
  const ms = Date.UTC(y, mo - 1, d, hh || 0, mm || 0);
  const { hour, minute } = laHourMinute(ms);
  return hour * 60 + minute;
}

/** "H:MM" elapsed between two wall-clock minute counts (same LA day). null if
 *  not computable or non-positive. */
export function minutesToHM(mins: number | null): string | null {
  if (mins == null || !Number.isFinite(mins) || mins <= 0) return null;
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
}

// ── Parsed form shape ────────────────────────────────────────────────────────
export type ColVal = { text: string | null; value: string | null };
export type ColMap = Record<string, ColVal>;

export type OohForm = {
  formItemId: string;
  repName: string | null;
  partner: string | null;
  onBlock: number | null;
  result: ResultCode | null;
  leadId: string | null;
  address: string | null;
  phone: string | null;
  quotedText: string | null;
  quantities: string | null;
  highPrice: number | null;
  lowPrice: number | null;
  salePrice: number | null;
  objection: string | null;
  objectionDetails: string | null;
  dropCall: string | null;
  arrival: { hour: number; minute: number } | null;
  notes: string | null;
  resetDate: { date: string; time: string | null } | null;
  whoMissing: string | null;
  inspection: number | null; // 0 Yes | 1 No
  resetCall: number | null; // 0 reset set | 1 no reset
  whyNoDemo: string | null;
  whatHappened: string | null;
  minutesWaited: number | null;
  calledTexted: number | null; // 0 Yes | 1 No
};

function statusText(c: ColVal | undefined): string | null {
  const t = (c?.text ?? "").trim();
  return t ? t : null;
}
function statusIndex(c: ColVal | undefined): number | null {
  if (!c?.value) return null;
  try {
    const i = (JSON.parse(c.value) as { index?: number }).index;
    return typeof i === "number" ? i : null;
  } catch {
    return null;
  }
}
function numVal(c: ColVal | undefined): number | null {
  const t = (c?.text ?? "").replace(/[$,]/g, "").trim();
  if (t) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  if (c?.value) {
    try {
      const n = Number(JSON.parse(c.value));
      if (Number.isFinite(n)) return n;
    } catch {
      /* ignore */
    }
  }
  return null;
}
function textVal(c: ColVal | undefined): string | null {
  const t = (c?.text ?? "").trim();
  return t ? t : null;
}
function hourVal(c: ColVal | undefined): { hour: number; minute: number } | null {
  if (c?.value) {
    try {
      const v = JSON.parse(c.value) as { hour?: number; minute?: number };
      if (typeof v.hour === "number") return { hour: v.hour, minute: v.minute ?? 0 };
    } catch {
      /* fall through to text */
    }
  }
  const m = (c?.text ?? "").match(/(\d{1,2}):(\d{2})/);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}
function dateVal(c: ColVal | undefined): { date: string; time: string | null } | null {
  if (c?.value) {
    try {
      const v = JSON.parse(c.value) as { date?: string; time?: string | null };
      if (v.date) return { date: v.date, time: v.time ?? null };
    } catch {
      /* fall through */
    }
  }
  const t = (c?.text ?? "").trim();
  const m = t.match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?)?/);
  return m ? { date: m[1], time: m[2] ?? null } : null;
}

/** Parse the form item's column values into a typed OohForm. */
export function parseOohForm(formItemId: string, cols: ColMap): OohForm {
  const g = (id: string) => cols[id];
  const result = statusIndex(g(FORM_COL.result));
  const onBlock = statusIndex(g(FORM_COL.onBlock));
  return {
    formItemId,
    repName: statusText(g(FORM_COL.repName)),
    partner: statusText(g(FORM_COL.partner)),
    onBlock: onBlock,
    result: (result as ResultCode | null) ?? null,
    leadId: (textVal(g(FORM_COL.leadId)) ?? "").match(/^\d+$/) ? textVal(g(FORM_COL.leadId)) : null,
    address: textVal(g(FORM_COL.address)),
    phone: textVal(g(FORM_COL.phone)),
    quotedText: textVal(g(FORM_COL.quoted)),
    quantities: textVal(g(FORM_COL.quantities)),
    highPrice: numVal(g(FORM_COL.highPrice)),
    lowPrice: numVal(g(FORM_COL.lowPrice)),
    salePrice: numVal(g(FORM_COL.salePrice)),
    objection: statusText(g(FORM_COL.objection)),
    objectionDetails: textVal(g(FORM_COL.objectionDetails)),
    dropCall: statusText(g(FORM_COL.dropCall)),
    arrival: hourVal(g(FORM_COL.arrival)),
    notes: textVal(g(FORM_COL.notes)),
    resetDate: dateVal(g(FORM_COL.resetDate)),
    whoMissing: statusText(g(FORM_COL.whoMissing)),
    inspection: statusIndex(g(FORM_COL.inspection)),
    resetCall: statusIndex(g(FORM_COL.resetCall)),
    whyNoDemo: statusText(g(FORM_COL.whyNoDemo)),
    whatHappened: textVal(g(FORM_COL.whatHappened)),
    minutesWaited: numVal(g(FORM_COL.minutesWaited)),
    calledTexted: statusIndex(g(FORM_COL.calledTexted)),
  };
}

// ── Rule 3: Details line, Jorge's one-line format ────────────────────────────

/** Short prefix for a result (+ on-block sale type). */
export function resultPrefix(form: OohForm): string {
  switch (form.result) {
    case RESULT.SOLD:
      if (form.onBlock === ON_BLOCK.UPSELL) return "Upsell";
      if (form.onBlock === ON_BLOCK.RELOAD) return "Reload";
      return "Sold";
    case RESULT.PITCH_MISS:
      return "PM";
    case RESULT.PM_WITH_RESET:
      return "PM w/ RS";
    case RESULT.RESET:
      return "Reset";
    case RESULT.ONE_LEGGER:
      return form.resetCall === 0 ? "Reset" : "OL";
    case RESULT.NO_DEMO:
      return "No demo";
    case RESULT.NO_SHOW_FINAL:
      return "No show";
    case RESULT.AT_THE_DOOR:
      return "No answer at door";
    default:
      return "Report";
  }
}

const dropName = (d: string | null): string | null =>
  !d || /no drop call/i.test(d) ? null : d.replace(/^other manager$/i, "Other mgr");

/** Minutes elapsed in the house: submit wall-minutes − arrival wall-minutes.
 *  Arrival falls back to the block appointment time when the form field is
 *  blank (Rule 3). Returns null when neither is available. */
export function timeInHouseMins(
  form: OohForm,
  submitMs: number,
  apptFallback: { hour: number; minute: number } | null,
): number | null {
  const start = form.arrival ?? apptFallback;
  if (!start) return null;
  const sub = laHourMinute(submitMs);
  return sub.hour * 60 + sub.minute - (start.hour * 60 + start.minute);
}

/**
 * Build the single Details line. Ends with the time the rep was out of the
 * house in parentheses (the submit time, PT). Appended to any existing Details
 * by the caller — never overwrites (Rule 3).
 */
export function buildDetailsLine(
  form: OohForm,
  submitMs: number,
  apptFallback: { hour: number; minute: number } | null = null,
): string {
  const parts: string[] = [];
  // Only Sold / Pitch miss / PM-with-reset carry quote, pricing and objection
  // (those are the only Results whose form shows those questions). Gating by
  // Result — not just by "is the value present" — keeps a stray/hidden answer
  // (e.g. a leftover objection on an At-the-door report) out of the block note.
  const isQuoteResult =
    form.result === RESULT.SOLD ||
    form.result === RESULT.PITCH_MISS ||
    form.result === RESULT.PM_WITH_RESET;
  const isObjectionResult =
    form.result === RESULT.PITCH_MISS || form.result === RESULT.PM_WITH_RESET;

  const quoted = form.quantities || form.quotedText;
  const head = isQuoteResult && quoted ? `${resultPrefix(form)} – ${quoted}` : resultPrefix(form);
  parts.push(head);

  // Pricing (Sold / PM branches).
  if (isQuoteResult && (form.highPrice != null || form.lowPrice != null)) {
    const hi = form.highPrice != null ? `High $${form.highPrice.toLocaleString("en-US")}` : null;
    const lo = form.lowPrice != null ? `Low $${form.lowPrice.toLocaleString("en-US")}` : null;
    parts.push([hi, lo].filter(Boolean).join(" / "));
  }
  if (form.result === RESULT.SOLD && form.salePrice != null) {
    parts.push(`Sale $${form.salePrice.toLocaleString("en-US")}`);
  }

  // Objection (PM branches only).
  if (isObjectionResult && form.objection) {
    parts.push(
      `Obj: ${form.objection}${form.objectionDetails ? ` – ${form.objectionDetails}` : ""}`,
    );
  }

  // Reset / One-legger branch details.
  if (form.result === RESULT.RESET || form.result === RESULT.ONE_LEGGER) {
    const bits: string[] = [];
    if (form.whoMissing) bits.push(`${form.whoMissing} missing`);
    if (form.inspection != null)
      bits.push(form.inspection === 0 ? "inspection done" : "no inspection");
    if (form.result === RESULT.ONE_LEGGER) {
      bits.push(form.resetCall === 0 ? "reset set" : "no reset");
    }
    if (form.resetDate) bits.push(`reset ${fmtReset(form.resetDate)}`);
    if (bits.length) parts.push(bits.join(", "));
  } else if (form.result === RESULT.PM_WITH_RESET && form.resetDate) {
    parts.push(`reset ${fmtReset(form.resetDate)}`);
  }

  // No-demo branch.
  if (form.result === RESULT.NO_DEMO) {
    const bits: string[] = [];
    if (form.whyNoDemo) bits.push(form.whyNoDemo);
    if (form.whatHappened) bits.push(form.whatHappened);
    if (bits.length) parts.push(bits.join(": "));
  }

  // No-show (final) branch.
  if (form.result === RESULT.NO_SHOW_FINAL) {
    const bits: string[] = [];
    if (form.minutesWaited != null) bits.push(`waited ${form.minutesWaited} min`);
    if (form.calledTexted === 0) bits.push("called + texted");
    if (bits.length) parts.push(bits.join(", "));
  }

  // Free-form notes for the office.
  if (form.notes) parts.push(form.notes);

  // Drop call.
  const drop = dropName(form.dropCall);
  if (drop) parts.push(`Drop: ${drop}`);

  // Time in house (not for at-the-door, which has no completed appointment).
  if (form.result !== RESULT.AT_THE_DOOR) {
    const inHouse = minutesToHM(timeInHouseMins(form, submitMs, apptFallback));
    if (inHouse) parts.push(`In ${inHouse}`);
  }

  return `${parts.join(". ")} (${laClock(submitMs)})`;
}

/** True when this submission is a SALE (any Sold result — on-block, self-gen,
 *  upsell or reload). Drives the leadership SALE text. */
export function isSaleResult(form: OohForm): boolean {
  return form.result === RESULT.SOLD;
}

/**
 * The "SALE" alert texted to leadership (Tyler / Shai / Jorge) the moment a rep
 * sells: a loud banner, the rep(s), what they sold, and how much. Pure so the
 * verify script can assert it. Never invents an amount — a blank Sale Price just
 * omits the money line (owner rule: blank = unknown, don't backfill).
 */
export function buildSaleAlert(form: OohForm, customerName: string | null): string {
  const reps = [form.repName, form.partner].filter(Boolean).join(" & ") || "A rep";
  const what = (form.quantities || form.quotedText || "").trim();
  const amount = form.salePrice != null ? `$${form.salePrice.toLocaleString("en-US")}` : null;
  const kind = resultPrefix(form); // "Sold" | "Upsell" | "Reload"
  const lines = ["🟩🟩🟩  SALE  🟩🟩🟩"];
  if (amount) lines.push(`💰 ${amount}`);
  lines.push(`Rep: ${reps}`);
  lines.push(`${kind}${what ? `: ${what}` : ""}`);
  if (customerName && customerName.trim()) lines.push(`Customer: ${customerName.trim()}`);
  return lines.join("\n");
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtReset(r: { date: string; time: string | null }): string {
  // With a time, the {date,time} is a UTC instant (Monday stores date columns
  // in UTC) — convert to the Pacific wall clock so the weekday, m/d AND time
  // all read in LA (a late-day reset can roll to the next UTC date). A
  // date-only reset has no instant to shift, so use its calendar date as-is.
  if (r.time) {
    const [y, mo, d] = r.date.split("-").map(Number);
    const [hh, mm] = r.time.split(":").map(Number);
    const ms = Date.UTC(y, mo - 1, d, hh || 0, mm || 0);
    const [, lm, ld] = laDate(ms).split("-").map(Number);
    const { hour, minute } = laHourMinute(ms);
    return `${WD[laWeekday(ms)]} ${lm}/${ld} ${fmtClock12(hour, minute)}`;
  }
  const [y, m, d] = r.date.split("-").map(Number);
  return `${WD[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()]} ${m}/${d}`;
}
function fmtClock12(hh: number, mm: number): string {
  const ampm = hh >= 12 ? "pm" : "am";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return mm ? `${h12}:${String(mm).padStart(2, "0")}${ampm}` : `${h12}${ampm}`;
}

// ── Rule 4: Source Code fill (only on Sold, when the block code is blank) ─────
const SOURCE_CODE_ONE = new Set([
  "self gen",
  "selfgen",
  "self-gen",
  "canvass",
  "rep reset",
  "call in",
  "callin",
  "qr code",
  "qr",
  "flyer",
]);
const SOURCE_CODE_BLANK = new Set(["job walk", "jobwalk", "can save", "cansave", "can/save"]);

/**
 * The Source Code to WRITE for a Sold, or null to leave the block value alone.
 * - only Sold fills a code (Upsell/Reload route unconditionally — no code);
 * - never overwrites an existing non-blank code;
 * - Room → 2; Self Gen/Canvass/Rep Reset/Call In/QR Code/Flyer → 1;
 * - Job Walk / Can Save → blank (already in Sales Processing — a code dupes);
 * - any other non-empty source → 1 (must reach Sales Processing), flagged.
 */
export function sourceCodeToWrite(
  result: ResultCode | null,
  existingCode: number | null,
  source: string | null,
): { code: number | null; unknownSource: boolean } {
  if (result !== RESULT.SOLD) return { code: null, unknownSource: false };
  if (existingCode != null) return { code: null, unknownSource: false }; // keep what's there
  const s = (source ?? "").toLowerCase().trim();
  if (/\broom\b/.test(s)) return { code: 2, unknownSource: false };
  if ([...SOURCE_CODE_BLANK].some((k) => s.includes(k)))
    return { code: null, unknownSource: false };
  if ([...SOURCE_CODE_ONE].some((k) => s.includes(k))) return { code: 1, unknownSource: false };
  // Unknown/empty source: default to 1 so the sale still reaches Sales
  // Processing, but flag it so the office can correct a Job Walk/Can Save typo.
  return { code: 1, unknownSource: true };
}

// ── Reloads dropdown (dropdown2) — map the quoted products onto its labels ────
/** The exact Reloads dropdown (dropdown2) labels on the block boards (read live
 *  2026-10-04). A Reload maps its QUOTED products onto these — never "Room". */
export const RELOAD_DROPDOWN_LABELS = [
  "Roof",
  "Windows",
  "Gutters",
  "Stucco/Paint",
  "Patio Cover",
  "Pavers",
  "Turf",
  "Concrete",
  "Retaining Walls",
  "Hvac",
  "Flat roof",
  "Fence",
  "Insulation",
  "Solar",
  "GT Trim",
] as const;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Map a rep's quoted-products answer (the form's multi-select, comma-joined
 * text) onto the Reloads dropdown labels, in canonical order, deduped. Matches
 * case / spacing / punctuation insensitively; unmatched products are dropped
 * (we NEVER invent "Room"). Returns [] when nothing maps.
 */
export function reloadDropdownLabels(quoted: string | null | undefined): string[] {
  if (!quoted) return [];
  // Split on the multi-select's joiners only (comma / semicolon) — NOT on "/",
  // which lives inside a label ("Stucco/Paint").
  const want = new Set(
    quoted
      .split(/[,;]/)
      .map((p) => norm(p))
      .filter(Boolean),
  );
  return RELOAD_DROPDOWN_LABELS.filter((l) => want.has(norm(l)));
}

// ── Rules 1,2,5 + branch: the disposition plan ───────────────────────────────
export type MondayValue = unknown;
export type WritePlan = {
  /** Non-status, non-Details field writes for the FIRST call (Rule 1). */
  fieldWrites: Record<string, MondayValue>;
  /** The ONE disposition status to press in the SECOND call (Rule 1). */
  status: { col: string; label: string } | null;
  /** Fill Source Code (if the block's is blank) before pressing Sold (Rule 4). */
  fillSourceCodeIfBlank: boolean;
  /** This submission releases nothing and holds the rep at the door (Rule 6/7). */
  atTheDoor: boolean;
  /** When set, the submission can't be auto-applied — queue it for the office
   *  with this reason and press NOTHING (e.g. a reset result with no date). */
  needsReview: string | null;
};

/**
 * Map a parsed form to the block write plan (Rules 1, 2, 5 + branch questions).
 * Returns the NON-Details field writes plus the single status press; the caller
 * builds/append Details and (for Sold) fills Source Code.
 */
export function planDisposition(form: OohForm): WritePlan {
  const fieldWrites: Record<string, MondayValue> = {};
  const resetDateValue = form.resetDate
    ? { date: form.resetDate.date, ...(form.resetDate.time ? { time: form.resetDate.time } : {}) }
    : null;
  const base = {
    fieldWrites,
    fillSourceCodeIfBlank: false,
    atTheDoor: false,
    needsReview: null as string | null,
  };

  switch (form.result) {
    case RESULT.SOLD: {
      if (form.salePrice != null) fieldWrites[BLOCK_COL.salePrice] = String(form.salePrice);
      if (form.onBlock === ON_BLOCK.UPSELL) {
        return { ...base, status: { col: BLOCK_COL.sale, label: LABEL.upsell } };
      }
      if (form.onBlock === ON_BLOCK.RELOAD) {
        // Map the quoted products onto the Reloads dropdown — never "Room".
        const labels = reloadDropdownLabels(form.quotedText);
        if (labels.length > 0) fieldWrites[BLOCK_COL.reloads] = { labels };
        return { ...base, status: { col: BLOCK_COL.sale, label: LABEL.saleReload } };
      }
      // On-block Yes (0) or self-gen/own (2): a Sold that must reach Sales
      // Processing — fill a blank Source Code (Rule 4).
      return {
        ...base,
        status: { col: BLOCK_COL.sale, label: LABEL.sold },
        fillSourceCodeIfBlank: true,
      };
    }
    case RESULT.PITCH_MISS:
      return { ...base, status: { col: BLOCK_COL.pm, label: LABEL.pm } };
    case RESULT.PM_WITH_RESET:
      // A PM w/ reset with NO reset date can't be routed to Confirmed — queue it
      // for the office instead of pressing the button (Rule 4-adjacent).
      if (!resetDateValue)
        return { ...base, status: null, needsReview: "PM w/ reset but no reset date" };
      fieldWrites[BLOCK_COL.resetDate] = resetDateValue;
      return { ...base, status: { col: BLOCK_COL.pm, label: LABEL.pmReset } };
    case RESULT.RESET:
      if (!resetDateValue) return { ...base, status: null, needsReview: "Reset but no reset date" };
      fieldWrites[BLOCK_COL.resetDate] = resetDateValue;
      return { ...base, status: { col: BLOCK_COL.rs, label: LABEL.reset } };
    case RESULT.ONE_LEGGER:
      // Reset-call done (0) → Reset to Confirmed; no reset (1) → OL to Blowout.
      if (form.resetCall === 0) {
        if (resetDateValue) fieldWrites[BLOCK_COL.resetDate] = resetDateValue;
        return { ...base, status: { col: BLOCK_COL.rs, label: LABEL.reset } };
      }
      return { ...base, status: { col: BLOCK_COL.ol, label: LABEL.ol } };
    case RESULT.NO_DEMO:
      return { ...base, status: { col: BLOCK_COL.bo, label: LABEL.noDemo } };
    case RESULT.NO_SHOW_FINAL:
      return { ...base, status: { col: BLOCK_COL.bo, label: LABEL.noShow } };
    case RESULT.AT_THE_DOOR:
      // Rule 6: press "No show text" (the office automation texts the customer),
      // append a Details note, message the office — and release nothing.
      return { ...base, status: { col: BLOCK_COL.bo, label: LABEL.noShowText }, atTheDoor: true };
    default:
      return { ...base, status: null };
  }
}

// ── Rule 1: order of writes (two separate calls; one status) ─────────────────
export type MondayWriter = {
  setColumns(boardId: string, itemId: string, values: Record<string, MondayValue>): Promise<void>;
  setStatus(boardId: string, itemId: string, col: string, label: string): Promise<void>;
};
export type AppliedOp =
  | { kind: "columns"; values: Record<string, MondayValue> }
  | { kind: "status"; col: string; label: string };

/**
 * Apply a plan in the mandated order: FIRST one change_multiple_column_values
 * (Details + any of Sale Price / Reset Date / Reloads / Source Code), THEN a
 * SEPARATE call that presses exactly ONE disposition status. Never combines the
 * two; never presses two statuses. Returns the ops it performed, in order.
 */
export async function applyDisposition(
  writer: MondayWriter,
  boardId: string,
  itemId: string,
  columnValues: Record<string, MondayValue>,
  status: { col: string; label: string } | null,
): Promise<AppliedOp[]> {
  const ops: AppliedOp[] = [];
  if (Object.keys(columnValues).length > 0) {
    await writer.setColumns(boardId, itemId, columnValues);
    ops.push({ kind: "columns", values: columnValues });
  }
  if (status) {
    await writer.setStatus(boardId, itemId, status.col, status.label);
    ops.push({ kind: "status", col: status.col, label: status.label });
  }
  return ops;
}

// ── Matching the submission to a block item ──────────────────────────────────
export type Target =
  | { kind: "write"; leadId: string }
  | { kind: "create"; reason: string }
  | { kind: "queue"; reason: string };

/**
 * Decide where a submission is written (Rule: Lead ID → that block item;
 * blank + self-gen/upsell/reload → create a new item; otherwise admin queue).
 * The caller still verifies the Lead ID item is on a CURRENT block board and,
 * for create, resolves the office — unresolved cases fall back to the queue.
 */
export function matchTarget(form: OohForm): Target {
  if (form.leadId) return { kind: "write", leadId: form.leadId };
  // No Lead ID.
  if (
    form.onBlock === ON_BLOCK.UPSELL ||
    form.onBlock === ON_BLOCK.RELOAD ||
    form.onBlock === ON_BLOCK.SELF_GEN
  ) {
    return { kind: "create", reason: `no lead id, on-block=${form.onBlock}` };
  }
  if (form.onBlock === ON_BLOCK.YES) {
    return { kind: "queue", reason: "on-block=Yes but no Lead ID" };
  }
  return { kind: "queue", reason: "no Lead ID and no on-block channel" };
}

// ── Rule 7: one lead at a time (release-on-report) ───────────────────────────
export type DayItem = {
  id: string;
  reps: string[]; // normalized rep names in people6
  statusLabel: string | null; // Iss column label (status)
  timeMs: number | null; // appointment time (date9), LA wall-minutes
  // Disposition column labels (status_1/_2/_3/4/9). Absent on legacy callers →
  // treated as all-blank, so an Iss item with no disposition reads as open.
  pm?: string | null;
  rs?: string | null;
  ol?: string | null;
  bo?: string | null;
  sale?: string | null;
};
export type ReleasePlan = { action: "issue"; itemId: string } | { action: "hold"; reason: string };

/** Is a day item an OPEN lead (held, unreported) per the Rule 7 open-lead rule? */
function dayItemIsOpen(it: DayItem): boolean {
  return isOpenLead({
    iss: it.statusLabel,
    pm: it.pm ?? null,
    rs: it.rs ?? null,
    ol: it.ol ?? null,
    bo: it.bo ?? null,
    sale: it.sale ?? null,
  });
}

/** Normalize a rep name for matching (lowercase, collapse whitespace). */
export function normName(n: string | null | undefined): string {
  return (n ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * After a report is processed, decide the rep's NEXT lead to issue (Rule 7):
 * the earliest Not-Issued item on today's block that still has the rep, with a
 * time after the reported lead. "At the door" releases nothing. A paired next
 * lead waits until BOTH reps hold no OTHER open lead. Excluded statuses
 * (Office Appt / CTC / Reload / Add Rep) are never auto-issued.
 *
 * Crucially, "holds another lead" means an OPEN lead (Iss with no disposition),
 * not merely one still labelled Iss — a dispositioned lead keeps its Iss label,
 * so the old `statusLabel === Iss` test made the rep (or partner) look busy
 * forever and nothing ever released. The just-reported lead is always excluded.
 */
export function planRelease(input: {
  atTheDoor: boolean;
  rep: string | null;
  dayItems: DayItem[];
  reportedLeadTimeMs: number | null;
  reportedLeadId?: string | null;
}): ReleasePlan {
  if (input.atTheDoor) return { action: "hold", reason: "at the door — rep still waiting" };
  const rep = normName(input.rep);
  if (!rep) return { action: "hold", reason: "no rep to release to" };
  const after = input.reportedLeadTimeMs;
  const reportedId = input.reportedLeadId ?? null;

  const candidates = input.dayItems
    .filter((it) => it.id !== reportedId)
    .filter((it) => (it.statusLabel ?? "").trim() === LABEL.notIssued)
    .filter((it) => it.reps.map(normName).includes(rep))
    .filter((it) => after == null || it.timeMs == null || it.timeMs > after)
    .sort((a, b) => (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity));

  const next = candidates[0];
  if (!next) return { action: "hold", reason: "no next Not-Issued lead for this rep today" };

  // Pairs: release only when every rep on the next lead holds no OTHER OPEN
  // lead right now (the just-reported lead excluded). A dispositioned lead
  // keeps Iss but is no longer open, so it no longer blocks.
  const otherRepsBusy = next.reps
    .map(normName)
    .some((r) =>
      input.dayItems.some(
        (it) =>
          it.id !== next.id &&
          it.id !== reportedId &&
          dayItemIsOpen(it) &&
          it.reps.map(normName).includes(r),
      ),
    );
  if (otherRepsBusy) {
    return {
      action: "hold",
      reason: "paired next lead waits — a partner still holds an open lead",
    };
  }
  return { action: "issue", itemId: next.id };
}

// "Late report = no lead": nothing is auto-issued without a report. This flag
// exists so the rule is explicit and test-covered — the dispatcher NEVER
// pushes a held lead to a rep on its own.
export const AUTO_ISSUE_WITHOUT_REPORT = false;

/**
 * 45 minutes before a held lead's appointment, with the rep's report still
 * missing, the lead stays Not Issued and the office is alerted (Rule 7).
 * Returns whether to alert now and the lead stays held either way.
 */
export function lateReportCheck(input: {
  reportMissing: boolean;
  apptTimeMs: number | null;
  nowMs: number;
  leadStatusLabel: string | null;
}): { alert: boolean; keepHeld: boolean } {
  const held = input.leadStatusLabel === LABEL.notIssued;
  if (!input.reportMissing || input.apptTimeMs == null) return { alert: false, keepHeld: held };
  const within45 =
    input.apptTimeMs - input.nowMs <= 45 * 60 * 1000 &&
    input.apptTimeMs - input.nowMs > -24 * 60 * 60 * 1000;
  return { alert: within45, keepHeld: true };
}

// ── Admin-queue / error row (shared so rep + lead detail survive everywhere) ─
/** The common queue-row fields for a submission — rep, partner, result, lead,
 *  the Details line, the plan and the raw form. Used for EVERY queue/error row
 *  (incl. the catch-all error path) so a row is never just a bare form id. */
export function buildBaseQueueRow(
  form: OohForm,
  detailsLine: string,
  plan: WritePlan,
): Record<string, unknown> {
  return {
    rep_name: form.repName,
    partner: form.partner,
    result: form.result,
    on_block: form.onBlock,
    lead_id: form.leadId,
    details_line: detailsLine,
    plan: plan as unknown,
    raw: form as unknown,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 7 follow-up rules (owner brief 2026-10-06). All pure; the edge fn wires
// them to Monday/Supabase; the verify script asserts each one.
// ═════════════════════════════════════════════════════════════════════════════

// ── Matching fallback: customer LAST NAME + rep on today's group ─────────────
const firstTok = (n: string | null | undefined): string => normName(n).split(" ")[0] ?? "";

/** Last name token of a customer name (≥2 chars; null when there isn't one). */
export function lastNameOf(name: string | null | undefined): string | null {
  const toks = normName(name)
    .replace(/(\s*\(copy(\s+\d+)?\))+\s*$/i, "")
    .split(" ")
    .filter(Boolean);
  const last = toks[toks.length - 1] ?? "";
  return last.length >= 2 ? last : null;
}

export type NameRepMatch =
  { kind: "match"; itemId: string } | { kind: "none" } | { kind: "ambiguous"; count: number };

/**
 * On-block report with NO Lead ID: find today's block item by customer last
 * name + rep (owner rule). A match needs the item name to contain the
 * customer's last name AND the item's Reps to include the submitting rep (or
 * their partner), matched by first name (attendance-roster style). Anything but
 * exactly ONE hit is not confident → the caller queues Needs review and writes
 * nothing.
 */
export function matchByLastNameAndRep(input: {
  customerName: string | null;
  repName: string | null;
  partner: string | null;
  items: Array<{ itemId: string; name: string; reps: string[] }>;
}): NameRepMatch {
  const last = lastNameOf(input.customerName);
  const repFirsts = [firstTok(input.repName), firstTok(input.partner)].filter(Boolean);
  if (!last || repFirsts.length === 0) return { kind: "none" };
  const hits = input.items.filter(
    (it) =>
      normName(it.name).includes(last) && it.reps.some((r) => repFirsts.includes(firstTok(r))),
  );
  if (hits.length === 1) return { kind: "match", itemId: hits[0].itemId };
  return hits.length === 0 ? { kind: "none" } : { kind: "ambiguous", count: hits.length };
}

/** Same-customer check for the off-block dedupe ("unless the same customer is
 *  already there"). True when one normalized name contains the other. */
export function sameCustomer(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normName(a).replace(/(\s*\(copy(\s+\d+)?\))+\s*$/i, "");
  const nb = normName(b).replace(/(\s*\(copy(\s+\d+)?\))+\s*$/i, "");
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

// ── Payment details parsed from the rep's free text (Sold follow-up) ─────────
/** The Sales Processing board (4155553389) — the ONE destination board the Sold
 *  follow-up may write to, because the SAME item moves there after Sold. */
export const SALESPROC_BOARD_ID = "4155553389";
export const SALESPROC_COL = {
  deposit: "numbers5", // "Deposit Amt"
  finance: "dropdown6", // "Finance" (balance method)
  advantage: "color_mkwkmx6g", // "Advantage+" (Advantage+ / Non Member)
  reloads: "dup__of_product9", // "Reloads"
} as const;

/** The exact Finance dropdown labels (read live 2026-10-06) + the free-text
 *  cues reps write for each ("balance 20k service / 10249 on synchrony"). */
const FINANCE_CUES: Array<{ label: string; re: RegExp }> = [
  { label: "Renew", re: /\brenew\b/i },
  { label: "Synchrony", re: /\bsynchrony\b/i },
  { label: "Homerun", re: /\bhome\s*run\b/i },
  { label: "Service Finance", re: /\bservice(\s*finance)?\b/i },
  { label: "Momnt", re: /\bmomn?t\b/i },
  { label: "Debit Card", re: /\bdebit\b/i },
  { label: "Credit Card", re: /\bcredit\b/i },
  { label: "Check", re: /\bcheck\b/i },
  { label: "Cash", re: /\bcash\b/i },
];

export type PaymentDetails = {
  /** Deposit amount in dollars (never invented — null when not stated). */
  depositAmount: number | null;
  /** How the deposit was taken ("debit", "check"…) — missing-check only. */
  depositMethod: string | null;
  /** Finance (balance-method) dropdown labels found in the text. */
  financeLabels: string[];
  /** Advantage+ membership, when the rep said so. */
  advantage: (typeof ADVANTAGE_LABEL)[keyof typeof ADVANTAGE_LABEL] | null;
};

/** "250" → 250, "2,500" → 2500, "20k" → 20000. */
function moneyToNumber(raw: string): number | null {
  const m = raw
    .replace(/[$,]/g, "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)(k)?$/i);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse deposit / balance-method / Advantage+ from the rep's free text (notes +
 * quantities), the way the office reads Jorge's shorthand: "250 debit" =
 * $250 deposit by debit; "deposit $500 check" likewise; "balance … synchrony"
 * names the finance method. Never invents a number (owner rule) — anything not
 * stated comes back null/empty and lands on the missing-items manager text.
 */
export function parsePaymentDetails(textIn: string | null | undefined): PaymentDetails {
  const t = (textIn ?? "").trim();
  const out: PaymentDetails = {
    depositAmount: null,
    depositMethod: null,
    financeLabels: [],
    advantage: null,
  };
  if (!t) return out;

  // Advantage+ — "non member" first (it must not read as a membership).
  if (/\bnon[-\s]?member\b/i.test(t)) out.advantage = ADVANTAGE_LABEL.nonMember;
  else if (/\badvantage\s*\+?|\bmember(ship)?\b/i.test(t)) out.advantage = ADVANTAGE_LABEL.member;

  // Deposit: "<amount> <method>" ("250 debit", "$2,500 check") or
  // "deposit <amount>" / "<amount> deposit" / "<amount> down".
  const amtMethod = t.match(
    /\$?([\d][\d,]*(?:\.\d+)?k?)\s*(?:on\s+)?(debit|credit|check|cash|zelle|venmo)\b/i,
  );
  const depWord = t.match(
    /(?:deposit|down)[:\s]*\$?([\d][\d,]*(?:\.\d+)?k?)|\$?([\d][\d,]*(?:\.\d+)?k?)\s*(?:deposit|down)\b/i,
  );
  if (amtMethod) {
    out.depositAmount = moneyToNumber(amtMethod[1]);
    out.depositMethod = amtMethod[2].toLowerCase();
  } else if (depWord) {
    out.depositAmount = moneyToNumber(depWord[1] ?? depWord[2] ?? "");
  }

  // Finance (balance method): every cue found AFTER the word "balance" when the
  // rep used it, else any cue that isn't just the deposit-method token again.
  const balanceIdx = t.toLowerCase().indexOf("balance");
  const scope = balanceIdx >= 0 ? t.slice(balanceIdx) : t;
  for (const { label, re } of FINANCE_CUES) {
    if (!re.test(scope)) continue;
    // Without a "balance" anchor, don't recount the deposit method as finance.
    if (balanceIdx < 0 && out.depositMethod && label.toLowerCase().startsWith(out.depositMethod)) {
      continue;
    }
    if (!out.financeLabels.includes(label)) out.financeLabels.push(label);
  }
  return out;
}

/** Items the Sold follow-up still needs from the office (one manager text). */
export function soldFollowupMissing(form: OohForm, pay: PaymentDetails): string[] {
  const missing: string[] = [];
  if (pay.depositAmount == null) missing.push("deposit amount");
  if (!pay.depositMethod) missing.push("deposit method");
  if (pay.financeLabels.length === 0) missing.push("balance method");
  if (!dropName(form.dropCall)) missing.push("drop call");
  if (!pay.advantage) missing.push("Advantage+");
  return missing;
}

/** The one missing-items text ("iMessage managers once"). */
export function buildSalesProcMissingText(customer: string | null, missing: string[]): string {
  const who = customer?.trim() || "the new sale";
  return `Sales Processing – ${who}: missing ${missing.join(", ")}. Please add to the board or reply here.`;
}

// ── Every Sold: Reloads = add-ons beyond the main product + future reloads ───
/**
 * The Reloads (dropdown2) labels for a Sold: every QUOTED product beyond the
 * lead's main product(s) (e.g. gutters sold with a roof lead), plus any future
 * reload the rep promised in the notes ("will reload gutters"). Never "Room"
 * (owner rule — "Room" isn't in RELOAD_DROPDOWN_LABELS, so it can't map).
 */
export function addOnReloadLabels(input: {
  quoted: string | null | undefined;
  /** The block card's own Products (normalized text) — the main product(s). */
  blockProducts: string[];
  notes: string | null | undefined;
}): string[] {
  const main = new Set(input.blockProducts.map((p) => norm(p)));
  const addOns = reloadDropdownLabels(input.quoted).filter((l) => !main.has(norm(l)));
  // Future reloads: a notes line containing "reload" names products directly.
  const notes = (input.notes ?? "").trim();
  if (/\breload\w*\b/i.test(notes)) {
    const nn = norm(notes);
    for (const l of RELOAD_DROPDOWN_LABELS) {
      if (nn.includes(norm(l)) && !main.has(norm(l)) && !addOns.includes(l)) addOns.push(l);
    }
  }
  return RELOAD_DROPDOWN_LABELS.filter((l) => addOns.includes(l));
}

// ── Off-block add (upsell / reload / self-gen) ────────────────────────────────
/** Block Products (dropdown) labels, mapped from the form's "What did you
 *  quote?" answers. Most specific first (Flat Roof before Roof, Solar R/R
 *  before Solar); an unmapped answer is dropped — never invented. */
const PRODUCTS_LABEL_MAP: Array<{ re: RegExp; label: string }> = [
  { re: /flat\s*roof/i, label: "Flat Roof" },
  { re: /solar\s*r\s*(&|\/)?\s*r/i, label: "Solar R/R" },
  { re: /paint|stucco|coolwall/i, label: "Stucco/Paint" },
  { re: /trim|eaves|fascia/i, label: "Eaves/Fascia" },
  { re: /retaining/i, label: "Retaining Wall" },
  { re: /patio/i, label: "Patio Cover" },
  { re: /hvac/i, label: "HVAC" },
  { re: /window/i, label: "Windows" },
  { re: /gutter/i, label: "Gutters" },
  { re: /insulation/i, label: "Insulation" },
  { re: /paver/i, label: "Pavers" },
  { re: /turf/i, label: "Turf" },
  { re: /concrete/i, label: "Concrete" },
  { re: /fence/i, label: "Fence" },
  { re: /roof/i, label: "Roof" },
  { re: /solar/i, label: "Solar" },
];

/** Map the quoted-products text onto the block Products dropdown labels. */
export function productsDropdownLabels(quoted: string | null | undefined): string[] {
  if (!quoted) return [];
  const out: string[] = [];
  for (const part of quoted.split(/[,;]/)) {
    const p = part.trim();
    if (!p || /^other$/i.test(p)) continue;
    const hit = PRODUCTS_LABEL_MAP.find((m) => m.re.test(p));
    if (hit && !out.includes(hit.label)) out.push(hit.label);
  }
  return out;
}

/** The form's on-block answer → the block Source text for an off-block add. */
export function offBlockSourceText(onBlock: number | null): string | null {
  if (onBlock === ON_BLOCK.UPSELL) return "Upsell";
  if (onBlock === ON_BLOCK.RELOAD) return "Reload";
  if (onBlock === ON_BLOCK.SELF_GEN) return "Self Gen";
  return null;
}

/**
 * Build the create_item payload for an off-block report (owner rule: ADD it to
 * today's block in the rep's office). Status is set IN the create call — index
 * 1 "Reload" for upsell/reload, 103 "Iss" for self-gen — so no lead text fires.
 * Source Code = 1 (per-office column). The customer address goes into Comments
 * (the Location column needs lat/lng Monday never geocodes for the API).
 */
export function buildOffBlockCreate(input: {
  form: OohForm;
  customerName: string;
  submitMs: number;
  office: "SD" | "OC";
  repUserIds: string[];
}): { name: string; columnValues: Record<string, MondayValue> } | null {
  const source = offBlockSourceText(input.form.onBlock);
  if (!source) return null;
  const iso = new Date(input.submitMs).toISOString(); // Monday stores dates in UTC
  const statusIndex =
    input.form.onBlock === ON_BLOCK.SELF_GEN ? ISS_CREATE_INDEX.iss : ISS_CREATE_INDEX.reload;
  const columnValues: Record<string, MondayValue> = {
    [BLOCK_COL.iss]: { index: statusIndex },
    [BLOCK_COL.source]: source,
    [BLOCK_COL.apptDateTime]: { date: iso.slice(0, 10), time: iso.slice(11, 19) },
    [SOURCE_CODE_COL[input.office]]: "1",
  };
  if (input.form.phone) {
    columnValues[BLOCK_COL.phone] = { phone: input.form.phone, countryShortName: "US" };
  }
  if (input.repUserIds.length > 0) {
    columnValues[BLOCK_COL.reps] = {
      personsAndTeams: input.repUserIds.map((id) => ({ id: Number(id), kind: "person" })),
    };
  }
  const products = productsDropdownLabels(input.form.quotedText);
  if (products.length > 0) columnValues[BLOCK_COL.products] = { labels: products };
  if (input.form.address) columnValues[BLOCK_COL.comments] = { text: input.form.address };
  return { name: input.customerName, columnValues };
}

/** Manager text for an off-block add:
 *  "Off-block Sold: Jaxon Heilman – Smith – $12,000 (Upsell). Added to today's block." */
export function buildOffBlockText(form: OohForm, customer: string | null): string {
  const rep = form.repName ?? "rep";
  const who = customer?.trim() || form.address || "customer";
  const price = form.salePrice != null ? ` – $${form.salePrice.toLocaleString("en-US")}` : "";
  const type = offBlockSourceText(form.onBlock) ?? "off-block";
  return `Off-block ${resultPrefix(form)}: ${rep} – ${who}${price} (${type}). Added to today's block.`;
}

// ── Can-saves: Details only, press NO button ─────────────────────────────────
/** Is this block item an Office-Appt can-save? (status = Office Appt AND the
 *  card's free text carries the can/save marker.) The outcome lives in Details
 *  + the WCC flow — the write-back presses NO disposition button on these. */
export function isCanSaveOfficeAppt(input: {
  issLabel: string | null;
  freeText: string | null;
}): boolean {
  if ((input.issLabel ?? "").trim().toLowerCase() !== LABEL.officeAppt.toLowerCase()) return false;
  return /\bcan\s*\/?\s*save\b/i.test(input.freeText ?? "");
}

/** The can-save Details line: "Can-save – no save. <notes> (time)". */
export function buildCanSaveDetails(form: OohForm, submitMs: number): string {
  const saved = form.result === RESULT.SOLD;
  const head = saved ? "Can-save – SAVED" : "Can-save – no save";
  const bits: string[] = [head];
  if (saved && form.salePrice != null) bits.push(`Sale $${form.salePrice.toLocaleString("en-US")}`);
  if (form.objection) bits.push(`Obj: ${form.objection}`);
  if (form.notes) bits.push(form.notes);
  return `${bits.join(". ")} (${laClock(submitMs)})`;
}

// ── Rule: idempotency ────────────────────────────────────────────────────────
/** A form item already processed must never be pressed again. (The durable
 *  guard is the ooh_processed_reports unique row; this mirrors it for tests.) */
export function isDuplicate(processed: Iterable<string>, formItemId: string): boolean {
  for (const id of processed) if (id === formItemId) return true;
  return false;
}

/**
 * What to do with a report whose block item ALREADY has a disposition (owner
 * 10/6, "Paired reps"): when WE wrote that disposition, this is the partner's
 * copy of the same appointment — mark it Processed as a duplicate, write
 * nothing. When a HUMAN pressed it, the office reviews. Pure; index.ts feeds
 * it the ooh_processed_reports lookup.
 */
export function secondReportOutcome(input: {
  alreadyDispositioned: boolean;
  writtenByUs: boolean;
}): "proceed" | "duplicate" | "needs_review" {
  if (!input.alreadyDispositioned) return "proceed";
  return input.writtenByUs ? "duplicate" : "needs_review";
}
