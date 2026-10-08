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
  /** Minutes of lead time a freed rep needs BEYOND drive time to still make a
   *  lead's start (owner mandate 2026-10-08, Rule 5 — "a rep can take a lead if
   *  drive time + 10 min ≤ time until it starts"). */
  coverBufferMinutes: 10,
  /** "Cover first" horizon: leads starting within this many minutes are covered
   *  before any later lead is looked at (Rule 7 — "every lead in the next 2
   *  hours"). */
  coverWindowMinutes: 120,
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
  // ── Rule 8: pairing ─────────────────────────────────────────────────────────
  /** Reps who may run a lead SOLO ("hot" reps). First-name match. When this list
   *  is EMPTY only `neverSolo` is force-paired, so live dispatch is unchanged
   *  until the owner populates the roster from the Close Kombat / pairing
   *  analytics (via system_settings.dispatch_pairing). */
  hotReps: [] as readonly string[],
  /** Reps who must NEVER be the only rep on a lead (Rule 8 — "Daniel never goes
   *  alone"). First-name match, case-insensitive. */
  neverSolo: ["Daniel"] as readonly string[],
  /** Preferred (hot) partners per first name, from the pairing analytics — the
   *  pairing picks a free preferred partner first. */
  preferredPartners: {} as Readonly<Record<string, readonly string[]>>,
} as const;

/** The pairing roster (Rule 8) as the owner stores it in
 *  system_settings.dispatch_pairing — merged over DISPATCH_CONFIG by the edge
 *  fn so the analytics can be tuned with no code change. */
export type DispatchPairingOverride = {
  hotReps?: string[];
  neverSolo?: string[];
  preferredPartners?: Record<string, string[]>;
};

/** Merge a stored pairing roster over the defaults → a cfg the planner accepts. */
export function withPairing(
  override: DispatchPairingOverride | null | undefined,
  base: typeof DISPATCH_CONFIG = DISPATCH_CONFIG,
): typeof DISPATCH_CONFIG {
  if (!override) return base;
  return {
    ...base,
    hotReps: override.hotReps ?? base.hotReps,
    neverSolo: override.neverSolo ?? base.neverSolo,
    preferredPartners: override.preferredPartners ?? base.preferredPartners,
  };
}

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

// ── Rule 1: people6 is additive — never remove a rep ─────────────────────────
/**
 * Union the reps already on people6 with the rep(s) being issued, preserving
 * everyone already there (Rule 1 — "Never remove anyone from people6. When you
 * issue a lead, ADD the rep to whoever is already there"). De-duped, order-
 * stable (existing first). This is the fix for the Langley 3:30 regression
 * (Rule 4): Tyler had set Jaxon + Edward; writing only Jaxon erased Edward.
 */
