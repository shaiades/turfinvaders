// Close Kombat backfill/reconcile engine (owner directive 2026-07-29).
// Walks Monday Block boards and mirrors every card into public.block_cards —
// the same snapshot the live webhook writes — so month view has history and
// deletions/renames reconcile on demand. Server-only: touches the service
// role client and the Monday token.
//
// KEEP IN SYNC: the row-building rules (parseBoardWeekStart, deriveCardDate,
// buildBlockCardRow, column matching, SOLD semantics) are duplicated for the
// Deno runtime in supabase/functions/monday-live-dispatch/block-cards.ts —
// the edge function cannot import from src/ and vice versa. Date helpers
// here reuse src/lib/dates.ts instead of the Deno copies.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { monday } from "@/lib/monday.server";
import { laTodayISO, weekStartOfISO, addDaysISO } from "@/lib/dates";
import type { BlockCard } from "@/lib/close-kombat";

type MondayCol = {
  id: string;
  text: string | null;
  display_value?: string | null;
  column: { title: string; id: string };
};

type MondayItem = {
  id: unknown;
  name?: unknown;
  group?: { id?: unknown; title?: unknown } | null;
  column_values?: MondayCol[] | null;
};

type ItemsPage = { cursor: string | null; items: MondayItem[] };

/** Parse Monday money text ("$1,234.56") → number, else null. */
function parseMoney(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n >= 1e10) return null;
  return Math.round(n * 100) / 100;
}

/** The "Sale Price" column: exact title first, never the outcome column "Sale". */
function findSalePriceCol(cols: MondayCol[]): MondayCol | undefined {
  const norm = (s: string | undefined) => (s || "").trim().toLowerCase();
  return (
    cols.find((c) => norm(c.column?.title) === "sale price") ??
    cols.find((c) => norm(c.column?.title).replace(/\s+/g, "") === "saleprice") ??
    cols.find((c) => norm(c.column?.title).includes("price"))
  );
}

