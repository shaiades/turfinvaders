// Weekly Action Plan engine (owner directive 2026-10-01). PURE — no
// supabase, no Monday, no Date.now(): every function takes its clock
// (anchorISO / planWeekStart) so scripts/verify-action-plan.ts can pin
// Sundays, DST weeks and 48-hour boundaries.
//
// Doctrine:
// - Board truth: jobs are keyed by raw Monday rep names; the caller passes
//   an isMine() from buildRepMatcher. Never a profiles FK.
// - At-risk precedence is a HARD rule: a recovery visit replaces every pin,
//   phase ask and talking point, and suppresses referral/neighbor/reload/
//   testimonial/review asks (spec §6).
// - Sunday anchors to Monday: the plan week helper hands Sunday viewers the
//   upcoming week, and `anchorISO` must be that Monday — states, scores and
//   the route never compute "from Sunday".
// - Talking points render board data only (service, schedule, notes
//   classification) — never invented project details.

import { haversineM } from "@/lib/house-cache";
import {
  PRODUCTION_GROUPS,
  effectiveHomeownerStatus,
  splitNames,
  type EffectiveStatus,
  type HomeownerOverride,
  type HomeownerStatus,
} from "@/lib/production-jobs";

/** addDaysISO twin kept local so this module stays dependency-light for the
 *  verify script (same UTC-noon DST-safe math as dates.ts). */
const addDays = (iso: string, n: number): string => {
  const [y, m, d] = iso.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  noon.setUTCDate(noon.getUTCDate() + n);
  return noon.toISOString().slice(0, 10);
};

const daysBetween = (aISO: string, bISO: string): number => {
  const d = (s: string) => Date.parse(`${s}T12:00:00Z`);
  return Math.round((d(aISO) - d(bISO)) / 86_400_000);
};

// ── Config (spec §8: "keep all weights in a config so they can be tuned").
//    A typed constant for V1; a DB singleton + owner panel can replace it
//    when a tuning UI ships. ────────────────────────────────────────────────

export const ACTION_PLAN_CONFIG = {
  preStartWindowDays: 5,
  clusterRadiusMiles: 2.5,
  clusterExtraJobBonus: 5,
  justCompletedHours: 48,
  postWindowDays: 7,
  longJobVisitsPerWeek: 3,
  weights: {
    advantagePlus: 25,
    reloadPer: 12.5,
    reloadMax: 25,
    happy: 15,
    neutral: 8,
    atRisk: 0,
    /** Sale Amount ≥ min → pts; first match wins. */
    valueTiers: [
      { min: 30_000, pts: 15 },
      { min: 10_000, pts: 10 },
      { min: 0, pts: 5 },
    ],
    daysRemainingMax: 10,
    /** Full urgency points at 0 days left, zero at ≥ horizon. */
    daysRemainingHorizon: 10,
    densityPer: 5,
    densityMax: 10,
  },
} as const;

export type ActionPlanConfig = typeof ACTION_PLAN_CONFIG;

// ── Inputs ───────────────────────────────────────────────────────────────

/** The production_jobs columns the plan reads (DB rows satisfy this). */
export type PlanJob = {
  monday_item_id: string;
  group_id: string;
  group_title: string;
  homeowner_name: string | null;
  reps: string[];
  pm_name: string | null;
  projects: string | null;
  reloads: string | null;
  reloaded: string | null;
  advantage_plus: boolean;
  address: string | null;
  lat: number | null;
  lng: number | null;
  zip: string | null;
  sale_amount: number;
  schedule_start: string | null;
  schedule_end: string | null;
  prev_schedule_start: string | null;
  prev_schedule_end: string | null;
  completion_date: string | null;
  delayed_until: string | null;
  status_label: string | null;
  reviews_status: string | null;
  referral_status: string | null;
  homeowner_status: HomeownerStatus;
  homeowner_status_reason: string | null;
  homeowner_status_note_date: string | null;
};

// ── Job states (spec §4 + §11 mismatch rules — all non-throwing) ─────────

export type JobState =
  | "starting_soon"
  | "active"
  | "finishing"
  | "just_completed"
  | "post"
  | "paused"
  | "upcoming_tbd"
  | "excluded";

