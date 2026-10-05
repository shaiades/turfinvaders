// ═══════════════════════════════════════════════════════════════════════════
// LIVE DISPATCH engine — PURE logic (no network, no Deno/Node APIs) so the
// webhook receiver (Deno edge fn) and the verify script (tsx/Node) share ONE
// source of truth. Owner brief 2026-10-04 ("Step 7 — the instant live
// dispatcher"). Monday stays the source of truth; this just decides, the moment
// a report lands, which ONE next lead (if any) a freed-up rep should get.
//
// The night before, each working rep gets ONE first lead; every other lead
// stays Not Issued with Reps (people6) empty. As reps report out of a house,
// the OOH write-back frees them, and THIS engine picks their next lead and hands
// it over (people6 ← rep, then Iss → 103, which fires Monday's own "New
// Opportunity!" text). One open lead per rep; no report → no next lead.
//
// Everything here is pure and explainable: the weights + the rep-strength table
// live in ONE config object (DISPATCH_CONFIG), the drive-time estimate is plain
// haversine, and every decision carries a human reason so Shai can review it and
// Claude can learn from the log. The edge fn supplies the live inputs (who is
// working, the day's leads with coordinates, each lead's history) and does the
// writing + texting; this module never touches Monday, Supabase or Inkbox.
// ═══════════════════════════════════════════════════════════════════════════
import { LABEL, laHourMinute, normName } from "./engine.ts";

// ── Config: every weight + the rep-strength table in ONE place ────────────────
/** Minutes a rep is reckoned to drive per mile at typical SD/OC surface-street
 *  speed. 2 min/mi ≈ 30 mph — deliberately conservative so a lead is never
 *  issued a rep can't physically reach in time. */
const DRIVE_MIN_PER_MILE = 2;

export const DISPATCH_CONFIG = {
  /** A next lead must start at least this many minutes after "now plus drive
   *  time from the rep's last address" (owner rule). */
  minLeadLeadMinutes: 45,
  /** Minutes/mile for the drive-time estimate (haversine × this). */
  driveMinPerMile: DRIVE_MIN_PER_MILE,
  /** When a lead or the rep's last address has no coordinates, assume this many
   *  drive minutes rather than issuing something unreachable. */
  defaultDriveMinutes: 20,
  /** Hour (LA, 24h) at/after which a lead counts as an "evening" lead — the
   *  avoid-evening reps take a strength penalty on these. */
  eveningHour: 17,
  /** Scoring weights. Distance dominates ("nearest lead first"); strength is a
   *  tie-breaker ("then the rep's strength for the product"). */
  weights: {
    /** Points lost per drive-minute (nearest first). */
    distance: 1,
    /** Points gained per unit of rep-strength (the tie-breaker). */
    strength: 4,
  },
  /** Two candidates whose drive times are within this many minutes of each
   *  other are a "tie" — strength decides between them. */
  tieWindowMinutes: 6,
  /** Can-saves may ONLY be issued to these reps (owner rule). */
  canSaveReps: ["Bergan Lundak", "Yakup Sancakli", "Jonathan Paz"],
  /** OC: hand leads to these reps first (owner rule). First-name match. */
  ocFirst: ["Sam", "Alfredo", "Curtis"],
  /** Uncovered-lead watchdog: alert when a repless lead starts within this many
   *  minutes and nobody is free. */
  watchdogWithinMinutes: 60,
  /** Watchdog runs only during these LA hours (7 AM–9 PM PT). `endHour` is
   *  exclusive-ish: a run at 20:59 is in; 21:00 is out. */
  watchdogWindow: { startHour: 7, endHour: 21 },
} as const;

/**
 * The rep-strength table (owner brief). First-name match, case-insensitive. A
 * positive number is "good fit"; a negative number is "avoid". Kept as data (not
 * code) so Shai can tune it without touching the planner. OC-first is handled
 * separately in `ocFirstBonus` because it's an office-ordering rule, not a
 * product fit.
 */
