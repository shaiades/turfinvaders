// Kombat Month engine (owner directive 2026-10-02): the October 2026 points
// contest for all sales reps (SD + OC). Pure module — no supabase imports —
// so scripts/verify-kombat-month.ts can exercise every rule, including the
// September calibration (owner's figures: Yakup 390 … Edward 25, ±1).
//
// Doctrine, decided against September's live Sales Reports (2026-10-02):
//  • Money points mirror the Shark Tank book: a card's points split evenly
//    across the names in the report's Sales Rep column (sale_amt / reps —
//    the board's own Sales formula), and a row belongs to the month of its
//    BOARD (report_month), same as book money. Date Sold drives locking.
//  • A BLANK Sales Count scores as a Sale (+5). Verified: Samuel 49 and
//    Daniel 97 only reproduce with the blank rows counted as sales — the
//    office leaves Sales Count unset on a fresh sale until bookkeeping.
//  • A Cancelled row earns NOTHING (no volume — the office zeroes Sale Amt —
//    and no kickers, not even Marketing Home). Verified: Edward 25 only
//    reproduces with his two cancelled Marketing-Home cards at zero.
//  • Job Walk: volume + Sales-Count kicker, NO source kicker (owner default;
//    job_walk_kicker in contest_rules flips it without a deploy). Verified:
//    Yakup 390 includes the $138,490 Job Walk at volume + Sale only.
//  • WCC is the only cancel authority (owner 2026-09-02): Cancelled /
//    Turned Down / FTD kill a row's money points; LVM / Not Done / Hopechest
//    are fine (Quinn LVM counts in Yakup's 390).
//  • Every weight lives in contest_rules.rules (jsonb), deep-merged over
//    DEFAULT_KOMBAT_RULES so a missing key never silently zeroes a kicker.
//
// Every point is one contest_ledger row keyed (source_kind, source_id,
// rep_name, category). Totals are ALWAYS computed from the ledger. The
// recompute pass (src/lib/kombat-month.server.ts) upserts the candidates
// this module derives; locked rows are never touched again.

import { addDaysISO, laTodayISO, nextMonthStartISO, weekStartOfISO } from "@/lib/dates";
import {
  cardOutcome,
  countReps,
  isOfficeAppt,
  isReload,
  type BlockCard,
  type ReportSaleRow,
} from "@/lib/close-kombat";

// ── Rules ────────────────────────────────────────────────────────────────

export type ProofCategory =
  "testimonial" | "google_review" | "referral_sit" | "before_after" | "role_play" | "gym_checkin";

export const PROOF_CATEGORIES: readonly ProofCategory[] = [
  "testimonial",
  "google_review",
  "referral_sit",
  "before_after",
  "role_play",
  "gym_checkin",
] as const;

export const PROOF_LABELS: Record<ProofCategory, string> = {
  testimonial: "Customer video testimonial",
  google_review: "Google review naming you",
  referral_sit: "Referral that sits",
  before_after: "Before/after photo set",
  role_play: "Role play video",
  gym_checkin: "Gym check-in",
};

export type KombatTier = { key: string; label: string; points: number; cash: number };

export type KombatRules = {
  contest: { month: string; label: string };
  money: {
    per_1000: number;
    count_kickers: { sale: number; reload: number; upsell: number };
    blank_count_is_sale: boolean;
    source_kickers: { self_gen: number; rep_reset: number };
    /** OWNER TO DECIDE — 0 = volume points only (the default). */
    job_walk_kicker: number;
    marketing_home: number;
    advantage_plus: number;
  };
  activity: {
    sit: number;
    reload_pitch: number;
    self_gen_pitch: number;
    self_gen_pitch_enabled: boolean;
  };
  proofs: {
    weights: Record<ProofCategory, number>;
    caps: {
      before_after_per_month: number;
      role_play_per_week: number;
      gym_per_day: number;
      gym_per_week: number;
      total_per_month: number;
    };
  };
  lock: { cancel_window_days: number };
  eligibility: {
    require_purpose: boolean;
    require_weekly_test: boolean;
    require_locked_sale: boolean;
  };
  prizes: {
    tiers: KombatTier[];
    unlock_threshold: number;
    unlock_multiplier: number;
    budget_cap: number;
    /** 0 = dinners not estimated in the budget line (owner sets a figure). */
    dinner_cost_per_head: number;
  };
};

