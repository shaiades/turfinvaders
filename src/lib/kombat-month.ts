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
  buildPendingReportCheck,
  cardOutcome,
  countReps,
  customerTokens,
  isOfficeAppt,
  isReload,
  normalizeCustomer,
  pendingCardCredits,
  phoneKey,
  type BlockCard,
  type KombatWindow,
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
    /** Volume — points per $1,000 written. SPLIT across the sale's reps
     *  (the board's own amount÷reps formula). */
    per_1000: number;
    /** Report-side flat bonus, FULL to each rep on the sale. */
    advantage_plus: number;
  };
  /** The ONE kicker a block card earns, by outcome + source (never stacks —
   *  a card emits exactly one). FULL to each rep on the card (owner
   *  2026-10-02: only volume splits). "miss" = sat (PM) but didn't close. */
  card: {
    sale: number;
    reload: number;
    sit: number;
    selfgen_sale: number;
    selfgen_miss: number;
    referral_sale: number;
    referral_miss: number;
  };
  activity: {
    /** Reloads-subitem pitch that sat (Result Sold/PM). */
    reload_pitch: number;
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
  // Volume is the backbone: 1 pt per $1,000, split by rep count. The dinner
  // tier sits at 175 pts (owner 2026-10-02) because $3M ÷ ~17 reps ≈ $175k
  // each — so "dinner" == you wrote your share of the record month.
  money: { per_1000: 1, advantage_plus: 3 },
  card: {
    sale: 5,
    reload: 10,
    sit: 2,
    selfgen_sale: 15,
    selfgen_miss: 10,
    referral_sale: 15,
    referral_miss: 10,
  },
  activity: { reload_pitch: 3 },
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
      { key: "steakhouse", label: "Steakhouse", points: 175, cash: 0 },
      { key: "bronze", label: "Bronze", points: 250, cash: 500 },
      { key: "silver", label: "Silver", points: 350, cash: 1000 },
      { key: "gold", label: "Gold", points: 475, cash: 2000 },
      { key: "king", label: "Kombat King", points: 600, cash: 3000 },
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

/** Sales Count → token. Only "cancelled" steers scoring now (the type
 *  kicker moved to the block card); the rest are informational. */
export function normalizeSalesCount(
  v: string | null | undefined,
): "sale" | "reload" | "upsell" | "cancelled" | "other" {
  const t = norm(v);
  if (t === "sale") return "sale";
  if (t === "reload") return "reload";
  if (t === "upsell") return "upsell";
  if (t === "cancelled" || t === "canceled") return "cancelled";
  return "other";
}

/** Source → kicker token. Covers the board spellings for each. A "Rep Reset"
 *  source is deliberately NOT a token (owner 2026-10-02: a rep-reset sale is
 *  just a sale, not a rewarded behavior) — it falls through to null and scores
 *  as a plain sale. */
export function normalizeSource(
  v: string | null | undefined,
): "self_gen" | "referral" | "job_walk" | null {
  const t = norm(v);
  if (/self\s*[-_]?\s*gen/.test(t)) return "self_gen";
  if (/referr?al/.test(t)) return "referral";
  if (/job\s*[-_]?\s*walk|jobwalk/.test(t)) return "job_walk";
  return null;
}

export const isAdvantagePlusLabel = (v: string | null | undefined): boolean =>
  /advantage\s*\+/i.test(v ?? "");

/** WCC labels that kill a row's money points (spec: Cancelled / Turned
 *  Down / FTD). Mirrors close-kombat's cancel + FTD tests plus Turned Down. */
export const isDeadWcc = (v: string | null | undefined): boolean =>
  /cancel|\bctc\b|turned\s*down|\bftd\b|financial\s*turn/i.test(v ?? "");

/** The normalized source of a block card — its free-text Source column,
 *  falling back to Agent (owner 2026-10-02: referral/self-gen are tracked
 *  by the source on the block card). */
export const cardSource = (
  c: Pick<BlockCard, "source" | "agent">,
): ReturnType<typeof normalizeSource> => normalizeSource(c.source) ?? normalizeSource(c.agent);

/** Ledger categories that count as a "sale that sticks" for eligibility —
 *  any closed deal, however it was sourced. */
export const SALE_CATEGORIES = [
  "card.sale",
  "card.reload",
  "card.selfgen_sale",
  "card.referral_sale",
] as const;

/** Office-scoped customer keys used to decide whether a Sales-Report row
 *  already has a block card — so a report-only sale gets its kicker without
 *  ever double-counting one that a block card scored. Three tiers, mirroring
 *  the report matcher (bestSoldMatch): exact normalized name, order-insensitive
 *  sorted tokens, and phone. The token tier is the one that catches the common
 *  case — the office writes the block card "Ken and Katherine Mokan" and the
 *  report "Mokan, Ken & Katherine", and with the block card carrying no phone
 *  the old name+phone keys both missed, so Edward's reload scored on BOTH the
 *  card and the report (owner 2026-10-02). Sorted tokens are order-free, so the
 *  two spellings land on one key. Gated to ≥2 tokens: a lone common token must
 *  never merge two different customers. */
function customerKeys(
  office: string | null | undefined,
  name: string | null | undefined,
  phone: string | null | undefined,
): string[] {
  const o = office ?? "";
  const keys: string[] = [];
  const nk = normalizeCustomer(name ?? "");
  if (nk) keys.push(`${o}|n|${nk}`);
  const toks = customerTokens(name ?? "");
  if (toks.length >= 2) keys.push(`${o}|t|${toks.join(" ")}`);
  const pk = phoneKey(phone);
  if (pk) keys.push(`${o}|p|${pk}`);
  return keys;
}

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

/** `split: true` parts (volume) divide across the sale's reps; `false`
 *  parts (the flat bonuses) go full to each rep (owner 2026-10-02). */
export type CardScorePart = { category: string; label: string; points: number; split: boolean };

/** Score one Sales-Report row's MONEY layer: volume (split) plus the flat
 *  Advantage+ bonus (full per rep). The sale/reload/self-gen/referral TYPE
 *  kicker is NOT here — it comes from the block card (one per card,
 *  non-stacking). A cancelled row earns nothing. */
export function scoreReportCard(row: KombatReportRow, rules: KombatRules): CardScorePart[] {
  if (normalizeSalesCount(row.sales_count) === "cancelled") return [];
  const parts: CardScorePart[] = [];
  const vol = (row.sale_amt / 1000) * rules.money.per_1000;
  if (vol !== 0) {
    parts.push({
      category: "money.volume",
      label: `$${Math.round(row.sale_amt).toLocaleString()} written`,
      points: vol,
      split: true,
    });
  }
  if (isAdvantagePlusLabel(row.advantage_plus) && rules.money.advantage_plus !== 0) {
    parts.push({
      category: "money.advantage_plus",
      label: "Advantage+",
      points: rules.money.advantage_plus,
      split: false,
    });
  }
  return parts;
}

/** The type kicker a Sales-Report SALE row earns on its OWN (owner
 *  2026-10-02: report-only sales carry a kicker too). Used only for rows
 *  with no matching block card — the block card is the authority when one
 *  exists, so this never stacks. Full to each rep. Returns null for
 *  non-sales (cancelled, upsell, blank $0 utility rows) and job walk
 *  (volume only). Referral can't be seen on the report, so a report-only
 *  referral sale reads as a plain sale. */
export function reportOnlyKicker(
  row: KombatReportRow,
  rules: KombatRules,
): { category: string; label: string; points: number } | null {
  const count = normalizeSalesCount(row.sales_count);
  if (count === "cancelled" || count === "upsell") return null;
  // A genuine sale: a sale/reload row, or a blank row carrying real money.
  const isSale = count === "sale" || count === "reload" || (count === "other" && row.sale_amt > 0);
  if (!isSale) return null;
  const src = normalizeSource(row.source);
  if (src === "job_walk") return null;
  const k = rules.card;
  if (src === "self_gen")
    return { category: "card.selfgen_sale", label: "Self-gen sale", points: k.selfgen_sale };
  if (src === "referral")
    return { category: "card.referral_sale", label: "Referral sale", points: k.referral_sale };
  if (count === "reload") return { category: "card.reload", label: "Reload", points: k.reload };
  return { category: "card.sale", label: "Sale", points: k.sale };
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
  if (isDeadWcc(row.wcc) || normalizeSalesCount(row.sales_count) === "cancelled") {
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
  // Office-scoped customer keys of sales a BLOCK card already scored (from
  // scoredCardKeys). When provided, a report sale NOT in this set is
  // "report-only" and earns its own type kicker — never double, because a
  // covered sale is skipped. Omit it to emit volume + bonuses only.
  coveredKeys?: ReadonlySet<string>,
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
    const parts = [...scoreReportCard(row, rules)];
    // Report-only kicker: only when a covered-keys set was supplied AND no
    // block card covers this customer (owner 2026-10-02). Full per rep.
    if (coveredKeys) {
      const covered = customerKeys(row.office, row.customer_name, row.phone).some((k) =>
        coveredKeys.has(k),
      );
      const kicker = covered ? null : reportOnlyKicker(row, rules);
      if (kicker && kicker.points !== 0) {
        parts.push({ ...kicker, split: false });
      }
    }
    for (const part of parts) {
      const mult = bountyMultiplier(part.category, occurred, bounties);
      // Volume splits across the reps (board formula); flat bonuses + the
      // report-only kicker are full to each rep (owner 2026-10-02).
      const perRep = part.split ? (part.points * mult) / row.reps.length : part.points * mult;
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

/** The ONE kicker a sat block card earns — by outcome then source, most
 *  specific wins, never stacking (owner 2026-10-02). Returns null for cards
 *  that earn no kicker (didn't sit, job walk, or a 0-weight). */
function cardKicker(
  c: BlockCard,
  rules: KombatRules,
): { category: string; label: string; points: number } | null {
  if (isExcludedIss(c) || isOfficeAppt(c)) return null;
  const outcome = cardOutcome(c);
  const sold = outcome === "sold";
  // Sit = PM or Sold (cancelled lead-sale lands in PM). Anything else
  // (reset / no-show / no-demo / OL / unmarked) earns nothing.
  const sat = sold || outcome === "pm" || outcome === "cancelled";
  if (!sat) return null;
  const src = cardSource(c);
  // Job walk is volume-only by standing owner decision — no card kicker.
  if (src === "job_walk") return null;
  const k = rules.card;
  if (src === "self_gen") {
    return sold
      ? { category: "card.selfgen_sale", label: "Self-gen sale", points: k.selfgen_sale }
      : { category: "card.selfgen_miss", label: "Self-gen pitch", points: k.selfgen_miss };
  }
  if (src === "referral") {
    return sold
      ? { category: "card.referral_sale", label: "Referral sale", points: k.referral_sale }
      : { category: "card.referral_miss", label: "Referral pitch", points: k.referral_miss };
  }
  if (sold) {
    return isReload(c)
      ? { category: "card.reload", label: "Reload", points: k.reload }
      : { category: "card.sale", label: "Sale", points: k.sale };
  }
  return { category: "card.sit", label: "Sit", points: k.sit };
}

/** Every block card's single type kicker (sale / reload / self-gen /
 *  referral / sit / pitch-miss), FULL to each rep on the card. Replaces the
 *  old split sit + self-gen-pitch passes; the money volume stays on the
 *  report. source_kind "sit" tags all block-card points; the category says
 *  which kicker. */
export function buildCardCandidates(
  cards: readonly BlockCard[],
  rules: KombatRules,
  bounties: readonly KombatBounty[],
  todayISO: string = laTodayISO(),
): LedgerCandidate[] {
  const month = rules.contest.month;
  const out: LedgerCandidate[] = [];
  const status: LedgerCandidate["status"] =
    todayISO > contestFinalizeAfterISO(rules) ? "locked" : "pending";
  for (const card of cards) {
    if (!inContestMonth(card.card_date, month)) continue;
    const kicker = cardKicker(card, rules);
    if (!kicker || kicker.points === 0) continue;
    const mult = bountyMultiplier(kicker.category, card.card_date, bounties);
    const points = kicker.points * mult;
    if (points === 0) continue;
    for (const rep of countReps(card)) {
      out.push({
        month,
        rep_name: rep,
        category: kicker.category,
        points,
        status,
        source_kind: "sit",
        source_id: card.monday_item_id,
        occurred_on: card.card_date,
        meta: {
          label: kicker.label,
          customer: card.lead_name,
          office: card.office_location,
          outcome: cardOutcome(card),
          source: card.source ?? card.agent ?? null,
          board_id: card.board_id,
          ...(mult !== 1 ? { bounty_multiplier: mult } : {}),
        },
      });
    }
  }
  return out;
}

/** Office-scoped customer keys for every block card that earned a kicker in
 *  the contest month — the "a block card already scored this customer" set
 *  that buildMoneyCandidates uses to decide which report sales are
 *  report-only. Same month gate as buildCardCandidates. */
export function scoredCardKeys(cards: readonly BlockCard[], rules: KombatRules): Set<string> {
  const month = rules.contest.month;
  const keys = new Set<string>();
  for (const c of cards) {
    if (!inContestMonth(c.card_date, month)) continue;
    const kicker = cardKicker(c, rules);
    if (!kicker || kicker.points === 0) continue;
    for (const k of customerKeys(c.office_location, c.lead_name, c.phone)) keys.add(k);
  }
  return keys;
}

/** Live VOLUME at the BLOCK price (owner 2026-10-02): a sold block card earns
 *  its +per_1000 volume the moment it's marked — at the deal's Block price — so
 *  a rep never waits on the monthly Sales Report. This runs through the SAME
 *  rule Shark Tank's Month/Year money uses — pendingCardCredits applies
 *  linkSaves (a landed save re-prices the deal; the saver takes 50% off the
 *  top), the buildPendingReportCheck gate (a card is "still awaiting its report
 *  row" when missing_from_report ≠ false AND no loaded report row corroborates
 *  it by date or amount), and the shared volumeSplit — so the per-rep dollars
 *  match the standings exactly, and Kombat is never BEHIND Shark Tank. The
 *  report row is the authority: once it lands the card stops being pending,
 *  this estimate is dropped, and the recompute deletes the block row it no
 *  longer produces (report volume takes over).
 *
 *  Keyed (source_kind "sit", source_id card id, category "money.volume") — a
 *  different ledger key from the card's TYPE kicker (card.sale/…) and from the
 *  report's own volume (source_kind "report_sale"), so it stacks with the
 *  kicker but can never double the report. */
export function buildCardVolumeCandidates(
  cards: readonly BlockCard[],
  reportRows: readonly KombatReportRow[],
  rules: KombatRules,
  bounties: readonly KombatBounty[],
  todayISO: string = laTodayISO(),
): LedgerCandidate[] {
  const month = rules.contest.month;
  const out: LedgerCandidate[] = [];
  if (rules.money.per_1000 === 0) return out;
  const status: LedgerCandidate["status"] =
    todayISO > contestFinalizeAfterISO(rules) ? "locked" : "pending";
  const window: KombatWindow = { start: month, end: lastDayOfMonth(month) };
  const pendingCheck = buildPendingReportCheck([...reportRows]);
  for (const { card, rep, amount, cardTotal } of pendingCardCredits(
    [...cards],
    window,
    pendingCheck,
  )) {
    if (amount <= 0) continue;
    const mult = bountyMultiplier("money.volume", card.card_date, bounties);
    const points = (amount / 1000) * rules.money.per_1000 * mult;
    if (points === 0) continue;
    out.push({
      month,
      rep_name: rep,
      category: "money.volume",
      points,
      status,
      source_kind: "sit",
      source_id: card.monday_item_id,
      occurred_on: card.card_date,
      meta: {
        label: `$${Math.round(cardTotal).toLocaleString()} written · block price`,
        customer: card.lead_name,
        office: card.office_location,
        card_points: (cardTotal / 1000) * rules.money.per_1000,
        board_id: card.board_id,
        block_price: true,
        ...(mult !== 1 ? { bounty_multiplier: mult } : {}),
      },
    });
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
  "money.advantage_plus": "Advantage+",
  "card.sale": "Sales",
  "card.reload": "Reloads",
  "card.sit": "Sits",
  "card.selfgen_sale": "Self-gen sales",
  "card.selfgen_miss": "Self-gen pitches",
  "card.referral_sale": "Referral sales",
  "card.referral_miss": "Referral pitches",
  "activity.reload_pitch": "Reload pitches",
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

// ── Scorecard (the "move list": what every point is worth) ───────────────
// Built straight from the live rules so the rep-facing card can never drift
// from config — if the owner retunes a weight in contest_rules, the card
// moves with it. A move with a 0 weight is dropped (e.g. Job Walk at the
// default). `per` describes the trigger; `note` carries a cap/condition.

export type ScorecardMove = { label: string; points: number; per: string; note?: string };
export type ScorecardGroup = {
  key: "money" | "close" | "activity" | "proofs";
  title: string;
  hint: string;
  moves: ScorecardMove[];
};

export function buildScorecard(rules: KombatRules): ScorecardGroup[] {
  const m = rules.money;
  const c = rules.card;
  const a = rules.activity;
  const p = rules.proofs;
  const money: ScorecardMove[] = [
    { label: "Written volume", points: m.per_1000, per: "per $1,000 sold" },
    { label: "Advantage+", points: m.advantage_plus, per: "advantage+ member" },
  ].filter((x) => x.points !== 0);
  // The one kicker a sold card earns — never stacks with the sit/volume.
  const close: ScorecardMove[] = [
    { label: "Self-gen sale", points: c.selfgen_sale, per: "your own lead, closed" },
    { label: "Referral sale", points: c.referral_sale, per: "referral, closed" },
    { label: "Reload", points: c.reload, per: "reload, closed" },
    { label: "Sale", points: c.sale, per: "any other close" },
  ].filter((x) => x.points !== 0);
  const activity: ScorecardMove[] = [
    { label: "Self-gen pitch", points: c.selfgen_miss, per: "your lead sat, no close" },
    { label: "Referral pitch", points: c.referral_miss, per: "referral sat, no close" },
    { label: "Reload pitch", points: a.reload_pitch, per: "reload sat (sold/PM)" },
    { label: "Sit", points: c.sit, per: "any other sit (PM)" },
  ].filter((x) => x.points !== 0);
  const proofs: ScorecardMove[] = [
    { label: "Video testimonial", points: p.weights.testimonial, per: "customer on camera" },
    { label: "Google review", points: p.weights.google_review, per: "names you + link" },
    { label: "Referral that sits", points: p.weights.referral_sit, per: "referral sat" },
    {
      label: "Before/after set",
      points: p.weights.before_after,
      per: "job photos",
      note: `${p.caps.before_after_per_month}/mo`,
    },
    {
      label: "Role play video",
      points: p.weights.role_play,
      per: "pitch/objection rep",
      note: `${p.caps.role_play_per_week}/wk`,
    },
    {
      label: "Gym check-in",
      points: p.weights.gym_checkin,
      per: "stay sharp",
      note: `${p.caps.gym_per_day}/day · ${p.caps.gym_per_week}/wk`,
    },
  ].filter((x) => x.points !== 0);
  return [
    { key: "money", title: "Money", hint: "volume splits across the reps", moves: money },
    { key: "close", title: "Close it", hint: "one per deal — the best one", moves: close },
    { key: "activity", title: "Sit & pitch", hint: "full to each rep", moves: activity },
    {
      key: "proofs",
      title: "Proof",
      hint: `owner approves · ${p.caps.total_per_month}/mo cap`,
      moves: proofs,
    },
  ];
}

/** Days remaining in the contest (today inclusive → last day of the contest
 *  month). Zero once the month is over. Pure ISO date math — the countdown
 *  reads as "N days left" without a ticking clock. */
export function contestDaysLeft(rules: KombatRules, todayISO: string = laTodayISO()): number {
  const end = addDaysISO(nextMonthStartISO(rules.contest.month), -1);
  if (todayISO > end) return 0;
  // Count days from today to end inclusive.
  let n = 0;
  let cur = todayISO < rules.contest.month ? rules.contest.month : todayISO;
  while (cur <= end) {
    n += 1;
    cur = addDaysISO(cur, 1);
  }
  return n;
}

/** The belt color token for a tier key — gold crown, descending metals. */
export const BELT_ACCENT: Record<string, string> = {
  king: "var(--kombat-gold)",
  gold: "var(--kombat-gold)",
  silver: "var(--muted-foreground)",
  bronze: "var(--kombat-red)",
  steakhouse: "var(--warning)",
};