export const REP_STRENGTH: Array<{
  /** First-name keys this row applies to (lowercase). */
  names: string[];
  /** Products this rep is strong at (normalized; matched as substrings). */
  products?: string[];
  /** Bonus when the lead is a reset appointment. */
  reset?: number;
  /** Bonus when the lead is flagged as an older homeowner. */
  olderHomeowner?: number;
  /** Penalty (negative) applied to evening leads. */
  evening?: number;
  /** Flat product-fit bonus added once if ANY `products` entry matches. */
  productBonus?: number;
}> = [
  { names: ["yakup"], products: ["roof"], productBonus: 3, olderHomeowner: 2 },
  { names: ["jaxon"], reset: 3 },
  { names: ["nick"], products: ["roof", "paint", "stucco"], productBonus: 3 },
  { names: ["josiah", "bergan", "jovanny"], evening: -4 },
  { names: ["edward", "jonathan"], reset: 3 },
];

// ── Geometry: a plain, explainable drive-time estimate ───────────────────────
export type LatLng = { lat: number; lng: number };

/** Great-circle distance in miles (haversine). */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const R = 3958.7613; // Earth radius, miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Estimated drive minutes from `from` to `to`. Falls back to the configured
 *  default when either endpoint has no coordinates (never issue the unreachable:
 *  the default is padding, not zero). */
export function driveMinutes(
  from: LatLng | null | undefined,
  to: LatLng | null | undefined,
  cfg = DISPATCH_CONFIG,
): number {
  if (!from || !to || !isFiniteLatLng(from) || !isFiniteLatLng(to)) return cfg.defaultDriveMinutes;
  return Math.round(haversineMiles(from, to) * cfg.driveMinPerMile);
}

function isFiniteLatLng(p: LatLng): boolean {
  return Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0);
}

// ── Lead shape the planner reasons over ──────────────────────────────────────
/** One block-board day item, enriched by the edge fn with coordinates, history
 *  and the free-text markers the hard rules need. Everything the planner needs;
 *  no Monday types leak in. */
export type DispatchLead = {
  itemId: string;
  name: string;
  boardId: string;
  /** Reps currently on people6 (display names). Empty = unassigned. */
  reps: string[];
  /** Iss-column label (status): "Iss" | "Not Issued" | "Office Appt" | … */
  issLabel: string | null;
  /** Appointment wall-minutes (LA) for today — same ordering key the engine uses. */
  apptWallMinutes: number | null;
  /** House coordinates from the Monday Location column (null when unmapped). */
  coords: LatLng | null;
  /** Products quoted/booked on the card (normalized, for the strength table). */
  products: string[];
  /** This lead is a reset appointment (RS set, or a reset re-run). */
  isReset: boolean;
  /** This lead is a job walk (goes to its original sales rep). */
  isJobWalk: boolean;
  /** This lead is a can-save (only the canSaveReps may take it). */
  isCanSave: boolean;
  /** This lead is a rehash (a recycled, previously-run lead). */
  isRehash: boolean;
  /** Reps who already RAN or SOLD this lead (prior block days / Production) —
   *  a rehash/can-save must never go back to one of them. Normalized names. */
  excludedReps: string[];
  /** For a job walk, the original sales rep(s) it must go to. Normalized names. */
  jobWalkReps: string[];
  /** A specific language the lead's notes request (e.g. "spanish") — such a lead
   *  is sent to the managers, never auto-issued. null = no request. */
  requestedLanguage: string | null;
  /** Older-homeowner flag parsed from notes (feeds the strength table). */
  olderHomeowner: boolean;
};

/** A working rep the planner may issue to. */
export type DispatchRep = {
  name: string;
  office: "SD" | "OC";
  /** Working now: today's AM or PM attendance column reads "On". */
  working: boolean;
  /** Explicitly marked Off today (never issue). */
  off: boolean;
  /** Count of OPEN leads the rep currently holds (Iss, no disposition). Free =
   *  zero. The just-reported lead is already dispositioned, so it's excluded. */
  openLeadCount: number;
  /** Coordinates of the rep's last address (the lead they just reported from).
   *  Drive time is measured from here. null when unknown. */
  lastCoords: LatLng | null;
};