export const DEFAULT_KOMBAT_RULES: KombatRules = {
  contest: { month: "2026-10-01", label: "Kombat Month" },
  money: {
    per_1000: 1,
    count_kickers: { sale: 5, reload: 10, upsell: 3 },
    blank_count_is_sale: true,
    source_kickers: { self_gen: 15, rep_reset: 5 },
    job_walk_kicker: 0,
    marketing_home: 3,
    advantage_plus: 3,
  },
  activity: { sit: 2, reload_pitch: 3, self_gen_pitch: 5, self_gen_pitch_enabled: true },
  proofs: {
    weights: {
      testimonial: 5,
      google_review: 3,
      referral_sit: 5,
      before_after: 1,
      role_play: 2,
      gym_checkin: 1,
    },
    caps: {
      before_after_per_month: 10,
      role_play_per_week: 3,
      gym_per_day: 1,
      gym_per_week: 5,
      total_per_month: 40,
    },
  },
  lock: { cancel_window_days: 3 },
  eligibility: { require_purpose: true, require_weekly_test: true, require_locked_sale: true },
  prizes: {
    tiers: [
      { key: "steakhouse", label: "Steakhouse", points: 125, cash: 0 },
      { key: "bronze", label: "Bronze", points: 200, cash: 500 },
      { key: "silver", label: "Silver", points: 275, cash: 1000 },
      { key: "gold", label: "Gold", points: 375, cash: 2000 },
      { key: "king", label: "Kombat King", points: 500, cash: 3000 },
    ],
    unlock_threshold: 3_000_000,
    unlock_multiplier: 1.25,
    budget_cap: 20_000,
    dinner_cost_per_head: 0,
  },
};

/** Stored contest_rules.rules (jsonb) over the code defaults. Objects merge
 *  one level at a time; arrays (the tier list) replace whole — a partial
 *  tier edit must never splice against defaults. A jsonb null never wins:
 *  a hand-nulled subtree falls back to the defaults instead of crashing
 *  every reader (review 2026-10-02). */
export function mergeKombatRules(stored: unknown): KombatRules {
  const merge = (base: unknown, over: unknown): unknown => {
    if (over === undefined || over === null) return base;
    if (
      typeof base !== "object" ||
      base === null ||
      Array.isArray(base) ||
      typeof over !== "object" ||
      Array.isArray(over)
    ) {
      return over;
    }
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
      out[k] = merge((base as Record<string, unknown>)[k], v);
    }
    return out;
  };
  if (typeof stored !== "object" || stored === null) return DEFAULT_KOMBAT_RULES;
  return merge(DEFAULT_KOMBAT_RULES, stored) as KombatRules;
}

// ── Label normalization (raw Monday labels in, tokens out) ───────────────

const norm = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();

/** Sales Count → token. Blank counts as a sale (see module doctrine). */
export function normalizeSalesCount(
  v: string | null | undefined,
  rules: KombatRules,
): "sale" | "reload" | "upsell" | "cancelled" | "other" {
  const t = norm(v);
  if (t === "" || t === "none") return rules.money.blank_count_is_sale ? "sale" : "other";
  if (t === "sale") return "sale";
  if (t === "reload") return "reload";
  if (t === "upsell") return "upsell";
  if (t === "cancelled" || t === "canceled") return "cancelled";
  return "other";
}

/** Source → kicker token. The boards carry three Job Walk spellings. */
export function normalizeSource(
  v: string | null | undefined,
): "self_gen" | "rep_reset" | "job_walk" | null {
  const t = norm(v);
  if (/self\s*[-_]?\s*gen/.test(t)) return "self_gen";
  if (/rep\s*[-_]?\s*reset/.test(t)) return "rep_reset";
  if (/job\s*[-_]?\s*walk|jobwalk/.test(t)) return "job_walk";
  return null;
}

