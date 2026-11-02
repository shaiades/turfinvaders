// Kombat Month recompute pass (owner directive 2026-10-02). Server-only:
// derives every money/activity ledger row for the contest month from the
// synced mirrors (report_sales + report_sale_reloads + block_cards) via the
// pure engine in kombat-month.ts, then reconciles public.contest_ledger:
//
//   • LOCKED rows are NEVER touched again — not on a re-sync, not on a rule
//     change, not on a board edit. That is the contest's fairness contract.
//   • pending rows follow the source: points count IMMEDIATELY and update
//     freely all month (owner 2026-10-02 follow-up); everything locks in
//     one sweep once the cancel window after MONTH END passes
//     (contestFinalizeAfterISO) — the final count.
//   • a pending row whose report row DIED (WCC Cancelled / Turned Down /
//     FTD, or Sales Count Cancelled) flips to status 'cancelled' and keeps
//     its points — the feed renders "−X pts, cancelled".
//   • a pending/cancelled row whose source vanished or no longer qualifies
//     is deleted; a cancelled row whose source heals revives through the
//     normal candidate path.
//
// Proof rows (source_kind 'proof') belong to the review server fn and are
// never reconciled here. Runs after every admin sync and from the daily
// cron (the lock sweep needs wall-clock time, not new data).

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { laTodayISO, nextMonthStartISO, weekStartOfISO } from "@/lib/dates";
import { CARD_COLUMNS, type BlockCard } from "@/lib/close-kombat";
import {
  buildCardCandidates,
  buildCardVolumeCandidates,
  buildMoneyCandidates,
  buildReloadPitchCandidates,
  buildWeeklyTestCandidates,
  scoredCardKeys,
  mergeKombatRules,
  type ActivityTestRow,
  type KombatBounty,
  type KombatReportRow,
  type KombatRules,
  type LedgerCandidate,
  type ReloadSubitemRow,
} from "@/lib/kombat-month";
import { buildRepMatcher } from "@/lib/rep-identity";
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

export async function loadKombatRules(): Promise<KombatRules> {
  const { data, error } = await supabaseAdmin
    .from("contest_rules")
    .select("rules")
    .eq("id", true)
    .maybeSingle();
  if (error) throw new Error(`contest_rules: ${error.message}`);
  return mergeKombatRules(data?.rules ?? {});
}

export async function loadKombatBounties(): Promise<KombatBounty[]> {
  const { data, error } = await supabaseAdmin
    .from("contest_bounties")
    .select("id, label, categories, multiplier, starts_on, ends_on, active");
  if (error) throw new Error(`contest_bounties: ${error.message}`);
  return (data ?? []) as KombatBounty[];
}

/** Weekly-test point rows (November model; a 0 weight — the October model —
 *  skips every read). Tests are keyed by auth user, the ledger by board rep
 *  name, so each sales rep binds through the SAME matcher ladder the Stats
 *  tab uses (aliases included) against the rep names the other candidates
 *  already produced; an unmatched rep has no ledger row to land on yet. */
