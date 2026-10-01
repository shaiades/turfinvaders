// Collections-board sync engine (owner directive 2026-09-30, God Mode page).
// Walks the monthly "<Month> Collections <YYYY>" Monday boards and mirrors
// every Payment row into public.report_collections, the same walk/upsert/
// reconcile mechanics as the Sales-Report pass in block-cards.server.ts.
// A SIBLING engine on purpose, never a pass inside syncBoardsToBlockCards:
// a Monday hiccup on collections must not surface as a Close Kombat sync
// failure, the scope semantics differ (months, not board weeks), and the
// Block "Full history" walk is already near the serverless time budget.
// Server-only: touches the service role client and the Monday token.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { monday } from "@/lib/monday.server";
import {
  laTodayISO,
  laMonthStartISO,
  monthStartISO,
  nextMonthStartISO,
  addDaysISO,
} from "@/lib/dates";
import { listAllBoards } from "@/lib/block-cards.server";
import {
  buildCollectionRow,
  parseCollectionsBoardName,
  type ReportCollectionRow,
} from "@/lib/collections";

export type CollectionsSyncInput = { scope: "active" | "all"; boardIds?: string[] };
export type CollectionsBoardResult = {
  board_id: string;
  name: string;
  collection_month: string;
  /** False on pre-OC history boards whose rows never resolved an Office —
   *  the summary stays honest about company-wide-only months. */
  office_column_present: boolean;
  fetched: number;
  upserted: number;
  deleted: number;
};
export type CollectionsSyncSummary = {
  results: CollectionsBoardResult[];
  skipped: Array<{ board_id: string; name: string; reason: string }>;
};

// No mirror/formula fragments: Planned/Actual/dates/statuses are all native
// columns, and mirror4 "Total Amount" is excluded by design.
const COLLECTION_ITEM_FIELDS =
  "cursor items { id name group { id title } column_values { id text column { title id } } }";

type ItemsPage = {
  cursor: string | null;
  items: Array<Parameters<typeof buildCollectionRow>[0]>;
};