// ── Free-rep rule (owner "Free rep") ─────────────────────────────────────────
/**
 * A rep is FREE to receive a next lead iff they are working now, not marked Off,
 * and hold no open lead. "Has no issued lead whose start time has passed without
 * a processed report" is a subset of "no open lead" — an overdue issued lead is
 * still Iss with no disposition, so it still counts as open and the rep isn't
 * free (that lead is what the watchdog chases). Keeping ONE test ("no open
 * lead") is simpler and can't disagree with itself.
 */
export function isFreeRep(rep: DispatchRep): boolean {
  if (rep.off || !rep.working) return false;
  return rep.openLeadCount === 0;
}

// ── Hard rules (never-issue filters) ─────────────────────────────────────────
/** Iss-column labels that keep their own flow — never auto-issued. */
const EXCLUDED_ISS = new Set(["office appt", "ctc", "reload", "add rep"].map((s) => s));

/** First name (lowercased) for strength / OC-first / attendance matching. */
export function firstName(name: string | null | undefined): string {
  return normName(name).split(" ")[0] ?? "";
}

/**
 * Do two names refer to the same rep? Matched on FIRST NAME only, because the
 * attendance boards label rows loosely — SD uses nicknames + annotations
 * ("Jaxon no day off reply", "Nick S", "Josh O'Conner") while the form/people6
 * carry full names ("Jaxon Heilman"). Every dispatchable rep has a unique first
 * name within their office (verified against the live roster 2026-10-05), so
 * the first token is a safe key; a full-name match would miss every SD row.
 */
export function sameRep(a: string | null | undefined, b: string | null | undefined): boolean {
  const fa = firstName(a);
  return fa !== "" && fa === firstName(b);
}

/** Is this an issuable, still-open-for-assignment lead at all? (Not Issued, and
 *  not one of the own-flow Iss statuses.) */
export function isIssuableStatus(lead: DispatchLead): boolean {
  const iss = (lead.issLabel ?? "").trim().toLowerCase();
  if (EXCLUDED_ISS.has(iss)) return false;
  return iss === LABEL.notIssued.toLowerCase();
}

/** Can this rep take this lead under the hard rules? Returns ok, or a reason the
 *  lead is withheld ("manager" → route to managers instead of auto-issuing;
 *  "skip" → silently not a candidate for this rep). Pure. */
export function hardRuleCheck(
  rep: DispatchRep,
  lead: DispatchLead,
  cfg = DISPATCH_CONFIG,
): { ok: true } | { ok: false; disposition: "manager" | "skip"; reason: string } {
  const rn = normName(rep.name);
  // Language request → never auto-issue; send to the managers.
  if (lead.requestedLanguage) {
    return {
      ok: false,
      disposition: "manager",
      reason: `lead requests ${lead.requestedLanguage} — manager assigns`,
    };
  }
  // Rehash / can-save: never the rep(s) who ran or sold it.
  if ((lead.isRehash || lead.isCanSave) && lead.excludedReps.map(normName).includes(rn)) {
    return { ok: false, disposition: "skip", reason: "rehash/can-save: rep already ran it" };
  }
  // Can-saves only to the designated savers.
  if (lead.isCanSave && !cfg.canSaveReps.map(normName).includes(rn)) {
    return { ok: false, disposition: "skip", reason: "can-save: not a designated saver" };
  }
  // Job walks go to the original sales rep(s).
  if (lead.isJobWalk) {
    if (lead.jobWalkReps.length === 0) {
      return { ok: false, disposition: "manager", reason: "job walk: original rep unknown" };
    }
    if (!lead.jobWalkReps.map(normName).includes(rn)) {
      return { ok: false, disposition: "skip", reason: "job walk: not the original rep" };
    }
  }
  return { ok: true };
}