export const isMarketingHomeLabel = (v: string | null | undefined): boolean =>
  /marketing\s*home/i.test(v ?? "");

export const isAdvantagePlusLabel = (v: string | null | undefined): boolean =>
  /advantage\s*\+/i.test(v ?? "");

/** WCC labels that kill a row's money points (spec: Cancelled / Turned
 *  Down / FTD). Mirrors close-kombat's cancel + FTD tests plus Turned Down. */
export const isDeadWcc = (v: string | null | undefined): boolean =>
  /cancel|\bctc\b|turned\s*down|\bftd\b|financial\s*turn/i.test(v ?? "");

/** "self gen" in the Block card's free-text Source or Agent column —
 *  the proposed self-gen-pitched detection rule (see PR). */
export const isSelfGenCard = (c: Pick<BlockCard, "source" | "agent">): boolean =>
  normalizeSource(c.source) === "self_gen" || normalizeSource(c.agent) === "self_gen";

// ── Ledger candidates ────────────────────────────────────────────────────

export type LedgerStatus = "pending" | "locked" | "cancelled";
export type LedgerSourceKind = "report_sale" | "sit" | "reload_pitch" | "self_gen_pitch" | "proof";

export type LedgerCandidate = {
  month: string;
  rep_name: string;
  category: string;
  points: number;
  status: Exclude<LedgerStatus, "cancelled">;
  source_kind: Exclude<LedgerSourceKind, "proof">;
  source_id: string;
  occurred_on: string | null;
  meta: Record<string, unknown>;
};

export type KombatBounty = {
  id: string;
  label: string;
  categories: string[];
  multiplier: number;
  starts_on: string;
  ends_on: string;
  active: boolean;
};

/** Product of every active bounty covering the category on that date.
 *  An empty categories list means the bounty covers everything. */
export function bountyMultiplier(
  category: string,
  dateISO: string | null,
  bounties: readonly KombatBounty[],
): number {
  if (!dateISO) return 1;
  let m = 1;
  for (const b of bounties) {
    if (!b.active) continue;
    if (dateISO < b.starts_on || dateISO > b.ends_on) continue;
    if (b.categories.length > 0 && !b.categories.includes(category)) continue;
    m *= b.multiplier;
  }
  return m;
}

/** report_sales row + the three Kombat columns the sync now captures. */
export type KombatReportRow = ReportSaleRow & {
  board_id?: string | null;
  board_name?: string | null;
  source?: string | null;
  marketing_home?: string | null;
  advantage_plus?: string | null;
};

export type CardScorePart = { category: string; label: string; points: number };

/** Score one Sales-Report CARD (before the rep split). A cancelled row
 *  returns [] — no volume, no kickers (see module doctrine). A BLANK Sales
 *  Count scores as a Sale only when the row carries real money: the boards
 *  hold utility rows ("Move each month", every rep listed, no dollars) and
 *  a blank $0 row must mint nothing (seen live on the Oct 2026 SD board). */