export type JobTimeline = {
  state: JobState;
  /** "Confirm with production" chips for every fallback the rules took. */
  chips: string[];
  /** 1-based calendar day of the job at `anchorISO`; null pre-start/unknown. */
  dayX: number | null;
  /** Total calendar days; null when the end is unknown. */
  dayY: number | null;
  /** Resolved completion date for just_completed/post. */
  completionISO: string | null;
};

const EXCLUDED_STATUS = /\b(cancelled|canceled|ptd|turned down)\b/i;

export function classifyJobTimeline(
  job: PlanJob,
  anchorISO: string,
  config: ActionPlanConfig = ACTION_PLAN_CONFIG,
): JobTimeline {
  const chips: string[] = [];
  const none: JobTimeline = { state: "excluded", chips, dayX: null, dayY: null, completionISO: null };

  if (job.status_label !== null && EXCLUDED_STATUS.test(job.status_label)) return none;

  if (
    job.prev_schedule_start !== null &&
    (job.prev_schedule_start !== job.schedule_start || job.prev_schedule_end !== job.schedule_end)
  ) {
    chips.push(
      `Rescheduled ${job.prev_schedule_start ?? "?"} → ${job.schedule_start ?? "TBD"} — confirm with production`,
    );
  }

  // Paused: the Delayed group, or an explicit future resume date.
  if (
    job.group_id === PRODUCTION_GROUPS.delayed ||
    (job.delayed_until !== null && job.delayed_until > anchorISO)
  ) {
    return {
      state: "paused",
      chips,
      dayX: null,
      dayY: null,
      completionISO: null,
    };
  }

  // Completed lane: Just Completed (≤48h) for testimonial + review, then the
  // 1–7 day follow-up window, then off the plan.
  if (job.group_id === PRODUCTION_GROUPS.completed) {
    const completionISO =
      job.completion_date ?? job.schedule_end ?? job.homeowner_status_note_date;
    if (completionISO === null) {
      chips.push("Completion date unknown — confirm with production");
      return { ...none, chips };
    }
    if (job.completion_date === null) {
      chips.push("Completion date estimated — confirm with production");
    }
    const since = daysBetween(anchorISO, completionISO);
    if (since < 0) {
      // Completed group but the date is ahead: trust the group, flag it.
      chips.push("Marked completed ahead of schedule — confirm with production");
      return { state: "just_completed", chips, dayX: null, dayY: null, completionISO };
    }
    if (since * 24 <= config.justCompletedHours) {
      return { state: "just_completed", chips, dayX: null, dayY: null, completionISO };
    }
    if (since <= config.postWindowDays) {
      return { state: "post", chips, dayX: null, dayY: null, completionISO };
    }
    return { ...none, chips };
  }

  const start = job.schedule_start;
  let end = job.schedule_end;

  // A one-day timeline on a multi-project job is usually a placeholder.
  if (
    start !== null &&
    end !== null &&
    start === end &&
    splitNames(job.projects).length >= 2
  ) {
    chips.push("1-day schedule on a multi-project job — confirm end date with production");
    end = null;
  }

  if (job.group_id === PRODUCTION_GROUPS.queueToStart) {
    if (start === null) return { state: "upcoming_tbd", chips, dayX: null, dayY: null, completionISO: null };
    const until = daysBetween(start, anchorISO);
    if (until > config.preStartWindowDays) {
      return { state: "upcoming_tbd", chips, dayX: null, dayY: null, completionISO: null };
    }
    if (until > 0) {
      return { state: "starting_soon", chips, dayX: null, dayY: dayY(start, end), completionISO: null };
    }
    if (until < 0) {
      chips.push("Start date passed but not moved to In Progress — confirm with production");
    }
    return activeTimeline(start, end, anchorISO, chips);
  }

  // In Progress (and anything else that reached the mirror).
  if (start === null) {
    chips.push("Schedule TBD — confirm with production");
    return { state: "active", chips, dayX: null, dayY: null, completionISO: null };
  }
  if (daysBetween(start, anchorISO) > 0) {
    chips.push("In Progress but start is ahead — confirm with production");
    return { state: "starting_soon", chips, dayX: null, dayY: dayY(start, end), completionISO: null };
  }
  return activeTimeline(start, end, anchorISO, chips);
}