async function weeklyTestCandidates(
  rules: KombatRules,
  bounties: KombatBounty[],
  otherCandidates: readonly LedgerCandidate[],
  today: string,
): Promise<LedgerCandidate[]> {
  if (rules.activity.weekly_test === 0) return [];
  const month = rules.contest.month;

  const { data: roleRows, error: roleErr } = await supabaseAdmin
    .from("user_roles")
    .select("user_id")
    .eq("role", "sales_rep");
  if (roleErr) throw new Error(`user_roles: ${roleErr.message}`);
  const ids = [...new Set((roleRows ?? []).map((r) => r.user_id))];
  if (ids.length === 0) return [];

  const { data: profiles, error: profErr } = await supabaseAdmin
    .from("profiles")
    .select("id, display_name, is_active")
    .in("id", ids);
  if (profErr) throw new Error(`profiles: ${profErr.message}`);

  // Aliases, the useRepAliases shape: normalized display_name → board name.
  const { data: aliasRows } = await supabaseAdmin
    .from("kombat_rep_aliases")
    .select("profile_id, board_name");
  const aliasProfileIds = [...new Set((aliasRows ?? []).map((r) => r.profile_id))];
  const aliasNameById = new Map<string, string | null>();
  if (aliasProfileIds.length > 0) {
    const { data: aliasProfiles } = await supabaseAdmin
      .from("profiles")
      .select("id, display_name")
      .in("id", aliasProfileIds);
    for (const p of aliasProfiles ?? []) aliasNameById.set(p.id, p.display_name);
  }
  const aliases = new Map<string, string>();
  for (const r of aliasRows ?? []) {
    const key = normalizeName(aliasNameById.get(r.profile_id));
    if (key !== "") aliases.set(key, r.board_name);
  }

  // activity_tests is not in the generated Database types (same situation
  // as getKombatAdminBoard); a loose accessor keeps the read honest.
  const raw = supabaseAdmin as unknown as {
    from: (table: string) => {
      select: (cols: string) => {
        in: (
          col: string,
          vals: string[],
        ) => {
          gte: (
            col: string,
            v: string,
          ) => {
            lt: (
              col: string,
              v: string,
            ) => PromiseLike<{ data: ActivityTestRow[] | null; error: { message: string } | null }>;
          };
        };
      };
    };
  };
  const { data: tests, error: testErr } = await raw
    .from("activity_tests")
    .select("rep_id, taken_on")
    .in("rep_id", ids)
    .gte("taken_on", weekStartOfISO(month))
    .lt("taken_on", nextMonthStartISO(month));
  if (testErr) throw new Error(`activity_tests: ${testErr.message}`);
  if (!tests || tests.length === 0) return [];

  const repNames = [...new Set(otherCandidates.map((c) => c.rep_name))];
  const repNameById = new Map<string, string>();
  for (const p of profiles ?? []) {
    if (p.is_active === false) continue;
    const m = buildRepMatcher(p.display_name, repNames, aliases);
    if (m.matched) repNameById.set(p.id, m.matched);
  }

  return buildWeeklyTestCandidates(tests, repNameById, rules, bounties, today);
}

export type KombatRecomputeSummary = {
  month: string;
  candidates: number;
  inserted: number;
  updated: number;
  newly_locked: number;
  newly_cancelled: number;
  deleted: number;
};

type ExistingRow = {
  id: string;
  rep_name: string;
  category: string;
  points: number;
  status: "pending" | "locked" | "cancelled";
  source_kind: string;
  source_id: string;
  occurred_on: string | null;
};