export function scoreReportCard(row: KombatReportRow, rules: KombatRules): CardScorePart[] {
  const rawBlank =
    (row.sales_count ?? "").trim() === "" || /^none$/i.test((row.sales_count ?? "").trim());
  let count = normalizeSalesCount(row.sales_count, rules);
  if (count === "cancelled") return [];
  if (rawBlank && row.sale_amt === 0 && row.cancel_amt === 0) count = "other";
  const parts: CardScorePart[] = [];
  const vol = (row.sale_amt / 1000) * rules.money.per_1000;
  if (vol !== 0) {
    parts.push({
      category: "money.volume",
      label: `$${Math.round(row.sale_amt).toLocaleString()} written`,
      points: vol,
    });
  }
  if (count === "sale" || count === "reload" || count === "upsell") {
    const kick = rules.money.count_kickers[count];
    if (kick !== 0) {
      parts.push({
        category: `money.${count}`,
        label: count === "sale" ? "Sale" : count === "reload" ? "Reload" : "Upsell",
        points: kick,
      });
    }
  }
  const src = normalizeSource(row.source);
  if (src === "self_gen" && rules.money.source_kickers.self_gen !== 0) {
    parts.push({
      category: "money.self_gen",
      label: "Self Gen",
      points: rules.money.source_kickers.self_gen,
    });
  } else if (src === "rep_reset" && rules.money.source_kickers.rep_reset !== 0) {
    parts.push({
      category: "money.rep_reset",
      label: "Rep Reset",
      points: rules.money.source_kickers.rep_reset,
    });
  } else if (src === "job_walk" && rules.money.job_walk_kicker !== 0) {
    parts.push({
      category: "money.job_walk",
      label: "Job Walk",
      points: rules.money.job_walk_kicker,
    });
  }
  if (isMarketingHomeLabel(row.marketing_home) && rules.money.marketing_home !== 0) {
    parts.push({
      category: "money.marketing_home",
      label: "Marketing Home",
      points: rules.money.marketing_home,
    });
  }
  if (isAdvantagePlusLabel(row.advantage_plus) && rules.money.advantage_plus !== 0) {
    parts.push({
      category: "money.advantage_plus",
      label: "Advantage+",
      points: rules.money.advantage_plus,
    });
  }
  return parts;
}

const lastDayOfMonth = (monthStart: string): string =>
  addDaysISO(nextMonthStartISO(monthStart), -1);

/** The day after which the contest finalizes: the cancel window counted
 *  from the END OF THE MONTH (owner, 2026-10-02 follow-up: "points count
 *  right away — just at the end of the month we wait the cancellation
 *  period for the final count"). Month Oct, window 3 → final from Nov 4. */
export function contestFinalizeAfterISO(rules: KombatRules): string {
  return addDaysISO(lastDayOfMonth(rules.contest.month), rules.lock.cancel_window_days);
}

/** Points COUNT IMMEDIATELY and stay revisable all month — a cancellation
 *  drops them the moment the sync sees it ("numbers update immediately if
 *  anything cancels"). Rows flip to locked only at the month-end
 *  finalization (contestFinalizeAfterISO); after that the count is final
 *  and later edits don't claw anything back. Dead WCC → cancelled. */
export function reportRowLockState(
  row: KombatReportRow,
  rules: KombatRules,
  todayISO: string = laTodayISO(),
): LedgerStatus {
  if (isDeadWcc(row.wcc) || normalizeSalesCount(row.sales_count, rules) === "cancelled") {
    return "cancelled";
  }
  return todayISO > contestFinalizeAfterISO(rules) ? "locked" : "pending";
}

export type MoneyCandidates = {
  candidates: LedgerCandidate[];
  /** Rows that died (dead WCC / Cancelled count): the recompute flips their
   *  surviving pending ledger rows to cancelled — the "−X pts" feed. */
  deadSourceIds: Set<string>;
};

export function buildMoneyCandidates(
  rows: readonly KombatReportRow[],
  rules: KombatRules,
  bounties: readonly KombatBounty[],
  todayISO: string = laTodayISO(),
): MoneyCandidates {
  const month = rules.contest.month;
  const candidates: LedgerCandidate[] = [];
  const deadSourceIds = new Set<string>();
  for (const row of rows) {
    if (row.report_month !== month) continue;
    const state = reportRowLockState(row, rules, todayISO);
    if (state === "cancelled") {
      deadSourceIds.add(row.monday_item_id);
      continue;
    }
    if (row.reps.length === 0) continue;
    const occurred = row.date_sold ?? month;
    for (const part of scoreReportCard(row, rules)) {
      const mult = bountyMultiplier(part.category, occurred, bounties);
      const perRep = (part.points * mult) / row.reps.length;
      if (perRep === 0) continue;
      for (const rep of row.reps) {
        candidates.push({
          month,
          rep_name: rep,
          category: part.category,
          points: perRep,
          status: state,
          source_kind: "report_sale",
          source_id: row.monday_item_id,
          occurred_on: row.date_sold ?? null,
          meta: {
            label: part.label,
            customer: row.customer_name ?? null,
            office: row.office,
            card_points: part.points,
            rep_count: row.reps.length,
            board_id: row.board_id ?? null,
            ...(mult !== 1 ? { bounty_multiplier: mult } : {}),
          },
        });
      }
    }
  }
  return { candidates, deadSourceIds };
}