const dayY = (start: string, end: string | null): number | null =>
  end === null ? null : Math.max(1, daysBetween(end, start) + 1);

function activeTimeline(
  start: string,
  end: string | null,
  anchorISO: string,
  chips: string[],
): JobTimeline {
  const x = daysBetween(anchorISO, start) + 1;
  if (end === null) {
    if (!chips.some((c) => c.includes("confirm"))) {
      chips.push("End date TBD — confirm with production");
    }
    return { state: "active", chips, dayX: x, dayY: null, completionISO: null };
  }
  const y = Math.max(1, daysBetween(end, start) + 1);
  if (end < anchorISO) {
    chips.push("Past scheduled end — confirm with production");
    return { state: "finishing", chips, dayX: x, dayY: y, completionISO: null };
  }
  const remaining = daysBetween(end, anchorISO); // 0 = final day
  const state: JobState = remaining <= 1 ? "finishing" : "active";
  return { state, chips, dayX: Math.min(x, y), dayY: y, completionISO: null };
}

// ── Phase table (spec §10, verbatim guidance) ────────────────────────────

export type PhaseKey =
  | "pre_start"
  | "day1"
  | "early"
  | "middle"
  | "late"
  | "final"
  | "post";

export type PhaseGuide = {
  title: string;
  goal: string;
  homeowner: string;
  neighbors: string | null;
  capture: string | null;
};

export const PHASE_GUIDE: Record<PhaseKey, PhaseGuide> = {
  pre_start: {
    title: "Pre-start",
    goal: "Reload before work begins.",
    homeowner:
      "Offer gutters or insulation if listed as a reload; confirm start details.",
    neighbors: null,
    capture: null,
  },
  day1: {
    title: "Day 1",
    goal: "Be present.",
    homeowner: "Introduce yourself to the crew, thank the homeowner.",
    neighbors: "Brief introduction to immediate neighbors.",
    capture: "Before photos.",
  },
  early: {
    title: "Early",
    goal: "Build trust.",
    homeowner: "Check in, share progress.",
    neighbors: "Knock 3–5 neighbors, seed self-gens.",
    capture: "Progress photo or video.",
  },
  middle: {
    title: "Middle",
    goal: "Seed introductions.",
    homeowner: "Ask permission to mention the project; seed the next reload.",
    neighbors: "Follow up with warm neighbors.",
    capture: "During photos.",
  },
  late: {
    title: "Late",
    goal: "Ask for referrals.",
    homeowner: "Direct referral ask; schedule a reload appointment.",
    neighbors: "Second pass, set appointments.",
    capture: null,
  },
  final: {
    title: "Final day",
    goal: "Capture proof.",
    homeowner:
      "Walkthrough, testimonial video, Google review (send the link on the spot).",
    neighbors: "Final pass.",
    capture: "After photos.",
  },
  post: {
    title: "Follow-up",
    goal: "Close the loop.",
    homeowner: "Thank-you, review reminder if not posted, referral status.",
    neighbors: null,
    capture: null,
  },
};

/** Recovery guidance replaces the phase guide on at-risk jobs (spec §6). */
export const RECOVERY_GUIDE: PhaseGuide = {
  title: "Recovery visit",
  goal: "Rebuild trust — no asks on this visit.",
  homeowner:
    "Listen, acknowledge, and relay specifics to production. Confirm with production before your visit.",
  neighbors: null,
  capture: null,
};

/** Asks an at-risk job suppresses (rendered so reps know what's on hold). */
export const SUPPRESSED_ASKS = [
  "referral",
  "neighbor introduction",
  "reload",
  "testimonial video",
  "Google review",
] as const;

/** Phase from job progress, never the calendar (spec §10). ≤2-day jobs
 *  merge Early+Middle; a 1-day job is Pre-start → Final → Post only. */