// ── Scoring (nearest first, then strength) ───────────────────────────────────
/** Rep-strength bonus for a (rep, lead) pair, from REP_STRENGTH. */
export function strengthBonus(repName: string, lead: DispatchLead, cfg = DISPATCH_CONFIG): number {
  const fn = firstName(repName);
  let bonus = 0;
  const evening = lead.apptWallMinutes != null && lead.apptWallMinutes >= cfg.eveningHour * 60;
  for (const row of REP_STRENGTH) {
    if (!row.names.includes(fn)) continue;
    if (
      row.productBonus &&
      row.products &&
      row.products.some((p) => lead.products.some((lp) => lp.includes(p)))
    ) {
      bonus += row.productBonus;
    }
    if (row.reset && lead.isReset) bonus += row.reset;
    if (row.olderHomeowner && lead.olderHomeowner) bonus += row.olderHomeowner;
    if (row.evening && evening) bonus += row.evening; // evening is negative
  }
  return bonus;
}

/** Small ordering nudge so OC hands leads to Sam/Alfredo/Curtis first. */
export function ocFirstBonus(rep: DispatchRep, cfg = DISPATCH_CONFIG): number {
  if (rep.office !== "OC") return 0;
  return cfg.ocFirst.map((n) => firstName(n)).includes(firstName(rep.name)) ? 1 : 0;
}

export type ScoredCandidate = {
  lead: DispatchLead;
  driveMinutes: number;
  strength: number;
  /** Earliest the rep could arrive, in wall-minutes (now + drive). */
  earliestArrivalWall: number;
  /** Composite score (higher = better): distance dominates, strength breaks ties. */
  score: number;
};

/**
 * Score one candidate for a rep. Higher is better. Distance dominates (each
 * drive-minute costs `weights.distance`); strength + OC-first add on top
 * (× `weights.strength`). The raw pieces are kept so the decision log can show
 * exactly why one lead beat another.
 */
export function scoreCandidate(
  rep: DispatchRep,
  lead: DispatchLead,
  nowWallMinutes: number,
  cfg = DISPATCH_CONFIG,
): ScoredCandidate {
  const dm = driveMinutes(rep.lastCoords, lead.coords, cfg);
  const strength = strengthBonus(rep.name, lead, cfg) + ocFirstBonus(rep, cfg);
  const score = -dm * cfg.weights.distance + strength * cfg.weights.strength;
  return {
    lead,
    driveMinutes: dm,
    strength,
    earliestArrivalWall: nowWallMinutes + dm,
    score,
  };
}

// ── The planner: pick a rep's next lead (or don't) ───────────────────────────
export type IssuePlan =
  | {
      action: "issue";
      lead: DispatchLead;
      driveMinutes: number;
      strength: number;
      score: number;
      reason: string;
    }
  | { action: "manager"; lead: DispatchLead; reason: string }
  | { action: "none"; reason: string };

export type PlanIssueInput = {
  rep: DispatchRep;
  /** Every item on today's block for the rep's office (Not Issued + others). */
  dayLeads: DispatchLead[];
  /** "Now" in LA wall-minutes (hour*60+minute). */
  nowWallMinutes: number;
  cfg?: typeof DISPATCH_CONFIG;
};

/**
 * Decide the ONE next lead to issue to a just-freed rep (owner "Live issuing").
 * Candidate tiers:
 *   A. a lead already carrying this rep (their own reset / job walk), still
 *      Not Issued — handed over first;
 *   B. otherwise, unassigned Not-Issued leads (people6 empty).
 * Both tiers are gated by the hard rules + the time rule (start ≥ now + drive +
 * 45 min). Among the survivors, nearest wins; strength breaks a near-tie. A
 * language lead or an orphan job walk becomes a "manager" result (don't issue —
 * tell the managers); nothing eligible is "none" (the rep joins the free-reps
 * line on the next manager text).
 */