// ── Activity candidates ──────────────────────────────────────────────────

/** Close Kombat's excluded-Iss gate (CTC / Not Issued / Add Rep), with the
 *  same dead-WCC override the aggregate applies. */
const isExcludedIss = (c: BlockCard): boolean => {
  const v = (c.iss ?? "").trim().toLowerCase();
  return (v === "ctc" || v === "not issued" || v === "add rep") && !isDeadWcc(c.wcc);
};

/** A sit, by the Close Kombat rules: outcome PM or Sold (cancelled lead
 *  sales land in PM; reloads and office appts are their own channels). */
export function isSitCard(c: BlockCard): boolean {
  if (isExcludedIss(c) || isOfficeAppt(c)) return false;
  const outcome = cardOutcome(c);
  if (outcome === "sold") return !isReload(c);
  return outcome === "pm" || outcome === "cancelled";
}

const inContestMonth = (dateISO: string | null, month: string): boolean =>
  dateISO !== null && dateISO >= month && dateISO < nextMonthStartISO(month);

export function buildSitCandidates(
  cards: readonly BlockCard[],
  rules: KombatRules,
  bounties: readonly KombatBounty[],
  todayISO: string = laTodayISO(),
): LedgerCandidate[] {
  const month = rules.contest.month;
  const out: LedgerCandidate[] = [];
  if (rules.activity.sit === 0) return out;
  const status: LedgerCandidate["status"] =
    todayISO > contestFinalizeAfterISO(rules) ? "locked" : "pending";
  for (const card of cards) {
    if (!inContestMonth(card.card_date, month) || !isSitCard(card)) continue;
    const mult = bountyMultiplier("activity.sit", card.card_date, bounties);
    for (const rep of countReps(card)) {
      out.push({
        month,
        rep_name: rep,
        category: "activity.sit",
        points: rules.activity.sit * mult,
        status,
        source_kind: "sit",
        source_id: card.monday_item_id,
        occurred_on: card.card_date,
        meta: {
          label: "Sit",
          customer: card.lead_name,
          office: card.office_location,
          outcome: cardOutcome(card),
          board_id: card.board_id,
          ...(mult !== 1 ? { bounty_multiplier: mult } : {}),
        },
      });
    }
  }
  return out;
}

export function buildSelfGenPitchCandidates(
  cards: readonly BlockCard[],
  rules: KombatRules,
  bounties: readonly KombatBounty[],
  todayISO: string = laTodayISO(),
): LedgerCandidate[] {
  const month = rules.contest.month;
  const out: LedgerCandidate[] = [];
  if (!rules.activity.self_gen_pitch_enabled || rules.activity.self_gen_pitch === 0) return out;
  for (const card of cards) {
    if (!inContestMonth(card.card_date, month)) continue;
    if (!isSelfGenCard(card) || !isSitCard(card)) continue;
    const mult = bountyMultiplier("activity.self_gen_pitch", card.card_date, bounties);
    const status: LedgerCandidate["status"] =
      todayISO > contestFinalizeAfterISO(rules) ? "locked" : "pending";
    for (const rep of countReps(card)) {
      out.push({
        month,
        rep_name: rep,
        category: "activity.self_gen_pitch",
        points: rules.activity.self_gen_pitch * mult,
        status,
        source_kind: "self_gen_pitch",
        source_id: card.monday_item_id,
        occurred_on: card.card_date,
        meta: {
          label: "Self gen pitched",
          customer: card.lead_name,
          office: card.office_location,
          source: card.source ?? card.agent ?? null,
          board_id: card.board_id,
          ...(mult !== 1 ? { bounty_multiplier: mult } : {}),
        },
      });
    }
  }
  return out;
}