/** The Sale outcome/status column (title "Sale", never "Sale Price"). */
function findSaleOutcomeCol(cols: MondayCol[]): MondayCol | undefined {
  const norm = (s: string | undefined) => (s || "").trim().toLowerCase();
  return (
    cols.find((c) => norm(c.column?.title) === "sale") ??
    cols.find((c) => {
      const t = norm(c.column?.title);
      return t.includes("sale") && !t.includes("price");
    })
  );
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** "SD Block 7/28/26 - 8/2/26" → "2026-07-28" (normalized to its Monday);
 *  null when no M/D/Y triple parses. */
export function parseBoardWeekStart(boardName: string): string | null {
  const m = String(boardName ?? "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  const mo = Number(m[1]);
  const d = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return weekStartOfISO(`${y}-${pad(mo)}-${pad(d)}`);
}

/** Card date = board-week Monday + weekday offset from the group title.
 *  Non-weekday groups → fallback (null on retired boards: never guess history). */
export function deriveCardDate(
  groupTitle: string | null | undefined,
  weekStartISO: string | null,
  fallbackISO: string | null,
): string | null {
  const title = String(groupTitle ?? "")
    .trim()
    .toLowerCase();
  const offset = WEEKDAYS.findIndex((w) => title === w || title.startsWith(w + " "));
  if (offset < 0 || !weekStartISO) return fallbackISO;
  return addDaysISO(weekStartISO, offset);
}

/** Column label text by exact (trimmed, lowercased) title; empty → null. */
function colText(cols: MondayCol[], title: string): string | null {
  const c = cols.find((c) => (c.column?.title || "").trim().toLowerCase() === title);
  const t = (c?.text || "").trim();
  return t === "" ? null : t;
}

/** Monday item → block_cards row (Reps people column `.text` is Monday's
 *  comma-separated display names). */
export function buildBlockCardRow(
  item: MondayItem,
  boardId: string,
  office: string,
  weekStartISO: string | null,
  fallbackISO: string | null,
): BlockCard {
  const cols: MondayCol[] = item.column_values ?? [];
  const groupTitle = item.group?.title == null ? null : String(item.group.title);
  const saleCol = findSaleOutcomeCol(cols);
  const saleText = (saleCol?.text || "").trim();
  const priceCol = findSalePriceCol(cols);
  const reps = (colText(cols, "reps") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    monday_item_id: String(item.id),
    board_id: boardId,
    office_location: office,
    card_date: deriveCardDate(groupTitle, weekStartISO, fallbackISO),
    group_title: groupTitle,
    lead_name: item.name == null ? null : String(item.name),
    reps,
    iss: colText(cols, "iss"),
    bo: colText(cols, "bo"),
    ol: colText(cols, "ol"),
    rs: colText(cols, "rs"),
    pm: colText(cols, "pm"),
    sale: saleText === "" ? null : saleText,
    sale_price: parseMoney(priceCol?.text || priceCol?.display_value || ""),
    products: colText(cols, "products"),
    canvass_stats: colText(cols, "canvass stats"),
  };
}

const ITEM_PAGE_FIELDS =
  "cursor items { id name group { id title } column_values { id text column { title id } ... on FormulaValue { display_value } } }";

const CHUNK = 200;
const chunks = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export type SyncInput = { scope: "active" | "all"; boardIds?: string[] };
export type BoardSyncResult = {
  board_id: string;
  name: string;
  office_location: string;
  week_start: string | null;
  fetched: number;
  upserted: number;
  deleted: number;
};
export type SyncSummary = {
  results: BoardSyncResult[];
  skipped: Array<{ board_id: string; name: string; reason: string }>;
};

export async function syncBoardsToBlockCards(input: SyncInput): Promise<SyncSummary> {
  const { data: settings } = await supabaseAdmin
    .from("system_settings")
    .select(
      "monday_api_token, active_monday_board_sd, active_monday_board_oc, monday_template_board_id",
    )
    .maybeSingle();
  const token = (settings?.monday_api_token as string | null) ?? "";
  if (!token) throw new Error("No monday_api_token in system_settings.");
  const sdId = String(settings?.active_monday_board_sd ?? "");
  const ocId = String(settings?.active_monday_board_oc ?? "");
  const activeIds = new Set([sdId, ocId].filter(Boolean));
  const templateId = String(settings?.monday_template_board_id ?? "");

  // Target boards: explicit ids > all historical Block boards > active pair.
  let targets: Array<{ id: string; name: string }>;
  if (input.boardIds?.length) {
    const data = await monday(token, "query ($ids: [ID!]) { boards(ids: $ids) { id name } }", {
      ids: input.boardIds,
    });
    targets = ((data.boards as Array<{ id: string; name: string }>) ?? []).map((b) => ({
      id: String(b.id),
      name: b.name,
    }));
  } else {
    const data = await monday(
      token,
      "query { boards(limit: 50, order_by: created_at) { id name } }",
    );
    const boards = ((data.boards as Array<{ id: string; name: string }>) ?? []).map((b) => ({
      id: String(b.id),
      name: b.name,
    }));
    targets =
      input.scope === "all"
        ? boards.filter((b) => /^(SD|OC)\s+Block/i.test(b.name) && b.id !== templateId)
        : boards.filter((b) => activeIds.has(b.id));
  }

  const results: BoardSyncResult[] = [];
  const skipped: SyncSummary["skipped"] = [];

  // Sequential on purpose: keeps Monday complexity spend flat and isolates
  // one board's failure from the rest.
  for (const board of targets) {
    try {
      const isActive = activeIds.has(board.id);
      // Office: settings ids are authoritative for the active pair (the live
      // webhook maps offices the same way, so the two paths can never stamp
      // the same board differently); the name prefix covers historical
      // boards, which the scope:'all' filter guarantees start with SD/OC.
      const office =
        board.id === ocId
          ? "Orange County"
          : board.id === sdId
            ? "San Diego"
            : /^OC/i.test(board.name.trim())
              ? "Orange County"
              : "San Diego";
      let weekStart = parseBoardWeekStart(board.name);
      if (!weekStart) {
        if (!isActive) {
          // Never guess dates for history — report and move on.
          skipped.push({
            board_id: board.id,
            name: board.name,
            reason: "week not parseable from board name",
          });
          continue;
        }
        weekStart = weekStartOfISO(laTodayISO());
      }
      const fallback = isActive ? laTodayISO() : null;

      // Stamped BEFORE the cursor walk: the reconcile below only considers
      // rows last written before this instant, so a card the live webhook
      // inserts mid-walk (created in Monday after its group was paged) can
      // never be mistaken for stale and deleted.
      const walkStartISO = new Date().toISOString();

      // Full cursor walk. Any page error throws — the board is skipped and,
      // critically, its delete-reconcile never runs on a partial fetch.
      const rows: BlockCard[] = [];
      let cursor: string | null = null;
      do {
        const data: Record<string, unknown> = cursor
          ? await monday(
              token,
              `query ($cursor: String!) { next_items_page(cursor: $cursor, limit: 500) { ${ITEM_PAGE_FIELDS} } }`,
              { cursor },
            )
          : await monday(
              token,
              `query ($b: ID!) { boards(ids: [$b]) { items_page(limit: 500) { ${ITEM_PAGE_FIELDS} } } }`,
              { b: board.id },
            );
        const page: ItemsPage | null = cursor
          ? ((data.next_items_page as ItemsPage | null) ?? null)
          : (((data.boards as Array<{ items_page: ItemsPage }> | null) ?? [])[0]?.items_page ??
            null);
        if (!page) throw new Error("items_page missing from Monday response");
        for (const item of page.items ?? []) {
          rows.push(buildBlockCardRow(item, board.id, office, weekStart, fallback));
        }
        cursor = page.cursor ?? null;
      } while (cursor);

      for (const batch of chunks(rows, CHUNK)) {
        const { error } = await supabaseAdmin
          .from("block_cards")
          .upsert(batch, { onConflict: "monday_item_id" });
        if (error) throw new Error(error.message);
      }

      // Reconcile deletions: rows for this board that Monday no longer has.
      // Paged (PostgREST silently caps un-ranged selects at 1000 rows — an
      // unpaged read would let stale rows past the cap linger forever), and
      // bounded to rows last written before the walk started (see above).
      const existing: string[] = [];
      for (let from = 0; ; from += CHUNK) {
        const { data: page, error: exErr } = await supabaseAdmin
          .from("block_cards")
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
          .from("block_cards")
          .delete()
          .in("monday_item_id", batch);
        if (error) throw new Error(error.message);
      }

      results.push({
        board_id: board.id,
        name: board.name,
        office_location: office,
        week_start: weekStart,
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
    step: "Block_Cards_Synced",
    data: { scope: input.scope, boardIds: input.boardIds ?? null, results, skipped } as never,
  });

  return { results, skipped };
}