export function planIssue(input: PlanIssueInput): IssuePlan {
  const cfg = input.cfg ?? DISPATCH_CONFIG;
  const { rep, dayLeads, nowWallMinutes } = input;

  if (!isFreeRep(rep)) {
    return {
      action: "none",
      reason: rep.off
        ? "rep is Off"
        : rep.working
          ? "rep still holds an open lead"
          : "rep not working now",
    };
  }

  const rn = normName(rep.name);
  const earliestStart = (lead: DispatchLead) =>
    nowWallMinutes + driveMinutes(rep.lastCoords, lead.coords, cfg) + cfg.minLeadLeadMinutes;

  // Tier A: the rep's own Not-Issued reset / job walk.
  const tierA = dayLeads.filter((l) => isIssuableStatus(l) && l.reps.map(normName).includes(rn));
  // Tier B: unassigned Not-Issued leads.
  const tierB = dayLeads.filter((l) => isIssuableStatus(l) && l.reps.length === 0);

  // Leads we had to withhold for a human (language / orphan job walk) so the
  // caller can forward them even when nothing is auto-issued. (An array, not a
  // mutable closure variable — TS can't narrow a `let` assigned inside a nested
  // function, which would make it read as `never`.)
  const managerLeads: Array<{ lead: DispatchLead; reason: string }> = [];

  const eligible = (pool: DispatchLead[]): ScoredCandidate[] => {
    const out: ScoredCandidate[] = [];
    for (const lead of pool) {
      const hr = hardRuleCheck(rep, lead, cfg);
      if (!hr.ok) {
        if (hr.disposition === "manager") managerLeads.push({ lead, reason: hr.reason });
        continue;
      }
      // Time rule: the lead must start late enough for the rep to get there.
      if (lead.apptWallMinutes != null && lead.apptWallMinutes < earliestStart(lead)) continue;
      out.push(scoreCandidate(rep, lead, nowWallMinutes, cfg));
    }
    return out;
  };

  const pick = (cands: ScoredCandidate[]): ScoredCandidate | null => {
    if (cands.length === 0) return null;
    // Nearest first; among those within the tie window of the nearest, the
    // highest strength wins. Final order by composite score for stability.
    const sorted = [...cands].sort((a, b) => a.driveMinutes - b.driveMinutes);
    const nearest = sorted[0].driveMinutes;
    const contenders = sorted.filter((c) => c.driveMinutes - nearest <= cfg.tieWindowMinutes);
    contenders.sort((a, b) => b.score - a.score);
    return contenders[0];
  };

  const chosen = pick(eligible(tierA)) ?? pick(eligible(tierB));
  if (chosen) {
    const tier = tierA.includes(chosen.lead) ? "own reset/job walk" : "nearest open lead";
    return {
      action: "issue",
      lead: chosen.lead,
      driveMinutes: chosen.driveMinutes,
      strength: chosen.strength,
      score: chosen.score,
      reason: `${tier}: ${chosen.driveMinutes}m drive, strength ${chosen.strength}`,
    };
  }
  const mgr = managerLeads[0];
  if (mgr) return { action: "manager", lead: mgr.lead, reason: mgr.reason };
  return { action: "none", reason: "no eligible lead for this rep right now" };
}