export type ReloadSubitemRow = {
  subitem_id: string;
  parent_item_id: string;
  board_id?: string | null;
  report_month: string;
  name: string | null;
  result: string | null;
  date_went: string | null;
  reps: string[];
};

export function buildReloadPitchCandidates(
  subs: readonly ReloadSubitemRow[],
  parentRepsById: ReadonlyMap<string, string[]>,
  rules: KombatRules,
  bounties: readonly KombatBounty[],
  todayISO: string = laTodayISO(),
): LedgerCandidate[] {
  const month = rules.contest.month;
  const out: LedgerCandidate[] = [];
  if (rules.activity.reload_pitch === 0) return out;
  for (const sub of subs) {
    const result = norm(sub.result);
    if (result !== "sold" && result !== "pm") continue;
    if (!inContestMonth(sub.date_went, month)) continue;
    const reps = sub.reps.length > 0 ? sub.reps : (parentRepsById.get(sub.parent_item_id) ?? []);
    if (reps.length === 0) continue;
    const mult = bountyMultiplier("activity.reload_pitch", sub.date_went, bounties);
    const status: LedgerCandidate["status"] =
      todayISO > contestFinalizeAfterISO(rules) ? "locked" : "pending";
    for (const rep of reps) {
      out.push({
        month,
        rep_name: rep,
        category: "activity.reload_pitch",
        points: rules.activity.reload_pitch * mult,
        status,
        source_kind: "reload_pitch",
        source_id: sub.subitem_id,
        occurred_on: sub.date_went,
        meta: {
          label: "Reload pitched",
          customer: sub.name,
          result: sub.result,
          board_id: sub.board_id ?? null,
          parent_item_id: sub.parent_item_id,
          ...(mult !== 1 ? { bounty_multiplier: mult } : {}),
        },
      });
    }
  }
  return out;
}

// ── Proof caps ───────────────────────────────────────────────────────────

export type ApprovedProofLite = { category: ProofCategory; points: number; on: string };

export type ProofAward = { points: number; capped: boolean; cap_note: string | null };

/** Points an approval grants, after the per-category and total caps. A
 *  count-capped category approves at 0 points (the proof is still fine —
 *  it just can't earn past the cap). `on` dates are LA calendar days. */
export function computeProofAward(
  category: ProofCategory,
  onISO: string,
  prior: readonly ApprovedProofLite[],
  rules: KombatRules,
  bounties: readonly KombatBounty[] = [],
): ProofAward {
  const weight =
    rules.proofs.weights[category] * bountyMultiplier(`proof.${category}`, onISO, bounties);
  const caps = rules.proofs.caps;
  const week = weekStartOfISO(onISO);
  const sameWeek = (p: ApprovedProofLite) => weekStartOfISO(p.on) === week;
  const counted = (p: ApprovedProofLite) => p.points > 0;

  if (category === "before_after") {
    const n = prior.filter((p) => p.category === "before_after" && counted(p)).length;
    if (n >= caps.before_after_per_month) {
      return {
        points: 0,
        capped: true,
        cap_note: `${caps.before_after_per_month}/month cap reached`,
      };
    }
  }
  if (category === "role_play") {
    const n = prior.filter((p) => p.category === "role_play" && counted(p) && sameWeek(p)).length;
    if (n >= caps.role_play_per_week) {
      return { points: 0, capped: true, cap_note: `${caps.role_play_per_week}/week cap reached` };
    }
  }
  if (category === "gym_checkin") {
    const today = prior.filter(
      (p) => p.category === "gym_checkin" && counted(p) && p.on === onISO,
    ).length;
    if (today >= caps.gym_per_day) {
      return { points: 0, capped: true, cap_note: `${caps.gym_per_day}/day cap reached` };
    }
    const n = prior.filter((p) => p.category === "gym_checkin" && counted(p) && sameWeek(p)).length;
    if (n >= caps.gym_per_week) {
      return { points: 0, capped: true, cap_note: `${caps.gym_per_week}/week cap reached` };
    }
  }
  const spent = prior.reduce((s, p) => s + p.points, 0);
  const remaining = Math.max(0, caps.total_per_month - spent);
  if (weight > remaining) {
    return {
      points: remaining,
      capped: true,
      cap_note: `clamped to the ${caps.total_per_month}-point monthly proof cap`,
    };
  }
  return { points: weight, capped: false, cap_note: null };
}

