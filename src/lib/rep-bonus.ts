// Double Up / Triple Up daily sales-rep bonuses (owner, 2026-11-03).
//
// The rules, as the owner set them:
//   • Double Up — 2+ jobs sold in one LA day, combined volume ≥ $20,000 → $500.
//   • Triple Up — 3+ jobs in the day, combined volume ≥ $30,000 → $1,000,
//     REPLACING the Double Up (best tier only, never both).
//   • Below the dollar threshold nothing pays, however many jobs ran.
//   • Shared cards: the job counts once for EACH rep on it, but only the
//     rep's volumeSplit share counts toward the threshold (owner, 2026-11-03,
//     matching how all Kombat/Shark-Tank money splits).
//   • Reloads and upsells are jobs like any other sold card.
//   • Cancels re-check: a bonus stays pending and follows the boards until
//     the month's cancel window passes (contest_rules lock.cancel_window_days,
//     the same knob Kombat locks on); a cancellation that breaks the
//     threshold removes the bonus before payout.
//
// Sale math is NOT reimplemented here: pendingCardCredits (close-kombat.ts)
// with an always-true report gate yields every sold card — SOLD_VALUES
// covers sale/reload/upsell, linkSaves folds Can/Save cards into their
// originals at the re-negotiated price (saver 50% off the top, on the
// ORIGINAL sale's date), cancel-revival and the excluded-card gate all
// apply — broken out per rep at the volumeSplit share. A rep's "day" is the
// card's card_date (LA weekday-group derived at sync).
//
// Pure module: no I/O, fixture-testable (scripts/verify-rep-bonus.ts).

import { addDaysISO, nextMonthStartISO } from "@/lib/dates";
import { pendingCardCredits, type BlockCard } from "@/lib/close-kombat";
import { normalizeName } from "@/lib/utils";

export type RepBonusTierName = "double" | "triple";

export type RepBonusTier = {
  tier: RepBonusTierName;
  label: string;
  minJobs: number;
  minVolume: number;
  amount: number;
};

/** Best tier first — the evaluator takes the first tier the day satisfies. */
export const BONUS_TIERS: readonly RepBonusTier[] = [
  { tier: "triple", label: "Triple Up", minJobs: 3, minVolume: 30_000, amount: 1_000 },
  { tier: "double", label: "Double Up", minJobs: 2, minVolume: 20_000, amount: 500 },
];

export const BONUS_TIER_LABELS: Record<RepBonusTierName, string> = {
  double: "Double Up",
  triple: "Triple Up",
};

/** One job inside a bonus day — the payroll-facing breakdown stored on the
 *  row, so payroll roles never need block_cards access. `share` is this
 *  rep's volumeSplit dollars; `card_total` the deal's full effective price. */
export type RepBonusJob = {
  monday_item_id: string;
  customer: string | null;
  card_total: number;
  share: number;
};

export type RepDayBonusStatus = "pending" | "locked" | "cancelled";

export type RepDayBonusCandidate = {
  bonus_date: string;
  rep_name: string;
  tier: RepBonusTierName;
  amount: number;
  job_count: number;
  volume: number;
  status: "pending" | "locked";
  jobs: RepBonusJob[];
};

/** The day after which a bonus day finalizes: the cancel window counted from
 *  the END OF ITS MONTH — the same rule as contestFinalizeAfterISO, applied
 *  to the bonus day's own month. Day in Oct, window 3 → final from Nov 4. */
export function bonusFinalizeAfterISO(bonusDate: string, cancelWindowDays: number): string {
  const lastOfMonth = addDaysISO(nextMonthStartISO(bonusDate), -1);
  return addDaysISO(lastOfMonth, cancelWindowDays);
}

/** The tier a day's totals earn, or null when nothing pays. */
export function bonusTierFor(jobCount: number, volume: number): RepBonusTier | null {
  for (const tier of BONUS_TIERS) {
    if (jobCount >= tier.minJobs && volume >= tier.minVolume) return tier;
  }
  return null;
}

/** Every qualifying (rep, day) bonus the supplied cards produce. Cards
 *  should be the FULL history (or at least whole months): a day's job count
 *  needs every card on that date, and save-linking needs context around it.
 *  Cancelled/excluded/unsold cards contribute nothing — a cancellation that
 *  breaks a threshold simply stops producing the candidate, and the
 *  recompute reconcile flips the stored row to 'cancelled'. */
export function buildRepDayBonuses(
  cards: readonly BlockCard[],
  todayISO: string,
  cancelWindowDays: number,
): RepDayBonusCandidate[] {
  // Group credits by (rep, day). Names are grouped case-insensitively (the
  // boards aren't perfectly consistent) but stored at the first-seen
  // spelling, matching how contest_ledger keys raw board names.
  type DayAgg = {
    bonus_date: string;
    rep_name: string;
    volume: number;
    jobs: Map<string, RepBonusJob>; // keyed by monday_item_id — a rep credited
    // twice on one card (saver + original share) is ONE job, shares summed.
  };
  const byRepDay = new Map<string, DayAgg>();

  for (const { card, rep, amount, cardTotal } of pendingCardCredits(
    [...cards],
    undefined,
    () => true,
  )) {
    if (!card.card_date) continue; // no derivable sale day — can't bucket it
    const repKey = normalizeName(rep);
    if (repKey === "") continue;
    const key = `${repKey}\u0000${card.card_date}`;
    let agg = byRepDay.get(key);
    if (!agg) {
      agg = { bonus_date: card.card_date, rep_name: rep, volume: 0, jobs: new Map() };
      byRepDay.set(key, agg);
    }
    agg.volume += amount;
    const prev = agg.jobs.get(card.monday_item_id);
    if (prev) {
      prev.share += amount;
    } else {
      agg.jobs.set(card.monday_item_id, {
        monday_item_id: card.monday_item_id,
        customer: card.lead_name,
        card_total: cardTotal,
        share: amount,
      });
    }
  }

  const out: RepDayBonusCandidate[] = [];
  for (const agg of byRepDay.values()) {
    const jobCount = agg.jobs.size;
    const tier = bonusTierFor(jobCount, agg.volume);
    if (!tier) continue;
    out.push({
      bonus_date: agg.bonus_date,
      rep_name: agg.rep_name,
      tier: tier.tier,
      amount: tier.amount,
      job_count: jobCount,
      volume: agg.volume,
      status:
        todayISO > bonusFinalizeAfterISO(agg.bonus_date, cancelWindowDays) ? "locked" : "pending",
      jobs: [...agg.jobs.values()],
    });
  }
  // Deterministic order (date, then rep) so reconciles and fixtures compare
  // stably.
  out.sort((a, b) =>
    a.bonus_date === b.bonus_date
      ? a.rep_name.localeCompare(b.rep_name)
      : a.bonus_date.localeCompare(b.bonus_date),
  );
  return out;
}
