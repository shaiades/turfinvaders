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

// ── Block columns (boards 18432844990 / 18432845324, identical) ──────────────
export const BLOCK_COL = {
  name: "name",
  reps: "people6", // max 2 (pairs)
  source: "text", // "Source" — drives Rule 4
  office: "color_mm2yd84r", // 0 Orange County | 1 San Diego
  apptDateTime: "date9", // "Date/Time" — Rule 3 arrival fallback
  details: "long_text3",
  salePrice: "numbers",
  resetDate: "date", // date + time
  reloads: "dropdown2",
  sourceCode: "numeric_mm35kwnj",
  // disposition status columns
  iss: "status", // Add Rep|Reload|CTC|Not Issued|Office Appt|Iss
  bo: "status4", // No Show|No show text|No Demo|None
  ol: "status_3", // OL|None
  rs: "status_2", // Reset|None
  pm: "status_1", // PM|PM w/ RS|None
  sale: "status9", // Sold|Upsell|Reload
} as const;

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
} as const;

/** Block Iss-column labels that keep their OWN flow — never auto-released. */
export const RELEASE_EXCLUDED_STATUSES = ["Office Appt", "CTC", "Reload", "Add Rep"] as const;

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
  const quoted = form.quantities || form.quotedText;
  const head = quoted ? `${resultPrefix(form)} – ${quoted}` : resultPrefix(form);
  parts.push(head);

  // Pricing (Sold / PM branches).
  if (form.highPrice != null || form.lowPrice != null) {
    const hi = form.highPrice != null ? `High $${form.highPrice.toLocaleString("en-US")}` : null;
    const lo = form.lowPrice != null ? `Low $${form.lowPrice.toLocaleString("en-US")}` : null;
    parts.push([hi, lo].filter(Boolean).join(" / "));
  }
  if (form.result === RESULT.SOLD && form.salePrice != null) {
    parts.push(`Sale $${form.salePrice.toLocaleString("en-US")}`);
  }

  // Objection (PM branch).
  if (form.objection) {
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

function fmtReset(r: { date: string; time: string | null }): string {
  const [y, m, d] = r.date.split("-").map(Number);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()
  ];
  const t = r.time ? ` ${fmtTime(r.time)}` : "";
  return `${wd} ${m}/${d}${t}`;
}
function fmtTime(t: string): string {
  const [hh, mm] = t.split(":").map(Number);
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

  switch (form.result) {
    case RESULT.SOLD: {
      if (form.salePrice != null) fieldWrites[BLOCK_COL.salePrice] = String(form.salePrice);
      if (form.onBlock === ON_BLOCK.UPSELL) {
        return {
          fieldWrites,
          status: { col: BLOCK_COL.sale, label: LABEL.upsell },
          fillSourceCodeIfBlank: false,
          atTheDoor: false,
        };
      }
      if (form.onBlock === ON_BLOCK.RELOAD) {
        fieldWrites[BLOCK_COL.reloads] = { labels: ["Room"] };
        return {
          fieldWrites,
          status: { col: BLOCK_COL.sale, label: LABEL.saleReload },
          fillSourceCodeIfBlank: false,
          atTheDoor: false,
        };
      }
      // On-block Yes (0) or self-gen/own (2): a Sold that must reach Sales
      // Processing — fill a blank Source Code (Rule 4).
      return {
        fieldWrites,
        status: { col: BLOCK_COL.sale, label: LABEL.sold },
        fillSourceCodeIfBlank: true,
        atTheDoor: false,
      };
    }
    case RESULT.PITCH_MISS:
      return {
        fieldWrites,
        status: { col: BLOCK_COL.pm, label: LABEL.pm },
        fillSourceCodeIfBlank: false,
        atTheDoor: false,
      };
    case RESULT.PM_WITH_RESET:
      if (resetDateValue) fieldWrites[BLOCK_COL.resetDate] = resetDateValue;
      return {
        fieldWrites,
        status: { col: BLOCK_COL.pm, label: LABEL.pmReset },
        fillSourceCodeIfBlank: false,
        atTheDoor: false,
      };
    case RESULT.RESET:
      if (resetDateValue) fieldWrites[BLOCK_COL.resetDate] = resetDateValue;
      return {
        fieldWrites,
        status: { col: BLOCK_COL.rs, label: LABEL.reset },
        fillSourceCodeIfBlank: false,
        atTheDoor: false,
      };
    case RESULT.ONE_LEGGER:
      // Reset-call done (0) → Reset to Confirmed; no reset (1) → OL to Blowout.
      if (form.resetCall === 0) {
        if (resetDateValue) fieldWrites[BLOCK_COL.resetDate] = resetDateValue;
        return {
          fieldWrites,
          status: { col: BLOCK_COL.rs, label: LABEL.reset },
          fillSourceCodeIfBlank: false,
          atTheDoor: false,
        };
      }
      return {
        fieldWrites,
        status: { col: BLOCK_COL.ol, label: LABEL.ol },
        fillSourceCodeIfBlank: false,
        atTheDoor: false,
      };
    case RESULT.NO_DEMO:
      return {
        fieldWrites,
        status: { col: BLOCK_COL.bo, label: LABEL.noDemo },
        fillSourceCodeIfBlank: false,
        atTheDoor: false,
      };
    case RESULT.NO_SHOW_FINAL:
      return {
        fieldWrites,
        status: { col: BLOCK_COL.bo, label: LABEL.noShow },
        fillSourceCodeIfBlank: false,
        atTheDoor: false,
      };
    case RESULT.AT_THE_DOOR:
      // Rule 6: press "No show text" (the office automation texts the customer),
      // append a Details note, message the office — and release nothing.
      return {
        fieldWrites,
        status: { col: BLOCK_COL.bo, label: LABEL.noShowText },
        fillSourceCodeIfBlank: false,
        atTheDoor: true,
      };
    default:
      return { fieldWrites, status: null, fillSourceCodeIfBlank: false, atTheDoor: false };
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
  statusLabel: string | null; // Iss column label
  timeMs: number | null; // appointment time (date9)
};
export type ReleasePlan = { action: "issue"; itemId: string } | { action: "hold"; reason: string };

/** Normalize a rep name for matching (lowercase, collapse whitespace). */
export function normName(n: string | null | undefined): string {
  return (n ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * After a report is processed, decide the rep's NEXT lead to issue (Rule 7):
 * the earliest Not-Issued item on today's block that still has the rep, with a
 * time after the reported lead. "At the door" releases nothing. A paired next
 * lead waits until BOTH reps hold no other Iss lead. Excluded statuses
 * (Office Appt / CTC / Reload / Add Rep) are never auto-issued.
 */
export function planRelease(input: {
  atTheDoor: boolean;
  rep: string | null;
  dayItems: DayItem[];
  reportedLeadTimeMs: number | null;
}): ReleasePlan {
  if (input.atTheDoor) return { action: "hold", reason: "at the door — rep still waiting" };
  const rep = normName(input.rep);
  if (!rep) return { action: "hold", reason: "no rep to release to" };
  const after = input.reportedLeadTimeMs;

  const candidates = input.dayItems
    .filter((it) => it.statusLabel === LABEL.notIssued)
    .filter((it) => !RELEASE_EXCLUDED_STATUSES.includes(it.statusLabel as never))
    .filter((it) => it.reps.map(normName).includes(rep))
    .filter((it) => after == null || it.timeMs == null || it.timeMs > after)
    .sort((a, b) => (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity));

  const next = candidates[0];
  if (!next) return { action: "hold", reason: "no next Not-Issued lead for this rep today" };

  // Pairs: release only when every rep on the next lead holds no OTHER open
  // Iss lead right now. A partner with an unreported Iss lead → wait.
  const otherRepsBusy = next.reps
    .map(normName)
    .some((r) =>
      input.dayItems.some(
        (it) =>
          it.id !== next.id && it.statusLabel === LABEL.iss && it.reps.map(normName).includes(r),
      ),
    );
  if (otherRepsBusy) {
    return {
      action: "hold",
      reason: "paired next lead waits — a partner still holds an issued lead",
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

// ── Rule: idempotency ────────────────────────────────────────────────────────
/** A form item already processed must never be pressed again. (The durable
 *  guard is the ooh_processed_reports unique row; this mirrors it for tests.) */
export function isDuplicate(processed: Iterable<string>, formItemId: string): boolean {
  for (const id of processed) if (id === formItemId) return true;
  return false;
}
