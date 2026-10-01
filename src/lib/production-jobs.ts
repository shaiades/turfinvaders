// Production-board rules (owner directive 2026-10-01, Weekly Action Plan):
// pure helpers for mirroring the Monday "Production" board into
// public.production_jobs and classifying homeowner temperature from the
// board's item updates. Pure constants-only module — no supabase, no Monday —
// so scripts/verify-action-plan.ts can exercise every rule.
//
// Doctrine carried over from the other mirrors: blank money = $0, never
// guessed; columns read by ID first, title second; raw rep names are board
// truth (no FK to profiles — the client resolves "me" with buildRepMatcher).
// The homeowner classifier runs at SYNC TIME ONLY: reps read the stored
// status, so the rep card and the PM alert can never disagree.

import { parseDateText, parseMoney } from "@/lib/collections";
import { laDateISO } from "@/lib/dates";

/** Board + group ids verified live 2026-10-01 (board "Production",
 *  workspace "Project Center"). Nothing else in the repo references them. */
export const PRODUCTION_BOARD_ID = "4300880129";

export const PRODUCTION_GROUPS = {
  queueToStart: "new_group82551",
  inProgress: "new_group4457",
  delayed: "new_group62654",
  completed: "new_group79215",
} as const;

export const SCOPE_GROUP_IDS: readonly string[] = [
  PRODUCTION_GROUPS.queueToStart,
  PRODUCTION_GROUPS.inProgress,
  PRODUCTION_GROUPS.delayed,
  PRODUCTION_GROUPS.completed,
];

/** Column ids verified live on the board 2026-10-01. Title fallback guards
 *  against a hand-recreated column drifting ids (collections doctrine).
 *  NOTE: `people` is the PRODUCTION MANAGER column; the reps live on
 *  `people5` ("Reps"). Advantage+ title carries a space: "Advantage +". */
export const PRODUCTION_COLUMNS = {
  reps: { id: "people5", title: "reps" },
  pm: { id: "people", title: "production" },
  schedule: { id: "timeline", title: "schedule" },
  projects: { id: "dropdown", title: "projects" },
  reloads: { id: "dropdown4", title: "reloads" },
  reloaded: { id: "dup__of_reloads", title: "reloaded" },
  advantage: { id: "color_mkwkb083", title: "advantage +" },
  address: { id: "location", title: "address" },
  saleAmount: { id: "numbers", title: "sale amount" },
  completionDate: { id: "date6", title: "completion date" },
  delayedUntil: { id: "date8", title: "delayed until" },
  status: { id: "status", title: "status" },
  office: { id: "color_mm2y57c9", title: "office" },
  reviews: { id: "status_107", title: "reviews" },
  referral: { id: "color_mkwxe85r", title: "referral status" },
  zip: { id: "text_mktn1p1k", title: "zip code" },
} as const;

/** One public.production_jobs row (also the sync's upsert payload — emits
 *  EVERY column so chunked upserts never null-clobber a missing key). */
export type ProductionJobRow = {
  monday_item_id: string;
  board_id: string;
  group_id: string;
  group_title: string;
  homeowner_name: string | null;
  reps: string[];
  rep_monday_ids: number[];
  pm_name: string | null;
  pm_monday_ids: number[];
  projects: string | null;
  reloads: string | null;
  reloaded: string | null;
  advantage_plus: boolean;
  address: string | null;
  lat: number | null;
  lng: number | null;
  geo_source: string | null;
  zip: string | null;
  sale_amount: number;
  schedule_start: string | null;
  schedule_end: string | null;
  prev_schedule_start: string | null;
  prev_schedule_end: string | null;
  completion_date: string | null;
  delayed_until: string | null;
  status_label: string | null;
  office_location: string | null;
  reviews_status: string | null;
  referral_status: string | null;
  homeowner_status: HomeownerStatus;
  homeowner_status_reason: string | null;
  homeowner_status_note_date: string | null;
};