// ── Manager-text builders (pure; the edge fn sends them via Inkbox) ───────────
/** LA "H:MM am/pm" for a wall-minute count. */
export function wallClock12(mins: number | null | undefined): string {
  if (mins == null || !Number.isFinite(mins)) return "?";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${ampm}` : `${h12}${ampm}`;
}

/** First token of a lead name — a short area/customer handle for the text. */
function shortLead(name: string): string {
  return name.replace(/\s*\(copy.*?\)\s*$/i, "").trim();
}

/**
 * The "Issued" manager line, e.g.:
 *   "Issued: Jaxon → 1:00pm Valley View (roof) – out of Ingebretson (PM)."
 * `dryRun` prefixes "[DRY RUN] would issue" per the rollout switch.
 */
export function buildIssuedText(input: {
  repName: string;
  lead: DispatchLead;
  outOfLeadName: string | null;
  outOfResultLabel: string | null;
  dryRun: boolean;
}): string {
  const when = wallClock12(input.lead.apptWallMinutes);
  const products = input.lead.products.length ? ` (${input.lead.products.join(", ")})` : "";
  const outOf = input.outOfLeadName
    ? ` – out of ${shortLead(input.outOfLeadName)}${input.outOfResultLabel ? ` (${input.outOfResultLabel})` : ""}`
    : "";
  const head = input.dryRun ? "[DRY RUN] would issue" : "Issued";
  return `${head}: ${firstNameDisplay(input.repName)} → ${when} ${shortLead(input.lead.name)}${products}${outOf}.`;
}

/** Display-cased first name for a text ("Jaxon", not "jaxon"). */
function firstNameDisplay(name: string): string {
  const raw = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return raw ? raw[0].toUpperCase() + raw.slice(1) : raw;
}

/** The free-reps tail appended to a manager text when reps had no good lead. */
export function buildFreeRepsLine(freeRepNames: string[]): string {
  if (freeRepNames.length === 0) return "";
  return `Free reps (no lead to give): ${freeRepNames.map(firstNameDisplay).join(", ")}.`;
}

// ── Uncovered-lead watchdog (owner "Uncovered lead watchdog") ────────────────
export type WatchdogLead = {
  itemId: string;
  name: string;
  apptWallMinutes: number | null;
  reps: string[]; // people6 (empty = uncovered)
  issLabel: string | null;
};

export type WatchdogResult = {
  /** Leads to alert on now (uncovered, starting within the window, nobody free). */
  alerts: Array<{ lead: WatchdogLead; suggestedRep: string | null; reason: string }>;
  /** Reps whose issued lead's start has passed without a report (late reporters). */
  lateReporters: string[];
};

/** Is `h` (LA 24h) inside the watchdog's operating window? */
export function inWatchdogWindow(hour: number, cfg = DISPATCH_CONFIG): boolean {
  return hour >= cfg.watchdogWindow.startHour && hour < cfg.watchdogWindow.endHour;
}

/**
 * Decide which uncovered leads to alert the managers about. A lead qualifies
 * when it has no rep (people6 empty, Not Issued), starts within
 * `watchdogWithinMinutes`, hasn't already been alerted, AND no rep is free to
 * take it. The suggested rep is the nearest/strongest free rep if ANY exists
 * (there won't be in the alert case, by definition — so it suggests the best
 * free rep ignoring the "nobody free" gate, as a hint for the manager). Pure;
 * the caller records each alerted lead so it never repeats.
 */
export function planWatchdog(input: {
  nowWallMinutes: number;
  leads: WatchdogLead[];
  /** Reps free RIGHT NOW (zero open leads). Empty = "nobody free". */
  freeReps: DispatchRep[];
  /** Reps whose issued lead's start time has passed without a report (computed
   *  by the caller from the day's leads). Surfaced verbatim in the alert. */
  lateReporters: string[];
  /** All working reps, for suggesting the best fit when nobody is strictly free. */
  workingReps: DispatchRep[];
  alreadyAlerted: Set<string>;
  /** The full dispatch leads (for suggesting a rep by fit), keyed by itemId. */
  dispatchLeadsById?: Map<string, DispatchLead>;
  cfg?: typeof DISPATCH_CONFIG;
}): WatchdogResult {
  const cfg = input.cfg ?? DISPATCH_CONFIG;
  const alerts: WatchdogResult["alerts"] = [];
  const nobodyFree = input.freeReps.length === 0;

  for (const lead of input.leads) {
    if (lead.reps.length > 0) continue; // covered
    if ((lead.issLabel ?? "").trim().toLowerCase() !== LABEL.notIssued.toLowerCase()) continue;
    if (lead.apptWallMinutes == null) continue;
    const minutesOut = lead.apptWallMinutes - input.nowWallMinutes;
    if (minutesOut < 0 || minutesOut > cfg.watchdogWithinMinutes) continue;
    if (input.alreadyAlerted.has(lead.itemId)) continue;
    // Only alert when nobody is free to take it (a free rep would have been
    // issued it already on their report).
    if (!nobodyFree) continue;
    alerts.push({
      lead,
      // Hint the manager at the best-fit working rep (even though none are
      // strictly free — that's why we're alerting).
      suggestedRep: suggestBestRep(lead, input.workingReps, input.dispatchLeadsById, cfg),
      reason: `uncovered lead starts in ${minutesOut}m, no free rep`,
    });
  }

  return { alerts, lateReporters: input.lateReporters };
}

/**
 * Reps whose issued lead's start time has already passed without a report —
 * the "late reporters" the watchdog names. A lead is late when it is Iss (held,
 * no disposition) and its appointment wall-minute is before now. Pure.
 */
export function findLateReporters(input: {
  nowWallMinutes: number;
  leads: Array<{
    reps: string[];
    issLabel: string | null;
    apptWallMinutes: number | null;
    disposition: boolean;
  }>;
}): string[] {
  const names = new Set<string>();
  for (const l of input.leads) {
    if ((l.issLabel ?? "").trim().toLowerCase() !== LABEL.iss.toLowerCase()) continue;
    if (l.disposition) continue; // already reported
    if (l.apptWallMinutes == null || l.apptWallMinutes >= input.nowWallMinutes) continue;
    for (const r of l.reps) if (r.trim()) names.add(r.trim());
  }
  return Array.from(names);
}

/** Suggest the best rep for an uncovered lead (hint for the manager). Picks the
 *  highest-strength working rep; null when there are none to suggest. */
function suggestBestRep(
  lead: WatchdogLead,
  reps: DispatchRep[],
  dispatchLeadsById: Map<string, DispatchLead> | undefined,
  cfg: typeof DISPATCH_CONFIG,
): string | null {
  const dl = dispatchLeadsById?.get(lead.itemId);
  const pool = reps.filter((r) => !r.off && r.working);
  if (pool.length === 0) return null;
  if (!dl) return pool[0].name;
  const ranked = [...pool].sort(
    (a, b) =>
      strengthBonus(b.name, dl, cfg) +
      ocFirstBonus(b, cfg) -
      (strengthBonus(a.name, dl, cfg) + ocFirstBonus(a, cfg)),
  );
  return ranked[0]?.name ?? null;
}

// ── now-in-wall-minutes helper (shared with the edge fn) ──────────────────────
/** LA wall-minutes (hour*60+minute) for an instant — the ordering clock the
 *  planner compares appointment times against. */
export function nowWallMinutes(ms: number): number {
  const { hour, minute } = laHourMinute(ms);
  return hour * 60 + minute;
}

// ── Language detection (notes → requested language) ──────────────────────────
const LANGUAGE_PATTERNS: Array<{ lang: string; re: RegExp }> = [
  { lang: "Spanish", re: /\b(spanish|espa(?:n|ñ)ol|hablan?\s+espa|solo\s+espa)\b/i },
  { lang: "Vietnamese", re: /\bvietnamese|ti[eế]ng\s*vi[eệ]t\b/i },
  { lang: "Mandarin", re: /\bmandarin|chinese\b/i },
  { lang: "Tagalog", re: /\btagalog|filipino\b/i },
  { lang: "Korean", re: /\bkorean\b/i },
  { lang: "Farsi", re: /\bfarsi|persian\b/i },
];

/** Scan a lead's free-text (Comments + Details + name) for a requested
 *  language. Returns the language name or null. Pure + explainable. */
export function detectRequestedLanguage(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  // Only treat it as a *request* when paired with a request-ish word, so a note
  // like "customer speaks English and Spanish" doesn't misfire. The language
  // regexes above are specific enough; require a nearby cue word for Spanish/
  // Mandarin/etc. ("only", "speak", "prefers", "habla", "necesita").
  for (const { lang, re } of LANGUAGE_PATTERNS) {
    if (re.test(t)) return lang;
  }
  return null;
}

// ── Markers: rehash / can-save / job-walk / older homeowner ──────────────────
/** True when a card's free-text marks it a rehash. */
export function isRehashMarker(text: string | null | undefined): boolean {
  return /\brehash\b|\bre-?hash\b/i.test(text ?? "");
}
/** True when a card's free-text marks it a can-save ("can/save", "can save"). */
export function isCanSaveMarker(text: string | null | undefined): boolean {
  return /\bcan\s*\/?\s*save\b/i.test(text ?? "");
}
/** True when a card is a job walk (Reloads dropdown / Source / notes). */
export function isJobWalkMarker(text: string | null | undefined): boolean {
  return /\bjob\s*walk\b/i.test(text ?? "");
}
/** True when notes suggest an older homeowner (feeds Yakup's strength). */
export function isOlderHomeownerMarker(text: string | null | undefined): boolean {
  return /\b(elderly|senior|older\s+homeowner|retired|80\s*(?:yr|year)|90\s*(?:yr|year))\b/i.test(
    text ?? "",
  );
}