// ── Totals, tiers, payouts ───────────────────────────────────────────────

export type LedgerRowLite = {
  rep_name: string;
  category: string;
  points: number;
  status: LedgerStatus;
};

export type RepTotals = {
  rep_name: string;
  locked: number;
  pending: number;
  total: number;
  byCategory: Map<string, { locked: number; pending: number }>;
};

export function totalsFromLedger(rows: readonly LedgerRowLite[]): RepTotals[] {
  const byRep = new Map<string, RepTotals>();
  for (const r of rows) {
    if (r.status === "cancelled") continue;
    let t = byRep.get(r.rep_name);
    if (!t) {
      t = { rep_name: r.rep_name, locked: 0, pending: 0, total: 0, byCategory: new Map() };
      byRep.set(r.rep_name, t);
    }
    const slot = t.byCategory.get(r.category) ?? { locked: 0, pending: 0 };
    if (r.status === "locked") {
      t.locked += r.points;
      slot.locked += r.points;
    } else {
      t.pending += r.points;
      slot.pending += r.points;
    }
    t.total = t.locked + t.pending;
    t.byCategory.set(r.category, slot);
  }
  return [...byRep.values()].sort(
    (a, b) => b.total - a.total || a.rep_name.localeCompare(b.rep_name),
  );
}

export function tierFor(
  points: number,
  rules: KombatRules,
): { current: KombatTier | null; next: KombatTier | null; toNext: number } {
  const tiers = [...rules.prizes.tiers].sort((a, b) => a.points - b.points);
  let current: KombatTier | null = null;
  let next: KombatTier | null = null;
  for (const t of tiers) {
    if (points >= t.points) current = t;
    else {
      next = t;
      break;
    }
  }
  return { current, next, toNext: next ? Math.max(0, next.points - points) : 0 };
}

/** Company October written volume, net of cancels — the office zeroes a
 *  cancelled row's Sale Amt (book-money doctrine), so the straight sum IS
 *  the net figure. SD + OC: no office filter. */
export function companyWritten(rows: readonly KombatReportRow[], month: string): number {
  return rows.reduce((s, r) => s + (r.report_month === month ? r.sale_amt : 0), 0);
}

export type PayoutRow = {
  rep_name: string;
  points: number;
  locked: number;
  eligible: boolean;
  tier: KombatTier | null;
  cash: number;
  dinner: boolean;
};

export type PayoutProjection = {
  rows: PayoutRow[];
  unlockActive: boolean;
  cashTotal: number;
  dinnerHeads: number;
  dinnerCost: number;
  grandTotal: number;
  overBudget: boolean;
  /** 1 = full payouts; < 1 = cash pro-rated to fit the budget cap. */
  prorate: number;
};

export function projectPayouts(
  totals: readonly RepTotals[],
  eligibleByRep: ReadonlyMap<string, boolean>,
  written: number,
  rules: KombatRules,
): PayoutProjection {
  const unlockActive = written >= rules.prizes.unlock_threshold;
  const rows: PayoutRow[] = totals.map((t) => {
    const eligible = eligibleByRep.get(t.rep_name) ?? false;
    const { current } = tierFor(t.total, rules);
    const tier = eligible ? current : null;
    const cash = tier ? tier.cash * (unlockActive ? rules.prizes.unlock_multiplier : 1) : 0;
    return {
      rep_name: t.rep_name,
      points: t.total,
      locked: t.locked,
      eligible,
      tier,
      cash,
      dinner: tier !== null,
    };
  });
  const cashTotal = rows.reduce((s, r) => s + r.cash, 0);
  const dinnerHeads = rows.filter((r) => r.dinner).length;
  const dinnerCost = dinnerHeads * rules.prizes.dinner_cost_per_head;
  const grandTotal = cashTotal + dinnerCost;
  const overBudget = grandTotal > rules.prizes.budget_cap;
  const cashBudget = Math.max(0, rules.prizes.budget_cap - dinnerCost);
  const prorate = overBudget && cashTotal > 0 ? Math.min(1, cashBudget / cashTotal) : 1;
  return {
    rows,
    unlockActive,
    cashTotal,
    dinnerHeads,
    dinnerCost,
    grandTotal,
    overBudget,
    prorate,
  };
}