export async function runKombatRecompute(): Promise<KombatRecomputeSummary> {
  const rules = await loadKombatRules();
  const bounties = await loadKombatBounties();
  const month = rules.contest.month;
  const monthEnd = nextMonthStartISO(month);
  const today = laTodayISO();

  const reportRows = (await pageAll((from, to) =>
    supabaseAdmin
      .from("report_sales")
      .select(
        "monday_item_id, board_id, office, report_month, customer_name, phone, date_sold, sale_amt, cancel_amt, wcc, sales_count, reps, source, marketing_home, advantage_plus",
      )
      .eq("report_month", month)
      .order("monday_item_id")
      .range(from, to),
  )) as KombatReportRow[];

  const reloadRows = (await pageAll((from, to) =>
    supabaseAdmin
      .from("report_sale_reloads")
      .select("subitem_id, parent_item_id, board_id, report_month, name, result, date_went, reps")
      .eq("report_month", month)
      .order("subitem_id")
      .range(from, to),
  )) as ReloadSubitemRow[];

  const cards = (await pageAll((from, to) =>
    supabaseAdmin
      .from("block_cards")
      .select(CARD_COLUMNS)
      .gte("card_date", month)
      .lt("card_date", monthEnd)
      .order("monday_item_id")
      .range(from, to),
  )) as unknown as BlockCard[];

  const parentRepsById = new Map(reportRows.map((r) => [r.monday_item_id, r.reps]));
  // Report-only sales (no block card) carry their own kicker (owner
  // 2026-10-02); the covered-keys set stops it double-counting a sale a
  // block card already scored.
  const coveredKeys = scoredCardKeys(cards, rules);
  const money = buildMoneyCandidates(reportRows, rules, bounties, today, coveredKeys);
  // Live volume at block price (owner 2026-10-02): a sold card counts its $/1k
  // immediately, through the SAME pending-money rule Shark Tank uses
  // (buildCardVolumeCandidates → pendingCardCredits). Once the report row lands
  // the card stops being pending and the estimate is dropped for the book's
  // exact number.
  const candidates: LedgerCandidate[] = [
    ...money.candidates,
    ...buildCardCandidates(cards, rules, bounties, today),
    ...buildCardVolumeCandidates(cards, reportRows, rules, bounties, today),
    ...buildReloadPitchCandidates(reloadRows, parentRepsById, rules, bounties, today),
  ];
  candidates.push(...(await weeklyTestCandidates(rules, bounties, candidates, today)));

  const existing = (await pageAll((from, to) =>
    supabaseAdmin
      .from("contest_ledger")
      .select("id, rep_name, category, points, status, source_kind, source_id, occurred_on")
      .eq("month", month)
      .neq("source_kind", "proof")
      .order("id")
      .range(from, to),
  )) as ExistingRow[];

  const keyOf = (r: {
    source_kind: string;
    source_id: string;
    rep_name: string;
    category: string;
  }) => `${r.source_kind}\u0000${r.source_id}\u0000${r.rep_name}\u0000${r.category}`;
  const byKey = new Map(existing.map((r) => [keyOf(r), r]));
  const seen = new Set<string>();

  const summary: KombatRecomputeSummary = {
    month,
    candidates: candidates.length,
    inserted: 0,
    updated: 0,
    newly_locked: 0,
    newly_cancelled: 0,
    deleted: 0,
  };

  const inserts: Array<Record<string, unknown>> = [];
  const nowISO = new Date().toISOString();
  for (const c of candidates) {
    const key = keyOf(c);
    if (seen.has(key)) continue; // duplicate rep names on one card collapse
    seen.add(key);
    const prev = byKey.get(key);
    if (!prev) {
      inserts.push({
        month: c.month,
        rep_name: c.rep_name,
        category: c.category,
        points: c.points,
        status: c.status,
        source_kind: c.source_kind,
        source_id: c.source_id,
        occurred_on: c.occurred_on,
        locked_at: c.status === "locked" ? nowISO : null,
        meta: c.meta,
      });
      continue;
    }
    if (prev.status === "locked") continue; // the fairness contract
    const changed =
      Math.abs(prev.points - c.points) > 1e-9 ||
      prev.status !== c.status ||
      prev.occurred_on !== c.occurred_on;
    if (!changed) continue;
    // .neq("status","locked") re-asserts the fairness contract AT WRITE
    // TIME: the snapshot above can be stale under two overlapping
    // recomputes, and a row another run just locked must not move
    // (review 2026-10-02).
    const { error } = await supabaseAdmin
      .from("contest_ledger")
      .update({
        points: c.points,
        status: c.status,
        occurred_on: c.occurred_on,
        meta: c.meta as never,
        ...(c.status === "locked" ? { locked_at: nowISO } : {}),
      })
      .eq("id", prev.id)
      .neq("status", "locked");
    if (error) throw new Error(`contest_ledger update: ${error.message}`);
    summary.updated += 1;
    if (c.status === "locked") summary.newly_locked += 1;
  }

  // Upsert + ignoreDuplicates: two overlapping recomputes both compute the
  // same new rows, and a plain insert()'s unique violation would abort the
  // whole batch mid-write (review 2026-10-02). First writer wins; the
  // loser's duplicate rows are dropped row-by-row, never fatally.
  for (const batch of chunks(inserts, CHUNK)) {
    const { error } = await supabaseAdmin.from("contest_ledger").upsert(batch as never, {
      onConflict: "source_kind,source_id,rep_name,category",
      ignoreDuplicates: true,
    });
    if (error) throw new Error(`contest_ledger insert: ${error.message}`);
  }
  summary.inserted = inserts.length;

  // Rows the candidates no longer produce.
  const toDelete: string[] = [];
  for (const prev of existing) {
    if (seen.has(keyOf(prev)) || prev.status === "locked") continue;
    const died = prev.source_kind === "report_sale" && money.deadSourceIds.has(prev.source_id);
    if (died) {
      if (prev.status !== "cancelled") {
        const { error } = await supabaseAdmin
          .from("contest_ledger")
          .update({ status: "cancelled" })
          .eq("id", prev.id)
          .neq("status", "locked");
        if (error) throw new Error(`contest_ledger cancel: ${error.message}`);
        summary.newly_cancelled += 1;
      }
      continue;
    }
    toDelete.push(prev.id);
  }
  for (const batch of chunks(toDelete, CHUNK)) {
    const { error } = await supabaseAdmin
      .from("contest_ledger")
      .delete()
      .in("id", batch)
      .neq("status", "locked");
    if (error) throw new Error(`contest_ledger delete: ${error.message}`);
  }
  summary.deleted = toDelete.length;

  // Audit trail, same shape as the sync steps.
  await supabaseAdmin
    .from("webhook_logs")
    .insert({ step: "Kombat_Ledger_Recomputed", data: summary as never });

  return summary;
}