const CHUNK = 200;
const chunks = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export async function syncCollectionsBoards(
  input: CollectionsSyncInput,
): Promise<CollectionsSyncSummary> {
  const { data: settings } = await supabaseAdmin
    .from("system_settings")
    .select("monday_api_token")
    .maybeSingle();
  const token = (settings?.monday_api_token as string | null) ?? "";
  if (!token) throw new Error("No monday_api_token in system_settings.");

  // Target boards: explicit ids > every parseable Collections board. The
  // account listing MUST page (the June-2026 Block-board lesson lives in
  // listAllBoards' doc comment) — collections history reaches back to 2023.
  let candidates: Array<{ id: string; name: string }>;
  if (input.boardIds?.length) {
    const data = await monday(token, "query ($ids: [ID!]) { boards(ids: $ids) { id name } }", {
      ids: input.boardIds,
    });
    candidates = ((data.boards as Array<{ id: string; name: string }>) ?? []).map((b) => ({
      id: String(b.id),
      name: b.name,
    }));
  } else {
    candidates = (await listAllBoards(token)).filter(
      (b) => /collections/i.test(b.name) && !/^subitems of/i.test(b.name.trim()),
    );
  }

  const results: CollectionsBoardResult[] = [];
  const skipped: CollectionsSyncSummary["skipped"] = [];

  // Quick scope = previous + current + NEXT LA month's boards, compared by
  // the PARSED month (board names are hand-typed; never substring-match
  // labels). Next month rides along because God Mode's forward-cash outlook
  // reads payments scheduled on next month's board (owner, 2026-10-01).
  const curMonth = laMonthStartISO();
  const prevMonth = monthStartISO(addDaysISO(curMonth, -1));
  const nextMonth = nextMonthStartISO(curMonth);
  const activeMonths = new Set([curMonth, prevMonth, nextMonth]);

  const targets: Array<{ id: string; name: string; monthISO: string }> = [];
  for (const b of candidates) {
    const parsed = parseCollectionsBoardName(b.name);
    if (!parsed) {
      skipped.push({
        board_id: b.id,
        name: b.name,
        reason: "month not parseable from board name",
      });
      continue;
    }
    if (
      input.scope === "active" &&
      !input.boardIds?.length &&
      !activeMonths.has(parsed.collectionMonthISO)
    ) {
      continue;
    }
    targets.push({ id: b.id, name: b.name, monthISO: parsed.collectionMonthISO });
  }

  // Sequential on purpose: keeps Monday complexity spend flat and isolates
  // one board's failure from the rest.
  for (const board of targets) {
    try {
      // Stamped BEFORE the cursor walk so the reconcile below only considers
      // rows last written before this instant (collections boards have no
      // webhooks today, but the doctrine costs nothing and survives one).
      const walkStartISO = new Date().toISOString();

      // Full cursor walk. Any page error throws — the board is skipped and,
      // critically, its delete-reconcile never runs on a partial fetch.
      const rows: ReportCollectionRow[] = [];
      let cursor: string | null = null;
      do {
        const data: Record<string, unknown> = cursor
          ? await monday(
              token,
              `query ($cursor: String!) { next_items_page(cursor: $cursor, limit: 500) { ${COLLECTION_ITEM_FIELDS} } }`,
              { cursor },
            )
          : await monday(
              token,
              `query ($b: ID!) { boards(ids: [$b]) { items_page(limit: 500) { ${COLLECTION_ITEM_FIELDS} } } }`,
              { b: board.id },
            );
        const page: ItemsPage | null = cursor
          ? ((data.next_items_page as ItemsPage | null) ?? null)
          : (((data.boards as Array<{ items_page: ItemsPage }> | null) ?? [])[0]?.items_page ??
            null);
        if (!page) throw new Error("items_page missing from Monday response");
        for (const item of page.items ?? []) {
          rows.push(buildCollectionRow(item, board.id, board.name, board.monthISO));
        }
        cursor = page.cursor ?? null;
      } while (cursor);

      for (const batch of chunks(rows, CHUNK)) {
        const { error } = await supabaseAdmin
          .from("report_collections")
          .upsert(batch, { onConflict: "monday_item_id" });
        if (error) throw new Error(error.message);
      }

      // Reconcile deletions: rows for this board that Monday no longer has.
      // Paged past PostgREST's silent 1000-row cap, bounded to rows last
      // written before the walk started (see walkStartISO above).
      const existing: string[] = [];
      for (let from = 0; ; from += CHUNK) {
        const { data: page, error: exErr } = await supabaseAdmin
          .from("report_collections")
          .select("monday_item_id")
          .eq("board_id", board.id)
          .lt("updated_at", walkStartISO)
          .order("monday_item_id")
          .range(from, from + CHUNK - 1);
        if (exErr) throw new Error(exErr.message);
        existing.push(...(page ?? []).map((r) => r.monday_item_id));
        if (!page || page.length < CHUNK) break;
      }
      const fetchedIds = new Set(rows.map((r) => r.monday_item_id));
      const stale = existing.filter((id) => !fetchedIds.has(id));
      for (const batch of chunks(stale, CHUNK)) {
        const { error } = await supabaseAdmin
          .from("report_collections")
          .delete()
          .in("monday_item_id", batch);
        if (error) throw new Error(error.message);
      }

      results.push({
        board_id: board.id,
        name: board.name,
        collection_month: board.monthISO,
        office_column_present: rows.some((r) => r.office !== null),
        fetched: rows.length,
        upserted: rows.length,
        deleted: stale.length,
      });
    } catch (err) {
      skipped.push({
        board_id: board.id,
        name: board.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Owner-auditable trail, same as every other ingestion path.
  await supabaseAdmin.from("webhook_logs").insert({
    step: "Collections_Synced",
    data: {
      scope: input.scope,
      boardIds: input.boardIds ?? null,
      today: laTodayISO(),
      results,
      skipped,
    } as never,
  });

  return { results, skipped };
}