// ── Eligibility ──────────────────────────────────────────────────────────

export type KombatWeek = { start: string; octStart: string; octEnd: string };

/** The Mon–Sun LA weeks overlapping the contest month. A week is satisfied
 *  by a test taken inside its overlap with the month ("taken every week IN
 *  October" — a Sep 30 take doesn't cover the Sep 28 week). */
export function kombatWeeks(month: string): KombatWeek[] {
  const monthEnd = lastDayOfMonth(month);
  const out: KombatWeek[] = [];
  for (let w = weekStartOfISO(month); w <= monthEnd; w = addDaysISO(w, 7)) {
    const weekEnd = addDaysISO(w, 6);
    out.push({
      start: w,
      octStart: w < month ? month : w,
      octEnd: weekEnd > monthEnd ? monthEnd : weekEnd,
    });
  }
  return out;
}

export type EligibilityInput = {
  purposeSubmitted: boolean;
  /** activity_tests.taken_on values for the rep (any source). */
  testDays: readonly string[];
  /** ≥1 Sale row on the board that hasn't cancelled (points count right
   *  away — owner 2026-10-02 follow-up; the month-end window makes it
   *  final). A later cancellation takes this back until another sale lands. */
  hasCountedSale: boolean;
};

export type EligibilityStatus = {
  purposeOk: boolean;
  /** Weeks due so far (their October overlap has started). */
  weeksDue: number;
  weeksHit: number;
  testsOk: boolean;
  saleOk: boolean;
  eligible: boolean;
};

export function eligibilityStatus(
  input: EligibilityInput,
  rules: KombatRules,
  todayISO: string = laTodayISO(),
): EligibilityStatus {
  const weeks = kombatWeeks(rules.contest.month).filter((w) => w.octStart <= todayISO);
  const hit = weeks.filter((w) =>
    input.testDays.some((d) => d >= w.octStart && d <= w.octEnd),
  ).length;
  const purposeOk = !rules.eligibility.require_purpose || input.purposeSubmitted;
  const testsOk = !rules.eligibility.require_weekly_test || hit >= weeks.length;
  const saleOk = !rules.eligibility.require_locked_sale || input.hasCountedSale;
  return {
    purposeOk,
    weeksDue: weeks.length,
    weeksHit: hit,
    testsOk,
    saleOk,
    eligible: purposeOk && testsOk && saleOk,
  };
}

// ── Display helpers ──────────────────────────────────────────────────────

export const CATEGORY_LABELS: Record<string, string> = {
  "money.volume": "Volume",
  "money.sale": "Sales",
  "money.reload": "Reloads",
  "money.upsell": "Upsells",
  "money.self_gen": "Self Gen",
  "money.rep_reset": "Rep Reset",
  "money.job_walk": "Job Walk",
  "money.marketing_home": "Marketing Home",
  "money.advantage_plus": "Advantage+",
  "activity.sit": "Sits",
  "activity.reload_pitch": "Reload pitches",
  "activity.self_gen_pitch": "Self gen pitched",
  "proof.testimonial": "Testimonials",
  "proof.google_review": "Google reviews",
  "proof.referral_sit": "Referral sits",
  "proof.before_after": "Before/after sets",
  "proof.role_play": "Role plays",
  "proof.gym_checkin": "Gym check-ins",
};

export const fmtPts = (n: number): string => {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};