export function mergePeople(
  existing: Array<string | number>,
  add: Array<string | number>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...existing, ...add]) {
    const s = String(id).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ── Rule 8: two reps unless the rep is hot ───────────────────────────────────
/**
 * Must this rep be PAIRED (never run a lead solo)? True when they're in
 * `neverSolo` (Daniel always), OR — once a `hotReps` roster is configured — when
 * they aren't a hot (solo-OK) rep. An EMPTY hotReps roster forces only
 * neverSolo, so live dispatch is unchanged until the owner drops the roster into
 * system_settings.dispatch_pairing from the Close Kombat / pairing analytics.
 */
export function mustPair(repName: string | null | undefined, cfg = DISPATCH_CONFIG): boolean {
  const fn = firstName(repName);
  if (!fn) return false;
  if (cfg.neverSolo.map((n) => firstName(n)).includes(fn)) return true;
  if (cfg.hotReps.length === 0) return false;
  return !cfg.hotReps.map((n) => firstName(n)).includes(fn);
}

/**
 * Pick a partner to ADD for a rep who can't go solo (Rule 8 — "meet this by
 * ADDING a second rep, never replacing one"). A free, working, same-office rep,
 * preferring a configured hot partner, then the one nearest the lead; never the
 * rep themselves, anyone already on the lead, or a rep the lead's history
 * excludes (rehash/can-save). null when none is available — the caller then
 * withholds the lead for a manager rather than sending the rep alone.
 */
export function choosePartner(input: {
  rep: DispatchRep;
  lead: DispatchLead;
  freeReps: DispatchRep[];
  cfg?: typeof DISPATCH_CONFIG;
}): DispatchRep | null {
  const cfg = input.cfg ?? DISPATCH_CONFIG;
  const repFn = firstName(input.rep.name);
  const excluded = new Set(input.lead.excludedReps.map(normName));
  const onLead = new Set(input.lead.reps.map(normName));
  const pool = input.freeReps.filter((r) => {
    if (firstName(r.name) === repFn) return false;
    if (r.office !== input.rep.office) return false;
    if (excluded.has(normName(r.name))) return false;
    if (onLead.has(normName(r.name))) return false;
    return hardRuleCheck(r, input.lead, cfg).ok;
  });
  if (pool.length === 0) return null;
  const preferred = (cfg.preferredPartners[repFn] ?? []).map((n) => firstName(n));
  const pref = pool.find((r) => preferred.includes(firstName(r.name)));
  if (pref) return pref;
  return [...pool].sort(
    (a, b) =>
      driveMinutes(a.lastCoords, input.lead.coords, cfg) -
      driveMinutes(b.lastCoords, input.lead.coords, cfg),
  )[0];
}

// ── Rule 6: send the closest rep late when nobody can cover in time ──────────
export type LateCoverPlan =
  | {
      action: "assign-late";
      lead: DispatchLead;
      rep: DispatchRep;
      driveMinutes: number;
      lateMinutes: number;
      reason: string;
    }
  | { action: "none"; reason: string };

/** The Details note added to a lead covered late (Rule 6, verbatim style). */
export function runningLateNote(lateMinutes: number): string {
  return `running ~${lateMinutes} min late, office please call customer`;
}

/**
 * Rule 6: an uncovered lead no FREE rep can reach in time — still send the
 * CLOSEST working rep. Picks the working (not-off), hard-rule-eligible rep with
 * the smallest drive to the lead and reports how many minutes late they'd
 * arrive. Returns "none" when no eligible rep exists (e.g. a language lead → a
 * manager assigns). Pure; the caller writes people6 (additively, Rule 1) + Iss
 * and texts the managers.
 */
export function planLateCoverage(input: {
  lead: DispatchLead;
  workingReps: DispatchRep[];
  nowWallMinutes: number;
  cfg?: typeof DISPATCH_CONFIG;
}): LateCoverPlan {
  const cfg = input.cfg ?? DISPATCH_CONFIG;
  const eligible = input.workingReps.filter(
    (r) => !r.off && r.working && hardRuleCheck(r, input.lead, cfg).ok,
  );
  if (eligible.length === 0) return { action: "none", reason: "no eligible rep to cover late" };
  const closest = [...eligible].sort(
    (a, b) =>
      driveMinutes(a.lastCoords, input.lead.coords, cfg) -
      driveMinutes(b.lastCoords, input.lead.coords, cfg),
  )[0];
  const dm = driveMinutes(closest.lastCoords, input.lead.coords, cfg);
  const arrival = input.nowWallMinutes + dm;
  const lateMinutes =
    input.lead.apptWallMinutes != null ? Math.max(0, arrival - input.lead.apptWallMinutes) : 0;
  return {
    action: "assign-late",
    lead: input.lead,
    rep: closest,
    driveMinutes: dm,
    lateMinutes,
    reason: `closest working rep, ~${lateMinutes}m late`,
  };
}

// ── Rule 19/20: which events may text the managers ───────────────────────────
/** The ONLY events that text the dispatcher phone (owner mandate 2026-10-07,
 *  extended by Rule 6 2026-10-08): a sale/reload/upsell, a no-show at the door,
 *  an uncovered lead within 60 min nobody can cover, the missing-sale-info nudge
 *  (folded into the sale text), and a running-late cover (Rule 6). */
export type ManagerTextTrigger =
  "sale" | "no_show_at_door" | "uncovered_within_60" | "missing_sale_info" | "running_late";
export const MANAGER_TEXT_TRIGGERS: readonly ManagerTextTrigger[] = [
  "sale",
  "no_show_at_door",
  "uncovered_within_60",
  "missing_sale_info",
  "running_late",
];
/** Events that must NEVER text — they show in the app (Needs review / decision
 *  log) instead (Rule 20). */
export type AppOnlyEvent =
  "dry_run_would_issue" | "needs_review" | "free_reps" | "routine_issue" | "routine_dispo";
/** Rule 19/20 classifier: should this event text the managers? The edge fn
 *  routes every would-be text through it so the 100/day cap is never breached. */
export function shouldTextManagers(event: ManagerTextTrigger | AppOnlyEvent): boolean {
  return (MANAGER_TEXT_TRIGGERS as readonly string[]).includes(event);
}

/**
 * Owner portal fix 2026-10-08 (#3): "Add Rep" = the lead KEEPS its current rep
 * and needs ONE MORE. A freed rep may be ADDED to people6 (union — never
 * removing anyone) and the STATUS IS NOT TOUCHED. The manager setting Add Rep
 * is itself the request, so this is the one status that invites a people6 add.
 */
export function isAddRepStatus(lead: Pick<DispatchLead, "issLabel">): boolean {
  return (lead.issLabel ?? "").trim().toLowerCase() === "add rep";
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

// ── Auto-create office inference (owner "add it to this week's block") ────────
/**
 * Which office an auto-created item belongs to. An old-block sale reuses the
 * original card's office; a no-lead-id report infers it from which office's
 * attendance lists the rep (by first name, the same loose key the dispatcher
 * matches on). null when it can't be decided confidently — both offices list
 * the rep, or neither does — so the caller routes to review instead of guessing.
 */
export function inferCreateOffice(input: {
  oldBlockOffice: "SD" | "OC" | null;
  repName: string | null;
  partner: string | null;
  sdFirstNames: ReadonlySet<string>;
  ocFirstNames: ReadonlySet<string>;
}): "SD" | "OC" | null {
  if (input.oldBlockOffice) return input.oldBlockOffice;
  const names = [input.repName, input.partner]
    .filter((n): n is string => !!n && !!n.trim())
    .map((n) => firstName(n));
  const inSD = names.some((n) => input.sdFirstNames.has(n));
  const inOC = names.some((n) => input.ocFirstNames.has(n));
  if (inSD && !inOC) return "SD";
  if (inOC && !inSD) return "OC";
  return null;
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
      /** True for an "Add Rep" lead (#3): ADD the rep to people6, do NOT touch
       *  the status. False for a normal issue (people6 add + Iss press). */
      addRep: boolean;
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
  // Rule 5: a lead is reachable iff it starts at least drive + 10 min from now.
  const earliestStart = (lead: DispatchLead) =>
    nowWallMinutes + driveMinutes(rep.lastCoords, lead.coords, cfg) + cfg.coverBufferMinutes;

  // Candidate pool: every issuable lead that either already carries this rep
  // (their own reset / job walk) OR is unassigned. Both compete on COVERAGE
  // priority (Rules 5/7/9) — the rep's own lead is only favored as a final
  // tie-break (ownBonus) when start time AND drive are otherwise equal.
  const isMine = (l: DispatchLead) => l.reps.map(normName).includes(rn);
  // Pool: Not-Issued leads (unassigned or the rep's own) PLUS "Add Rep" leads —
  // a lead that keeps its current rep and needs ONE MORE (#3); the freed rep
  // qualifies only if they aren't already on it.
  const inPool = (l: DispatchLead) =>
    (isIssuableStatus(l) && (l.reps.length === 0 || isMine(l))) ||
    (isAddRepStatus(l) && !isMine(l));

  // Leads we had to withhold for a human (language / orphan job walk) so the
  // caller can forward them even when nothing is auto-issued.
  const managerLeads: Array<{ lead: DispatchLead; reason: string }> = [];

  const eligible: Array<ScoredCandidate & { ownLead: boolean; addRep: boolean }> = [];
  for (const lead of dayLeads) {
    if (!inPool(lead)) continue;
    const hr = hardRuleCheck(rep, lead, cfg);
    if (!hr.ok) {
      if (hr.disposition === "manager") managerLeads.push({ lead, reason: hr.reason });
      continue;
    }
    // Rule 5: skip leads that start too soon for the rep to physically reach.
    if (lead.apptWallMinutes != null && lead.apptWallMinutes < earliestStart(lead)) continue;
    eligible.push({
      ...scoreCandidate(rep, lead, nowWallMinutes, cfg),
      ownLead: isMine(lead),
      addRep: isAddRepStatus(lead),
    });
  }

  // Coverage ordering (owner mandate 2026-10-08):
  //   1. Rule 7 — leads starting within the next 2h come before any later lead;
  //   2. Rule 5/9 — among those, the SOONEST-starting lead wins (this is the
  //      Yakup/Smith fix: the 2:00 uncovered lead beats the 4:00 one);
  //   3. nearest drive, then strength, then the rep's own lead as a tie-break.
  const withinWindow = (c: (typeof eligible)[number]) =>
    c.lead.apptWallMinutes != null &&
    c.lead.apptWallMinutes - nowWallMinutes <= cfg.coverWindowMinutes
      ? 0
      : 1;
  const startKey = (c: (typeof eligible)[number]) => c.lead.apptWallMinutes ?? Infinity;
  eligible.sort((a, b) => {
    const w = withinWindow(a) - withinWindow(b);
    if (w) return w;
    const s = startKey(a) - startKey(b);
    if (s) return s;
    const d = a.driveMinutes - b.driveMinutes;
    if (d) return d;
    const sc = b.score - a.score;
    if (sc) return sc;
    return (b.ownLead ? 1 : 0) - (a.ownLead ? 1 : 0);
  });

  const chosen = eligible[0];
  if (chosen) {
    const tier = chosen.addRep
      ? "add-rep second"
      : chosen.ownLead
        ? "own reset/job walk"
        : "soonest uncovered lead";
    return {
      action: "issue",
      lead: chosen.lead,
      driveMinutes: chosen.driveMinutes,
      strength: chosen.strength,
      score: chosen.score,
      reason: `${tier}: starts ${startKey(chosen)}, ${chosen.driveMinutes}m drive, strength ${chosen.strength}`,
      addRep: chosen.addRep,
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

/**
 * Owner brief Part 4: the Iss-column label to press when live issuing hands a
 * rep a lead. A job walk is the rep's OWN appointment and keeps its own flow,
 * so it's pressed "Office Appt" (never auto-released again); every other issued
 * lead is pressed "Iss" (which fires Monday's "New Opportunity!" text). Pure.
 */
export function issLabelForLead(lead: Pick<DispatchLead, "isJobWalk">): string {
  return lead.isJobWalk ? LABEL.officeAppt : LABEL.iss;
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

/**
 * Rule 6: the "running late" alert texted to the managers when the closest rep
 * was sent to an uncovered lead they can't reach on time — "office please call
 * customer". One of the allowed manager texts (shouldTextManagers). Pure.
 */
export function buildRunningLateText(input: {
  office: "SD" | "OC";
  leadName: string;
  repName: string;
  lateMinutes: number;
  apptClock: string;
}): string {
  return `🟧 Running ~${input.lateMinutes} min late (${input.office}): ${firstNameDisplay(
    input.repName,
  )} → ${shortLead(input.leadName)} at ${input.apptClock}. Office please call the customer.`;
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
 * `watchdogWithinMinutes`, hasn't already been alerted, AND no free rep can
 * reach it ON TIME (drive + 10 ≤ time until start — Rules 5/6). The caller
 * then late-covers it with the closest working rep (Rule 6) or texts the
 * managers, and records each alerted lead so it never repeats. Pure.
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

  for (const lead of input.leads) {
    if (lead.reps.length > 0) continue; // covered
    if ((lead.issLabel ?? "").trim().toLowerCase() !== LABEL.notIssued.toLowerCase()) continue;
    if (lead.apptWallMinutes == null) continue;
    const minutesOut = lead.apptWallMinutes - input.nowWallMinutes;
    if (minutesOut < 0 || minutesOut > cfg.watchdogWithinMinutes) continue;
    if (input.alreadyAlerted.has(lead.itemId)) continue;
    // Rule 6: alert (and late-cover) when no free rep can get there ON TIME —
    // drive + 10 ≤ time until start. A free rep who can still make it will be
    // issued the lead by the report flow, so no alert.
    const dl = input.dispatchLeadsById?.get(lead.itemId);
    const someFreeRepOnTime = input.freeReps.some(
      (r) =>
        input.nowWallMinutes +
          driveMinutes(r.lastCoords, dl?.coords ?? null, cfg) +
          cfg.coverBufferMinutes <=
        (lead.apptWallMinutes as number),
    );
    if (someFreeRepOnTime) continue;
    alerts.push({
      lead,
      // Hint the manager at the best-fit working rep (even though none are
      // strictly free/on-time — that's why we're alerting).
      suggestedRep: suggestBestRep(lead, input.workingReps, input.dispatchLeadsById, cfg),
      reason: `uncovered lead starts in ${minutesOut}m, no free rep can make it`,
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