export function phaseForTimeline(t: JobTimeline): PhaseKey {
  const x = t.dayX;
  const y = t.dayY;
  switch (t.state) {
    case "starting_soon":
      return "pre_start";
    case "just_completed":
      return "final";
    case "post":
      return "post";
    case "finishing":
      // "Finishing" spans the last 1–2 days; only the true last day is the
      // Final phase (a 2-day job still gets its Day 1).
      if (x !== null && y !== null && x === 1 && y >= 2) return "day1";
      if (x !== null && y !== null && x < y) return "late";
      return "final";
    default:
      break;
  }
  if (x === null) return "early";
  if (y === null) return x <= 3 ? (x === 1 ? "day1" : "early") : "middle";
  if (y === 1) return "final";
  if (x <= 1) return "day1";
  if (y === 2) return "early"; // 2-day job: Day 1 then merged Early/Middle → Final
  if (x >= y) return "final";
  const third = y / 3;
  if (x <= Math.max(2, Math.ceil(third))) return "early";
  if (x <= Math.ceil(2 * third)) return "middle";
  return "late";
}

// ── Pins + score (spec §8) ───────────────────────────────────────────────

export type PinKind = "recovery" | "pre_start_reload" | "capture";

export type Pin = { kind: PinKind; label: string };

const GUTTERS_OR_INSULATION = /\b(gutters?|insulation)\b/i;

/** Available reloads = Reloads minus anything already in Reloaded. */
export function availableReloads(job: Pick<PlanJob, "reloads" | "reloaded">): string[] {
  const done = new Set(splitNames(job.reloaded).map((s) => s.toLowerCase()));
  return splitNames(job.reloads).filter((r) => !done.has(r.toLowerCase()));
}

export function pinForJob(
  job: PlanJob,
  t: JobTimeline,
  effective: EffectiveStatus,
  anchorISO: string,
  config: ActionPlanConfig = ACTION_PLAN_CONFIG,
): Pin | null {
  // At-risk wins over every other pin (spec §6: recovery visit, no asks).
  if (effective.status === "at_risk" && t.state !== "excluded" && t.state !== "paused") {
    return { kind: "recovery", label: "Recovery visit — confirm with production first" };
  }
  if (
    t.state === "starting_soon" &&
    job.schedule_start !== null &&
    availableReloads(job).some((r) => GUTTERS_OR_INSULATION.test(r))
  ) {
    const until = daysBetween(job.schedule_start, anchorISO);
    if (until >= 1 && until <= config.preStartWindowDays) {
      return {
        kind: "pre_start_reload",
        label: "Job about to start: reload gutters or insulation",
      };
    }
  }
  if (t.state === "finishing" || t.state === "just_completed") {
    return { kind: "capture", label: "Final stretch: testimonial, review, after photos" };
  }
  return null;
}

/** Opportunity score 0–100 (pinned jobs sort above all scores anyway). */
export function scoreJob(
  job: PlanJob,
  t: JobTimeline,
  effective: EffectiveStatus,
  neighborCount: number,
  config: ActionPlanConfig = ACTION_PLAN_CONFIG,
): number {
  const w = config.weights;
  let score = 0;
  if (job.advantage_plus) score += w.advantagePlus;
  score += Math.min(w.reloadMax, w.reloadPer * availableReloads(job).length);
  score +=
    effective.status === "happy" ? w.happy : effective.status === "neutral" ? w.neutral : w.atRisk;
  score += (w.valueTiers.find((tier) => job.sale_amount >= tier.min) ?? { pts: 0 }).pts;
  if (t.dayY !== null && t.dayX !== null) {
    const remaining = Math.max(0, t.dayY - t.dayX);
    score +=
      w.daysRemainingMax * (1 - Math.min(1, remaining / w.daysRemainingHorizon));
  } else {
    score += w.daysRemainingMax / 2; // unknown end: neutral midpoint
  }
  score += Math.min(w.densityMax, w.densityPer * neighborCount);
  return Math.round(Math.min(100, score));
}

// ── Clustering (spec §9: centroid-radius, no single-link chaining) ───────

export type PlanCluster = {
  label: string;
  jobIds: string[];
  score: number;
  hasPinned: boolean;
};