/** Monday column cell with the fragments the sync's item query requests. */
export type ProductionCell = {
  id: string;
  text: string | null;
  column?: { title?: string | null; id?: string | null } | null;
  /** TimelineValue */
  from?: string | null;
  to?: string | null;
  /** LocationValue */
  lat?: number | string | null;
  lng?: number | string | null;
  /** PeopleValue */
  persons_and_teams?: Array<{ id: string | number; kind?: string | null }> | null;
};

export type ProductionItem = {
  id: unknown;
  name?: unknown;
  group?: { id?: unknown; title?: unknown } | null;
  column_values?: ProductionCell[] | null;
};

type ColumnSpec = { id: string; title: string };

const findCell = (cols: ProductionCell[], spec: ColumnSpec): ProductionCell | undefined =>
  cols.find((c) => c.id === spec.id) ??
  cols.find((c) => (c.column?.title || "").trim().toLowerCase() === spec.title);

const cellText = (cols: ProductionCell[], spec: ColumnSpec): string | null => {
  const t = (findCell(cols, spec)?.text || "").trim();
  return t === "" ? null : t;
};

/** Comma-joined Monday people/dropdown text → clean deduped list. */
export function splitNames(text: string | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(",")) {
    const name = raw.trim().replace(/\s+/g, " ");
    const key = name.toLowerCase();
    if (name !== "" && !seen.has(key)) {
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

const personIds = (cell: ProductionCell | undefined): number[] =>
  (cell?.persons_and_teams ?? [])
    .filter((p) => (p.kind ?? "person") === "person")
    .map((p) => Number(p.id))
    .filter((n) => Number.isFinite(n) && n > 0);

const cellCoord = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  // 0/0 is the Gulf of Guinea, not a San Diego roof — treat as missing.
  return Number.isFinite(n) && n !== 0 ? n : null;
};

/** Last 5-digit run in the address ("…, San Diego, CA 92126, USA" → 92126). */
export function zipFromAddress(address: string | null): string | null {
  if (!address) return null;
  const matches = address.match(/\b\d{5}\b/g);
  return matches ? matches[matches.length - 1] : null;
}

/** Monday Production item → production_jobs row. homeowner_status fields
 *  default to neutral here; the sync overwrites them from the classifier
 *  (or preserves the previous row's values when the notes fetch failed).
 *  prev_schedule_* and geo backfill are merged by the sync as well. */
export function buildProductionJobRow(item: ProductionItem, boardId: string): ProductionJobRow {
  const cols = item.column_values ?? [];
  const scheduleCell = findCell(cols, PRODUCTION_COLUMNS.schedule);
  const addressCell = findCell(cols, PRODUCTION_COLUMNS.address);
  const repsCell = findCell(cols, PRODUCTION_COLUMNS.reps);
  const pmCell = findCell(cols, PRODUCTION_COLUMNS.pm);
  const name = item.name == null ? "" : String(item.name).trim();
  const address = cellText(cols, PRODUCTION_COLUMNS.address);
  const advantage = (cellText(cols, PRODUCTION_COLUMNS.advantage) ?? "").toLowerCase();
  const lat = cellCoord(addressCell?.lat);
  const lng = cellCoord(addressCell?.lng);
  return {
    monday_item_id: String(item.id),
    board_id: boardId,
    group_id: item.group?.id == null ? "" : String(item.group.id),
    group_title: item.group?.title == null ? "" : String(item.group.title),
    homeowner_name: name === "" ? null : name,
    reps: splitNames(repsCell?.text ?? null),
    rep_monday_ids: personIds(repsCell),
    pm_name: cellText(cols, PRODUCTION_COLUMNS.pm),
    pm_monday_ids: personIds(pmCell),
    projects: cellText(cols, PRODUCTION_COLUMNS.projects),
    reloads: cellText(cols, PRODUCTION_COLUMNS.reloads),
    reloaded: cellText(cols, PRODUCTION_COLUMNS.reloaded),
    advantage_plus: advantage.includes("advantage"),
    address,
    lat,
    lng,
    geo_source: lat !== null && lng !== null ? "monday" : null,
    zip: cellText(cols, PRODUCTION_COLUMNS.zip) ?? zipFromAddress(address),
    sale_amount: parseMoney(cellText(cols, PRODUCTION_COLUMNS.saleAmount)) ?? 0,
    schedule_start: parseDateText(scheduleCell?.from ?? null),
    schedule_end: parseDateText(scheduleCell?.to ?? null),
    prev_schedule_start: null,
    prev_schedule_end: null,
    completion_date: parseDateText(cellText(cols, PRODUCTION_COLUMNS.completionDate)),
    delayed_until: parseDateText(cellText(cols, PRODUCTION_COLUMNS.delayedUntil)),
    status_label: cellText(cols, PRODUCTION_COLUMNS.status),
    office_location: cellText(cols, PRODUCTION_COLUMNS.office),
    reviews_status: cellText(cols, PRODUCTION_COLUMNS.reviews),
    referral_status: cellText(cols, PRODUCTION_COLUMNS.referral),
    homeowner_status: "neutral",
    homeowner_status_reason: null,
    homeowner_status_note_date: null,
  };
}

// ── Homeowner temperature classifier (keyword heuristic, user decision
//    2026-10-01 — no LLM). False-positive-hardened: negation window, strong-
//    signal-or-threshold gate for at_risk, automation authors skipped, a
//    clear newer positive resets older negatives. ──────────────────────────

export type HomeownerStatus = "happy" | "neutral" | "at_risk";

export type NoteEntry = {
  body: string;
  /** ISO instant (Monday update created_at). */
  created_at: string;
  creator: string | null;
};

export type HomeownerClassification = {
  status: HomeownerStatus;
  /** Category labels, e.g. "Notes mention: refusal, cost dispute". */
  reason: string | null;
  /** YYYY-MM-DD of the newest note that decided the status. */
  noteDate: string | null;
};

type Signal = { label: string; re: RegExp };

/** One hit = at_risk (no threshold needed) — unambiguous escalation terms. */
const STRONG_AT_RISK: Signal[] = [
  { label: "legal threat", re: /\b(attorney|lawyer|lawsuit|legal action|small claims)\b/ },
  { label: "BBB complaint", re: /\bbbb\b/ },
  { label: "refund demand", re: /\b(refund|chargeback|money back)\b/ },
  {
    label: "cancellation threat",
    re: /\b(cancel(?:l?ing|l?ed)? (?:the )?(?:job|contract|project)|wants? to cancel|threat)/,
  },
  { label: "payment refusal", re: /\b(will not|won'?t|refus\w+ to) (?:be )?pay/ },
  { label: "stop work", re: /\bstop(?:ped)? (?:the )?work\b/ },
  // Production escalating to the principals is the house's own at-risk tell
  // ("Going to have Tyler call today").
  { label: "owner escalation", re: /\bhave (?:tyler|shai) call\b/ },
  { label: "flat refusal", re: /\b(?:will not|won'?t)(?: be| being)* doing (?:this|that|it)\b/ },
];

/** Each category counts once per note toward the at_risk threshold. */
const NEGATIVE: Signal[] = [
  { label: "refusal", re: /\b(refus\w+|will not be doing|won'?t be doing|not going to do)\b/ },
  { label: "upset homeowner", re: /\b(upset|angry|furious|irate|mad at)\b/ },
  { label: "frustration", re: /\b(frustrat\w+|unhappy|not happy|disappoint\w+|fed up)\b/ },
  { label: "complaint", re: /\b(complain\w*|escalat\w+|demanding|dispute)\b/ },
  {
    label: "crew problem",
    re: /\b(crew (?:was |is )?late|no.?show|didn'?t show|left a mess|damage[sd]?\b|broke\b)/,
  },
  { label: "cost dispute", re: /\b(have to pay|has to pay|pay for the|extra cost|charge[sd]? (?:him|her|them))\b/ },
];

// "thanked/thankful" only — bare "thanks"/"thank you" is the routine update
// sign-off between staff, and it must never read as homeowner sentiment
// (review 2026-10-01: a sign-off was resetting real at-risk episodes).
const POSITIVE: Signal[] = [
  { label: "happy homeowner", re: /\b(happy|thrilled|excited|pleased|grateful|loves?d?\b)/ },
  { label: "praise", re: /\b(great job|looks great|looks amazing|thanked|thankful|awesome)\b/ },
  { label: "review", re: /\b(5 ?star|five star|left (?:a|us a) review|google review (?:left|posted|received))\b/ },
];

/** A clear newer all-good resets older negatives entirely. */
const RESET: Signal[] = [
  { label: "resolved", re: /\b(resolved|all good|happy now|smoothed over|no complaints|sorted out)\b/ },
];

const AUTOMATION_AUTHOR = /\b(automation|integration|workbot|monday)\b/i;

const NEGATION = /\b(no|not|never|without|isn'?t|wasn'?t|don'?t|doesn'?t|didn'?t)$/;

/** True when the match at `index` sits within 3 tokens after a negation
 *  ("no complaints", "not upset", "didn't complain"). Clause punctuation
 *  breaks the window — "didn't pay, says lawyer is involved" is NOT a
 *  negated lawyer (review 2026-10-01). */
function isNegated(body: string, index: number): boolean {
  const before = body.slice(0, index).trimEnd();
  const clause = before.split(/[.,;:!?]/).pop() ?? "";
  const tail = clause.split(/\s+/).slice(-3);
  return tail.some((t) => NEGATION.test(t.replace(/[^a-z']/g, "")));
}

/** Normalize a note body for matching: lowercase + straight apostrophes
 *  (iOS smart punctuation types ’, which would dodge every n't pattern). */
export function normalizeNoteBody(body: string): string {
  return body.toLowerCase().replace(/[‘’]/g, "'");
}

function hits(body: string, signals: Signal[]): string[] {
  const out: string[] = [];
  for (const s of signals) {
    // Every occurrence: the first hit may sit in a negated clause while a
    // later one is real ("no damage to the roof; HO says damage to fence").
    const re = new RegExp(s.re.source, s.re.flags.includes("g") ? s.re.flags : `${s.re.flags}g`);
    for (const m of body.matchAll(re)) {
      if (!isNegated(body, m.index ?? 0)) {
        out.push(s.label);
        break;
      }
    }
  }
  return out;
}

const dayDiff = (aISO: string, bISO: string): number => {
  const d = (s: string) => Date.parse(`${s}T12:00:00Z`);
  return Math.round((d(aISO) - d(bISO)) / 86_400_000);
};

export const NOTES_WINDOW_DAYS = 14;
export const NOTES_RECENT_DAYS = 7;
export const NOTES_MAX = 15;

/** LA calendar date of a Monday created_at instant (a note typed after
 *  5 PM PT carries tomorrow's UTC date — slicing the instant would make the
 *  Sunday 6 PM sync drop that evening's notes). */
export function noteDateLA(createdAt: string): string | null {
  const ms = Date.parse(createdAt);
  return Number.isNaN(ms) ? null : laDateISO(new Date(ms));
}

/**
 * Classify homeowner temperature from the notes digest.
 * - Only notes within NOTES_WINDOW_DAYS of `todayISO` (LA dates); newest
 *   wins ties.
 * - Notes ≤ NOTES_RECENT_DAYS old weigh ×2 (spec: weight recent notes more).
 * - at_risk: one strong signal, or negative hits across ≥2 notes with a
 *   weighted negative score ≥ positive + 2.
 * - A RESET note ("resolved", "happy now"…) erases everything older than it
 *   — an explicit closure only; a routine positive never wipes a strong
 *   signal (review 2026-10-01).
 * - happy: weighted positive ≥ 2 with no negative in the window.
 */
export function classifyHomeownerNotes(
  notes: NoteEntry[],
  todayISO: string,
): HomeownerClassification {
  const windowed = notes
    .filter((n) => {
      const d = noteDateLA(n.created_at);
      if (d === null) return false;
      const diff = dayDiff(todayISO, d);
      return diff <= NOTES_WINDOW_DAYS && diff >= 0;
    })
    .filter((n) => !AUTOMATION_AUTHOR.test(n.creator ?? ""))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, NOTES_MAX);

  let negScore = 0;
  let posScore = 0;
  let negNotes = 0;
  let strong: { label: string; date: string } | null = null;
  const negLabels: string[] = [];
  let posDate: string | null = null;
  let newestDate: string | null = null;
  let resetSeen = false;

  // Newest → oldest: a RESET note stops accumulation from everything older
  // than it ("resolved" closes the episode, strong signals included).
  for (const n of windowed) {
    const body = normalizeNoteBody(n.body);
    const date = noteDateLA(n.created_at) as string;
    newestDate = newestDate ?? date;
    const weight = dayDiff(todayISO, date) <= NOTES_RECENT_DAYS ? 2 : 1;

    const posHits = hits(body, POSITIVE);
    const resetHits = hits(body, RESET);
    if (posHits.length > 0) {
      posScore += weight * posHits.length;
      posDate = posDate ?? date;
    }
    if (resetSeen) continue;

    const strongHits = hits(body, STRONG_AT_RISK);
    if (strongHits.length > 0 && strong === null) {
      strong = { label: strongHits[0], date };
    }
    const negHits = hits(body, NEGATIVE);
    if (negHits.length > 0) {
      negScore += weight * negHits.length;
      negNotes += 1;
      for (const l of negHits) if (!negLabels.includes(l)) negLabels.push(l);
    }

    if (resetHits.length > 0) resetSeen = true;
  }

  if (strong !== null) {
    const labels = [strong.label, ...negLabels.filter((l) => l !== strong?.label)].slice(0, 3);
    return {
      status: "at_risk",
      reason: `Notes mention: ${labels.join(", ")}`,
      noteDate: strong.date,
    };
  }
  if (negNotes >= 2 && negScore >= posScore + 2) {
    return {
      status: "at_risk",
      reason: `Notes mention: ${negLabels.slice(0, 3).join(", ")}`,
      noteDate: newestDate,
    };
  }
  if (posScore >= 2 && negScore === 0) {
    return { status: "happy", reason: "Notes read positive", noteDate: posDate };
  }
  return { status: "neutral", reason: null, noteDate: newestDate };
}

// ── Override staleness (leadership corrections) ──────────────────────────

export type HomeownerOverride = {
  homeowner_status: HomeownerStatus;
  based_on_note_date: string | null;
};

export type EffectiveStatus = {
  status: HomeownerStatus;
  source: "auto" | "override" | "stale_override";
};

/** An override applies only while no production note newer than its
 *  based_on_note_date exists; a newer note reverts to the auto status and
 *  the leadership view flags the override stale. */
export function effectiveHomeownerStatus(
  job: { homeowner_status: HomeownerStatus; homeowner_status_note_date: string | null },
  override: HomeownerOverride | null | undefined,
): EffectiveStatus {
  if (!override) return { status: job.homeowner_status, source: "auto" };
  const noteDate = job.homeowner_status_note_date;
  const basis = override.based_on_note_date;
  const stale = noteDate !== null && (basis === null || noteDate > basis);
  if (stale) return { status: job.homeowner_status, source: "stale_override" };
  return { status: override.homeowner_status, source: "override" };
}
