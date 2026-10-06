// ═══════════════════════════════════════════════════════════════════════════
// SALES PROCESSING follow-up (owner brief 2026-10-06, Part 1). After a Sold
// write-back the block automation MOVES the item to Sales Processing
// (4155553389) keeping the SAME item id. We then fill Deposit Amt / Finance /
// Advantage+ / Reloads from what the rep's report said — and we asked the
// managers ONCE (at write-back time) for anything the report lacked.
//
// The move is a Monday automation with unpredictable latency, so the fill is a
// QUEUE: index.ts enqueues a row the moment the Sold lands, and the 5-minute
// watchdog task drains it — writing only once the item is actually on the
// Sales Processing board, giving up (with a manager text) after ~2 hours.
// Pure parsing lives in engine.ts (parsePaymentDetails etc.); this is the glue.
// ═══════════════════════════════════════════════════════════════════════════
import type { Supa } from "./supa.ts";
import { SALESPROC_BOARD_ID, SALESPROC_COL } from "./engine.ts";
import { fetchItemBoardId, setColumns } from "./monday.ts";
import { sendDispatcherIMessage } from "./inkbox.ts";

/** Give up after this many watchdog attempts (5-min cadence → ~2 hours). */
const MAX_ATTEMPTS = 24;

export type SalesProcRow = {
  form_item_id: string;
  lead_item_id: string;
  customer: string | null;
  deposit_amount: number | null;
  finance_labels: string[] | null;
  advantage: string | null;
  reload_labels: string[] | null;
  attempts: number;
};

/**
 * Enqueue the follow-up for one Sold (idempotent — the form item id is the PK,
 * a replay no-ops). Values are what the pure parser found; nulls stay null
 * (the missing-items text already went out with the write-back).
 */
export async function enqueueSalesProcFollowup(
  supabase: Supa,
  row: Omit<SalesProcRow, "attempts">,
): Promise<void> {
  try {
    await supabase.from("ooh_salesproc_followups").insert({ ...row });
  } catch (e) {
    console.error("[ooh salesproc enqueue]", e instanceof Error ? e.message : String(e));
  }
}

export type SalesProcSummary = { pending: number; filled: number; gaveUp: number };

/** Drain the follow-up queue: fill every item that has reached Sales Processing. */
export async function processSalesProcFollowups(
  supabase: Supa,
  token: string,
): Promise<SalesProcSummary> {
  const { data } = await supabase
    .from("ooh_salesproc_followups")
    .select(
      "form_item_id, lead_item_id, customer, deposit_amount, finance_labels, advantage, reload_labels, attempts",
    )
    .eq("done", false)
    .limit(25);
  const rows = (data as SalesProcRow[] | null) ?? [];
  const summary: SalesProcSummary = { pending: rows.length, filled: 0, gaveUp: 0 };

  for (const row of rows) {
    const finish = (patch: Record<string, unknown>) =>
      supabase
        .from("ooh_salesproc_followups")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("form_item_id", row.form_item_id);

    const boardId = await fetchItemBoardId(token, row.lead_item_id).catch(() => null);
    if (boardId !== SALESPROC_BOARD_ID) {
      if (row.attempts + 1 >= MAX_ATTEMPTS) {
        summary.gaveUp += 1;
        await finish({ done: true, outcome: "gave_up", attempts: row.attempts + 1 });
        await sendDispatcherIMessage(
          `Sales Processing – ${row.customer ?? row.lead_item_id}: the sold item never arrived on the board, please fill Deposit/Finance/Advantage+/Reloads by hand.`,
        ).catch(() => undefined);
      } else {
        await finish({ attempts: row.attempts + 1 });
      }
      continue;
    }

    // Only the values the report actually stated — never invent (owner rule).
    const values: Record<string, unknown> = {};
    if (row.deposit_amount != null) values[SALESPROC_COL.deposit] = String(row.deposit_amount);
    if (row.finance_labels && row.finance_labels.length > 0)
      values[SALESPROC_COL.finance] = { labels: row.finance_labels };
    if (row.advantage) values[SALESPROC_COL.advantage] = { label: row.advantage };
    if (row.reload_labels && row.reload_labels.length > 0)
      values[SALESPROC_COL.reloads] = { labels: row.reload_labels };

    if (Object.keys(values).length === 0) {
      // Nothing parseable — the missing-items text already asked the office.
      await finish({ done: true, outcome: "nothing_to_fill", attempts: row.attempts + 1 });
      continue;
    }
    const r = await setColumns(
      token,
      SALESPROC_BOARD_ID,
      row.lead_item_id,
      values,
      `ooh-salesproc-${row.form_item_id}`,
    );
    if (r.error) {
      const attempts = row.attempts + 1;
      await finish(
        attempts >= MAX_ATTEMPTS
          ? { done: true, outcome: `error: ${r.error.slice(0, 300)}`, attempts }
          : { attempts },
      );
      if (attempts >= MAX_ATTEMPTS) summary.gaveUp += 1;
      continue;
    }
    summary.filled += 1;
    await finish({ done: true, outcome: "filled", attempts: row.attempts + 1 });
  }
  return summary;
}