type ClusterableJob = {
  id: string;
  lat: number | null;
  lng: number | null;
  zip: string | null;
  address: string | null;
  score: number;
  pinned: boolean;
};

const MILES_TO_M = 1609.34;

/** First alphabetic street token after the house number ("8953 Gold Coast
 *  Dr" → "gold"). Last-resort grouping for coordinate-less, zip-less jobs. */
const streetToken = (address: string | null): string | null => {
  const m = (address ?? "").match(/^\s*\d+[\s,]+([A-Za-z]+)/);
  return m ? m[1].toLowerCase() : null;
};

export function clusterJobs(
  jobs: ClusterableJob[],
  config: ActionPlanConfig = ACTION_PLAN_CONFIG,
): PlanCluster[] {
  const radiusM = config.clusterRadiusMiles * MILES_TO_M;
  type Working = { members: ClusterableJob[]; cLat: number; cLng: number };
  const coordClusters: Working[] = [];

  // Highest score first so centroids form around the strongest jobs.
  const withCoords = jobs
    .filter((j) => j.lat !== null && j.lng !== null)
    .sort((a, b) => b.score - a.score);
  for (const job of withCoords) {
    const home = coordClusters.find(
      (c) => haversineM(c.cLat, c.cLng, job.lat as number, job.lng as number) <= radiusM,
    );
    if (home) {
      home.members.push(job);
      home.cLat =
        home.members.reduce((s, m) => s + (m.lat as number), 0) / home.members.length;
      home.cLng =
        home.members.reduce((s, m) => s + (m.lng as number), 0) / home.members.length;
    } else {
      coordClusters.push({ members: [job], cLat: job.lat as number, cLng: job.lng as number });
    }
  }

  // Fallbacks: ZIP groups, then street-token groups, then singletons.
  const rest = jobs.filter((j) => j.lat === null || j.lng === null);
  const byKey = new Map<string, ClusterableJob[]>();
  for (const job of rest) {
    const key = job.zip ?? (streetToken(job.address) ?? `solo:${job.id}`);
    byKey.set(key, [...(byKey.get(key) ?? []), job]);
  }

  const majorityZip = (members: ClusterableJob[]): string => {
    const counts = new Map<string, number>();
    for (const m of members) {
      if (m.zip) counts.set(m.zip, (counts.get(m.zip) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : "Nearby";
  };

  const finish = (members: ClusterableJob[]): PlanCluster => ({
    label: majorityZip(members),
    jobIds: members.map((m) => m.id),
    score:
      Math.round(members.reduce((s, m) => s + m.score, 0)) +
      config.clusterExtraJobBonus * (members.length - 1),
    hasPinned: members.some((m) => m.pinned),
  });

  const clusters = [
    ...coordClusters.map((c) => finish(c.members)),
    ...[...byKey.values()].map(finish),
  ];
  // Pinned-containing clusters first, then summed score (spec §9).
  return clusters.sort((a, b) =>
    a.hasPinned !== b.hasPinned ? (a.hasPinned ? -1 : 1) : b.score - a.score,
  );
}

// ── Visit agenda (spec §4's calendar + §10 pacing) ───────────────────────

export type VisitSlot = {
  dateISO: string;
  jobId: string;
  label: string;
  phase: PhaseKey | "recovery";
};

type AgendaJob = {
  job: PlanJob;
  timeline: JobTimeline;
  effective: EffectiveStatus;
  pin: Pin | null;
};

/** Dated visit slots across the Mon–Sun plan week. One primary ask per
 *  visit; at-risk jobs get a single ASAP recovery slot and nothing else. */
export function planVisitSlots(
  jobs: AgendaJob[],
  planWeekStart: string,
  anchorISO: string,
  config: ActionPlanConfig = ACTION_PLAN_CONFIG,
): VisitSlot[] {
  const weekEnd = addDays(planWeekStart, 6);
  const inWeek = (iso: string) => iso >= planWeekStart && iso <= weekEnd;
  const firstActionable = anchorISO >= planWeekStart ? anchorISO : planWeekStart;
  const slots: VisitSlot[] = [];

  for (const { job, timeline: t, effective, pin } of jobs) {
    if (t.state === "excluded" || t.state === "paused" || t.state === "upcoming_tbd") continue;
    const id = job.monday_item_id;

    if (effective.status === "at_risk") {
      slots.push({
        dateISO: firstActionable,
        jobId: id,
        label: "Recovery visit — listen, no asks",
        phase: "recovery",
      });
      continue;
    }

    if (t.state === "starting_soon" && job.schedule_start !== null) {
      // ONE pre-start visit on the first actionable day of the [start−5,
      // start−1] window — not one per day (review 2026-10-01: a Saturday
      // start was generating six visits to the same homeowner).
      const from = addDays(job.schedule_start, -config.preStartWindowDays);
      const to = addDays(job.schedule_start, -1);
      const isReload = pin?.kind === "pre_start_reload";
      for (let d = from; d <= to; d = addDays(d, 1)) {
        if (!inWeek(d) || d < firstActionable) continue;
        slots.push({
          dateISO: d,
          jobId: id,
          label: isReload
            ? "Job about to start: reload gutters or insulation"
            : "Pre-start: confirm start details",
          phase: "pre_start",
        });
        break;
      }
      if (inWeek(job.schedule_start)) {
        slots.push({
          dateISO: job.schedule_start,
          jobId: id,
          label: "Day 1: meet the crew, before photos",
          phase: "day1",
        });
      }
      continue;
    }

    if (t.state === "just_completed" || t.state === "post") {
      const base = t.completionISO ?? firstActionable;
      const d = base >= firstActionable ? base : firstActionable;
      if (inWeek(d)) {
        slots.push({
          dateISO: d,
          jobId: id,
          label:
            t.state === "just_completed"
              ? "Walkthrough: testimonial video, Google review, after photos"
              : "Follow-up: thank-you, review reminder, referral status",
          phase: t.state === "just_completed" ? "final" : "post",
        });
      }
      continue;
    }

    // Active / finishing.
    const start = job.schedule_start;
    const end = job.schedule_end;
    if (end !== null && end < firstActionable) {
      // Running past its scheduled end (crew never moved the timeline): one
      // ASAP walkthrough slot — without this, overdue jobs showed in Do
      // first but never on the week strip (review 2026-10-01).
      slots.push({
        dateISO: firstActionable,
        jobId: id,
        label: "Past scheduled end: walkthrough, confirm finish with production",
        phase: "final",
      });
      continue;
    }
    if (end !== null && inWeek(end) && end >= firstActionable) {
      slots.push({
        dateISO: end,
        jobId: id,
        label: "Final day: walkthrough, testimonial, review link, after photos",
        phase: "final",
      });
    }
    if (start !== null && start !== end && inWeek(start) && start >= firstActionable) {
      slots.push({
        dateISO: start,
        jobId: id,
        label: "Day 1: meet the crew, before photos",
        phase: "day1",
      });
    }

    // Mid-week pacing: up to longJobVisitsPerWeek spread visits on the days
    // the job is running this week (Mon/Wed/Fri rhythm), skipping days that
    // already carry a slot for this job.
    const taken = new Set(slots.filter((s) => s.jobId === id).map((s) => s.dateISO));
    const runFrom = start !== null && start > firstActionable ? start : firstActionable;
    const runTo = end !== null && end < weekEnd ? end : weekEnd;
    let added = 0;
    for (
      let d = runFrom;
      d <= runTo && added < config.longJobVisitsPerWeek - taken.size;
      d = addDays(d, 2)
    ) {
      if (taken.has(d)) continue;
      const guide = PHASE_GUIDE[phaseForTimeline(t)];
      slots.push({
        dateISO: d,
        jobId: id,
        label: `${guide.title}: ${guide.goal.replace(/\.$/, "").toLowerCase()}`,
        phase: phaseForTimeline(t),
      });
      added += 1;
    }
  }

  return slots.sort(
    (a, b) => a.dateISO.localeCompare(b.dateISO) || a.jobId.localeCompare(b.jobId),
  );
}

// ── Assembly ─────────────────────────────────────────────────────────────

export type AssembledJob = {
  job: PlanJob;
  timeline: JobTimeline;
  phase: PhaseKey;
  guide: PhaseGuide;
  effective: EffectiveStatus;
  pin: Pin | null;
  score: number;
  sharedWith: string[];
  reloadsAvailable: string[];
  /** Non-null on at-risk jobs: the asks this plan is holding back. */
  suppressedAsks: readonly string[] | null;
};

export type WeeklyPlan = {
  jobs: AssembledJob[];
  pinned: AssembledJob[];
  clusters: PlanCluster[];
  /** Top 1–2 clusters (spec §9). */
  route: PlanCluster[];
  agenda: VisitSlot[];
  paused: AssembledJob[];
  upcomingTbd: AssembledJob[];
};

export function buildWeeklyPlan(opts: {
  jobs: PlanJob[];
  overrides: ReadonlyMap<string, HomeownerOverride>;
  isMine: (rep: string) => boolean;
  anchorISO: string;
  planWeekStart: string;
  config?: ActionPlanConfig;
}): WeeklyPlan {
  const config = opts.config ?? ACTION_PLAN_CONFIG;
  const mine = opts.jobs.filter((j) => j.reps.some((r) => opts.isMine(r)));

  type Draft = Omit<AssembledJob, "score"> & { score: number };
  const drafts: Draft[] = [];
  for (const job of mine) {
    const timeline = classifyJobTimeline(job, opts.anchorISO, config);
    if (timeline.state === "excluded" && timeline.chips.length === 0) continue;
    const effective = effectiveHomeownerStatus(job, opts.overrides.get(job.monday_item_id));
    const pin = pinForJob(job, timeline, effective, opts.anchorISO, config);
    const phase = phaseForTimeline(timeline);
    const atRisk = effective.status === "at_risk";
    drafts.push({
      job,
      timeline,
      phase,
      guide: atRisk ? RECOVERY_GUIDE : PHASE_GUIDE[phase],
      effective,
      pin,
      score: 0,
      sharedWith: job.reps.filter((r) => !opts.isMine(r)),
      reloadsAvailable: atRisk ? [] : availableReloads(job),
      suppressedAsks: atRisk ? SUPPRESSED_ASKS : null,
    });
  }

  // Neighbor density: other plan jobs of the SAME rep within the cluster
  // radius (spec §8), computed before scoring.
  const actionable = drafts.filter(
    (d) => !["excluded", "paused", "upcoming_tbd"].includes(d.timeline.state),
  );
  const radiusM = config.clusterRadiusMiles * MILES_TO_M;
  for (const d of actionable) {
    const { lat, lng } = d.job;
    const neighborCount =
      lat === null || lng === null
        ? 0
        : actionable.filter(
            (o) =>
              o !== d &&
              o.job.lat !== null &&
              o.job.lng !== null &&
              haversineM(lat, lng, o.job.lat, o.job.lng) <= radiusM,
          ).length;
    d.score = scoreJob(d.job, d.timeline, d.effective, neighborCount, config);
  }

  const jobs = actionable
    .map((d) => d as AssembledJob)
    .sort((a, b) => {
      if ((a.pin !== null) !== (b.pin !== null)) return a.pin !== null ? -1 : 1;
      return b.score - a.score;
    });

  const clusters = clusterJobs(
    jobs.map((d) => ({
      id: d.job.monday_item_id,
      lat: d.job.lat,
      lng: d.job.lng,
      zip: d.job.zip,
      address: d.job.address,
      score: d.score,
      pinned: d.pin !== null,
    })),
    config,
  );

  return {
    jobs,
    pinned: jobs.filter((d) => d.pin !== null),
    clusters,
    route: clusters.slice(0, 2),
    agenda: planVisitSlots(
      jobs.map((d) => ({ job: d.job, timeline: d.timeline, effective: d.effective, pin: d.pin })),
      opts.planWeekStart,
      opts.anchorISO,
      config,
    ),
    paused: drafts.filter((d) => d.timeline.state === "paused") as AssembledJob[],
    upcomingTbd: drafts.filter((d) => d.timeline.state === "upcoming_tbd") as AssembledJob[],
  };
}
