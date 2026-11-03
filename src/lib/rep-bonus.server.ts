// Double Up / Triple Up recompute pass (owner, 2026-11-03). Server-only:
// derives every (rep, day) bonus from the synced block_cards via the pure
// engine in rep-bonus.ts, then reconciles public.rep_day_bonuses — the
// contest_ledger doctrine, applied to pay:
//
//   • LOCKED rows are NEVER touched again — the payroll fairness contract.
//   • pending rows follow the boards: a cancellation that breaks a day's
//     threshold flips the row to 'cancelled' but KEEPS its jobs snapshot,
//     so payroll sees "bonus removed before payout", never a silent gap. A
//     day whose cancel reverses heals back through the candidate path.
//   • everything locks once the cancel window after ITS month's end passes
//     (contest_rules lock.cancel_window_days — the same knob Kombat locks
//     on), advanced by the daily cron even when nobody pressed Sync.
//
// Fetches ALL of block_cards on purpose (owner, 2026-11-03: bonuses count
// from the start of the data — the first run is a deliberate historical
// backfill, minting past months directly as locked). The table starts late
// July 2026 and pages at 1,000 rows; revisit with a window if volume ever
// makes this slow.
//
// Runs after every admin sync (close-kombat.functions.ts) and from the
// daily cron (refresh-action-plans.ts — the lock sweep needs wall-clock
// time, not new data).

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { laTodayISO } from "@/lib/dates";
import { CARD_COLUMNS, type BlockCard } from "@/lib/close-kombat";
import { loadKombatRules } from "@/lib/kombat-month.server";
import { buildRepDayBonuses, type RepBonusJob } from "@/lib/rep-bonus";
import { normalizeName } from "@/lib/utils";

const CHUNK = 200;
const chunks = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

async function pageAll<T>(
  fetch: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await fetch(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export type RepBonusRecomputeSummary = {
  candidates: number;
  inserted: number;
  updated: number;
  newly_locked: number;
  newly_cancelled: number;
};

type ExistingRow = {
  id: string;
  bonus_date: string;
  rep_name: string;
  tier: string;
  amount: number;
  job_count: number;
  volume: number;
  status: "pending" | "locked" | "cancelled";
  jobs: RepBonusJob[];
};

/** Stable fingerprint of a day's job list, order-independent. */
const jobsKey = (jobs: readonly RepBonusJob[]): string =>
  JSON.stringify(
    [...jobs]
      .sort((a, b) => a.monday_item_id.localeCompare(b.monday_item_id))
      .map((j) => [j.monday_item_id, j.customer, j.card_total, j.share]),
  );

export async function runRepBonusRecompute(): Promise<RepBonusRecomputeSummary> {
  const rules = await loadKombatRules();
  const cancelWindowDays = rules.lock.cancel_window_days;
  const today = laTodayISO();

  const cards = (await pageAll((from, to) =>
    supabaseAdmin.from("block_cards").select(CARD_COLUMNS).order("monday_item_id").range(from, to),
  )) as unknown as BlockCard[];

  const candidates = buildRepDayBonuses(cards, today, cancelWindowDays);

  const existing = (await pageAll((from, to) =>
    supabaseAdmin
      .from("rep_day_bonuses")
      .select("id, bonus_date, rep_name, tier, amount, job_count, volume, status, jobs")
      .order("id")
      .range(from, to),
  )) as unknown as ExistingRow[];

  // Reconcile by normalized name so a board spelling drift ("rep a" one
  // week, "Rep A" the next) updates the row instead of minting a twin.
  const keyOf = (r: { bonus_date: string; rep_name: string }) =>
    `${r.bonus_date}\u0000${normalizeName(r.rep_name)}`;
  const byKey = new Map(existing.map((r) => [keyOf(r), r]));
  const seen = new Set<string>();

  const summary: RepBonusRecomputeSummary = {
    candidates: candidates.length,
    inserted: 0,
    updated: 0,
    newly_locked: 0,
    newly_cancelled: 0,
  };

  const inserts: Array<Record<string, unknown>> = [];
  const nowISO = new Date().toISOString();
  for (const c of candidates) {
    const key = keyOf(c);
    if (seen.has(key)) continue;
    seen.add(key);
    const prev = byKey.get(key);
    if (!prev) {
      inserts.push({
        bonus_date: c.bonus_date,
        rep_name: c.rep_name,
        tier: c.tier,
        amount: c.amount,
        job_count: c.job_count,
        volume: c.volume,
        status: c.status,
        locked_at: c.status === "locked" ? nowISO : null,
        jobs: c.jobs,
      });
      continue;
    }
    if (prev.status === "locked") continue; // the fairness contract
    const changed =
      prev.tier !== c.tier ||
      Math.abs(prev.amount - c.amount) > 1e-9 ||
      prev.job_count !== c.job_count ||
      Math.abs(prev.volume - c.volume) > 1e-9 ||
      prev.status !== c.status ||
      jobsKey(prev.jobs ?? []) !== jobsKey(c.jobs);
    if (!changed) continue;
    // .neq("status","locked") re-asserts the fairness contract AT WRITE
    // TIME: the snapshot above can be stale under two overlapping
    // recomputes, and a row another run just locked must not move.
    const { error } = await supabaseAdmin
      .from("rep_day_bonuses")
      .update({
        tier: c.tier,
        amount: c.amount,
        job_count: c.job_count,
        volume: c.volume,
        status: c.status,
        jobs: c.jobs as never,
        ...(c.status === "locked" ? { locked_at: nowISO } : {}),
      })
      .eq("id", prev.id)
      .neq("status", "locked");
    if (error) throw new Error(`rep_day_bonuses update: ${error.message}`);
    summary.updated += 1;
    if (c.status === "locked") summary.newly_locked += 1;
  }

  // Upsert + ignoreDuplicates: two overlapping recomputes both compute the
  // same new rows, and a plain insert()'s unique violation would abort the
  // whole batch mid-write. First writer wins.
  for (const batch of chunks(inserts, CHUNK)) {
    const { error } = await supabaseAdmin.from("rep_day_bonuses").upsert(batch as never, {
      onConflict: "bonus_date,rep_name",
      ignoreDuplicates: true,
    });
    if (error) throw new Error(`rep_day_bonuses insert: ${error.message}`);
  }
  summary.inserted = inserts.length;

  // Pending rows the candidates no longer produce: the day fell below its
  // threshold (a cancel landed, a split changed). Keep the row + jobs
  // snapshot as 'cancelled' so payroll sees it was removed.
  for (const prev of existing) {
    if (seen.has(keyOf(prev)) || prev.status !== "pending") continue;
    const { error } = await supabaseAdmin
      .from("rep_day_bonuses")
      .update({ status: "cancelled" })
      .eq("id", prev.id)
      .neq("status", "locked");
    if (error) throw new Error(`rep_day_bonuses cancel: ${error.message}`);
    summary.newly_cancelled += 1;
  }

  // Audit trail, same shape as the sync steps.
  await supabaseAdmin
    .from("webhook_logs")
    .insert({ step: "Rep_Bonus_Recomputed", data: summary as never });

  return summary;
}
