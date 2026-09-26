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
import {
  laTodayISO,
  laWeekStartISO,
  weekStartOfISO,
  addDaysISO,
  monthStartISO,
  nextMonthStartISO,
} from "@/lib/dates";
import {
  SALE_DATE_WINDOW_DAYS,
  SOLD_VALUES,
  chooseReportReps,
  cleanReps,
  customerTokens,
  decideMissingFlag,
  isCanSave,
  normalizeCustomer,
  phoneKey,
  preferAmountMatch,
  sameRepSet,
  type BlockCard,
  type ReportRepHit,
} from "@/lib/close-kombat";

type MondayCol = {
  id: string;
  text: string | null;
  display_value?: string | null;
  /** LocationValue fragment fields — present only on the Location column. */
  lat?: number | null;
  lng?: number | null;
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

/** The Location column: exact title first, else any column the LocationValue
 *  fragment populated (a renamed column still carries lat/lng). */
function findLocationCol(cols: MondayCol[]): MondayCol | undefined {
  return (
    cols.find((c) => (c.column?.title || "").trim().toLowerCase() === "location") ??
    cols.find((c) => typeof c.lat === "number" && typeof c.lng === "number")
  );
}

/** Monday item → block_cards row (Reps people column `.text` is Monday's
 *  comma-separated display names). Deliberately WITHOUT wcc or report_reps:
 *  the upsert must never clobber what the Sales-Report pass stamped there. */
export function buildBlockCardRow(
  item: MondayItem,
  boardId: string,
  office: string,
  weekStartISO: string | null,
  fallbackISO: string | null,
): Omit<BlockCard, "wcc" | "report_reps"> {
  const cols: MondayCol[] = item.column_values ?? [];
  const groupTitle = item.group?.title == null ? null : String(item.group.title);
  const saleCol = findSaleOutcomeCol(cols);
  const saleText = (saleCol?.text || "").trim();
  const priceCol = findSalePriceCol(cols);
  const locCol = findLocationCol(cols);
  const hasCoords = typeof locCol?.lat === "number" && typeof locCol?.lng === "number";
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
    // Can/Save support (owner, 2026-08-01): comments carry the "Can/Save"
    // marker; phone links a save card to the original sale's card.
    comments: colText(cols, "comments"),
    phone: colText(cols, "phone"),
    // Monday Location column (customer-homes map, owner 2026-09-14): exact
    // house coordinates + formatted address for the customer_homes view.
    lat: hasCoords ? (locCol!.lat as number) : null,
    lng: hasCoords ? (locCol!.lng as number) : null,
    address: (locCol?.text || "").trim() || null,
  };
}

const ITEM_PAGE_FIELDS =
  "cursor items { id name group { id title } column_values { id text column { title id } ... on FormulaValue { display_value } ... on LocationValue { lat lng } } }";

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
export type WccReportResult = {
  board_id: string;
  name: string;
  rows: number;
  cancelled: number;
  /** Cancelled report rows the matcher couldn't tie to a sold Block card. */
  unmatched: string[];
  /** Office the board name is prefixed with (null for legacy un-prefixed
   *  boards) and the month span its name declares — the report_reps heal
   *  only clears stamps inside months that walked successfully. */
  office: string | null;
  month_start: string | null;
  month_end: string | null;
  /** Rows existed but no "Sales Rep" column resolved — report_reps for this
   *  board silently stayed untouched; a title rename would look like this. */
  reps_column_missing?: boolean;
  /** Rows mirrored into report_sales this walk (Shark Tank parity). */
  captured?: number;
  /** Stale report_sales rows deleted by this board's reconcile. */
  report_deleted?: number;
};

/** One Monday Sales-Report row, mirrored verbatim into public.report_sales
 *  (owner, 2026-09-23). The Year tab computes Shark Tank standings from
 *  these rows — sale_amt / reps count, no cancel filter (the office zeroes
 *  Sale Amt on a cancel), Reload/Upsell rows count. */
type ReportSaleInsert = {
  monday_item_id: string;
  board_id: string;
  board_name: string;
  office: string | null;
  report_month: string;
  customer_name: string | null;
  date_sold: string | null;
  sale_amt: number;
  cancel_amt: number;
  wcc: string | null;
  sales_count: string | null;
  phone: string | null;
  reps: string[];
};

export type SyncSummary = {
  results: BoardSyncResult[];
  skipped: Array<{ board_id: string; name: string; reason: string }>;
  wcc: {
    reports: WccReportResult[];
    updated: number;
    /** Cards whose report_reps STAMP was written this pass (credit granted
     *  or corrected). Never counts clears — see reps_cleared. */
    reps_updated: number;
    /** Cards whose report_reps stamp was CLEARED this pass (merge-loop
     *  removals + orphan heals). Kept separate so a mass-clear can never
     *  masquerade as a mass credit grant in the UI. */
    reps_cleared: number;
    /** Sold cards newly proven ABSENT from the walked Sales Report books
     *  this pass (owner, 2026-09-23) / stale flags cleared. Diffed writes —
     *  counts move only when a card's flag actually changed. */
    missing_flagged: number;
    missing_cleared: number;
    errors: string[];
  };
};

/** EVERY board on the account (id + name), newest first, paged past
 *  Monday's per-call cap. boards(limit: N) alone returns only the newest N
 *  account-wide, and with the office minting ~a dozen boards a month the
 *  June 2026 Block boards slid out of a single limit-50 page by mid-August —
 *  "Full history" quietly stopped reaching them, so a June card edit (the
 *  Murray 6/10 sale, fixed 8/7 Christianson upsell) could never land until
 *  the listing paged. Cheap: id+name only, ~5 pages on the 2026 account. */
async function listAllBoards(token: string): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  const PAGE = 100;
  for (let page = 1; ; page++) {
    const data = await monday(
      token,
      "query ($page: Int!) { boards(limit: 100, page: $page, order_by: created_at) { id name } }",
      { page },
    );
    const batch = ((data.boards as Array<{ id: string; name: string }>) ?? []).map((b) => ({
      id: String(b.id),
      name: b.name,
    }));
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

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

  // One paged account listing per run, shared by the Block-board discovery
  // (scope "all") and the report pass — ~5 pages each would double for free.
  let allBoardsCache: Array<{ id: string; name: string }> | null = null;
  const allBoards = async () => (allBoardsCache ??= await listAllBoards(token));

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
  } else if (input.scope === "all") {
    // Full history = EVERY SD/OC Block board, so the listing must page:
    // a single newest-N page shrinks the covered window by two boards a
    // month (see listAllBoards) and pre-window boards have no webhooks, so
    // cards there could drift from Monday forever with no path back.
    targets = (await allBoards()).filter(
      (b) => /^(SD|OC)\s+Block/i.test(b.name) && b.id !== templateId,
    );
  } else {
    const data = await monday(
      token,
      "query { boards(limit: 50, order_by: created_at) { id name } }",
    );
    const boards = ((data.boards as Array<{ id: string; name: string }>) ?? []).map((b) => ({
      id: String(b.id),
      name: b.name,
    }));
    // Quick syncs also walk LAST week's boards (owner, 2026-08-25): rotation
    // keeps their webhooks alive one extra week because the office finalizes
    // Saturday's sales through Monday — the sync must cover the same window
    // or a rep added Monday morning to last week's card only lands on a full
    // backfill. Matched by PARSED week (names are hand-typed), same as
    // rotate-boards. The newest-50 page always contains this week + last
    // week, so the quick path keeps the single cheap call.
    const prevWeekISO = addDaysISO(laWeekStartISO(), -7);
    targets = boards.filter(
      (b) =>
        activeIds.has(b.id) ||
        (/^(SD|OC)\s+Block/i.test(b.name) &&
          b.id !== templateId &&
          parseBoardWeekStart(b.name) === prevWeekISO),
    );
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
      const rows: Array<Omit<BlockCard, "wcc" | "report_reps">> = [];
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

      // A null card_date is "no date derivable", not a fact: on retired
      // boards the fallback is null by design (never guess history), but a
      // card that HAD a date while its board was active must not have it
      // wiped — that would drop the card (and its sale) out of every
      // date-filtered view. Upserts only write the keys they carry, so rows
      // with no derivable date simply omit card_date: fresh inserts default
      // to null, existing rows keep what they have. PostgREST bulk payloads
      // must be key-uniform, hence the two groups.
      const dated = rows.filter((r) => r.card_date !== null);
      const undated = rows
        .filter((r) => r.card_date === null)
        .map(({ card_date: _drop, ...rest }) => rest);
      for (const batch of chunks(dated, CHUNK)) {
        const { error } = await supabaseAdmin
          .from("block_cards")
          .upsert(batch, { onConflict: "monday_item_id" });
        if (error) throw new Error(error.message);
      }
      for (const batch of chunks(undated, CHUNK)) {
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

  // ── Sales-Report pass ── two stamps come from the monthly "... Sales
  // Report" boards. WCC: cancelled sales are only recorded there (owner,
  // 2026-07-29: WCC column, "Cancelled"; owner 2026-09-02: the WCC column
  // is the ONLY cancel authority — Sales Count is bookkeeping). report_reps
  // (owner, 2026-08-25): the office records who SHARES THE MONEY in the
  // report's Sales Rep column — the Shark Tank splits volume by it, so the
  // app's volume split follows it. Rows bind to cards by customer name,
  // falling back to the customer PHONE when every name tier misses
  // (Bunzal/Punzal, Aug '26 — see bestSoldMatch). Two phases: COLLECT every report row's
  // best-match sold Block card across ALL boards, then MERGE per card
  // (cancel-wins for wcc, best-single-row for report_reps) and write once.
  // One customer spans several report rows (sale + reload + "(copy)"
  // siblings, often "Completed"/unset) — row-by-row writes let a later row
  // erase an earlier Cancelled stamp (seen live 2026-07-29: 15 cancels
  // collapsed to 1). Never fatal to the block sync.
  const wcc: SyncSummary["wcc"] = {
    reports: [],
    updated: 0,
    reps_updated: 0,
    reps_cleared: 0,
    missing_flagged: 0,
    missing_cleared: 0,
    errors: [],
  };
  try {
    // Paged like the Block-board discovery (a single limit-100 page was one
    // month from dropping the June 2026 reports the same way the Block
    // listing dropped June's boards).
    // Monday auto-creates a "Subitems of <board>" shadow board per report
    // board — same name suffix, no WCC/Sales Rep columns, reload-titled
    // rows that can fuzzy-bind to real cards. Never walk them. Two sets:
    //  • SD/OC-prefixed books (May 2026 onward) — capture + the wcc/
    //    report_reps STAMP passes, exactly as before.
    //  • Un-prefixed 2026 books ("January 2026 Sales Report" … April, the
    //    single-board era) — CAPTURE ONLY (owner, 2026-09-23: the Year tab
    //    mirrors the Shark Tank YTD, which sums these boards). They must
    //    never run the stamp matcher: those months have no Block cards, and
    //    matchReportRow's date-blind fallback could bind a January repeat
    //    customer to their June card. The 2023-25 books stay out entirely.
    const reportYearOf = (n: string): number | null => {
      const m = n.match(new RegExp(`(?:${MONTH_NAMES.join("|")})\\s+(\\d{4})`, "i"));
      return m ? Number(m[1]) : null;
    };
    let reportBoards = (await allBoards())
      .filter(
        (b) => /\bsales report\b/i.test(b.name) && !/^subitems of/i.test(b.name.trim()),
      )
      .map((b) => ({ ...b, stamp: /^(SD|OC)\s/i.test(b.name.trim()) }))
      .filter((b) => b.stamp || (reportYearOf(b.name) ?? 0) >= 2026);
    if (input.scope !== "all") {
      // Quick syncs only touch the current + previous month's reports.
      const labels = recentMonthLabels().map((l) => l.toLowerCase());
      reportBoards = reportBoards.filter((b) =>
        labels.some((l) => b.name.toLowerCase().includes(l)),
      );
    }
    if (reportBoards.length > 0) {
      const { cards: soldCards, repsAvailable, missingAvailable } = await fetchCandidateCards();
      if (!repsAvailable) {
        // Column missing (deploy raced the migration, or a rollback): the
        // reps pass stands down for this run; the wcc cancel heal continues
        // exactly as before the column existed.
        wcc.errors.push(
          "report_reps column missing from block_cards — reps pass skipped, wcc heal unaffected",
        );
      }
      // card monday_item_id → every matching report row's evidence.
      const matches = new Map<string, ReportRepHit[]>();
      for (const rb of reportBoards) {
        try {
          // Stamped BEFORE the walk, same rationale as the Block-board
          // reconcile: a row the office adds mid-walk must never read as
          // stale.
          const walkStartISO = new Date().toISOString();
          const captured: ReportSaleInsert[] = [];
          const res = await collectReportBoard(token, rb, soldCards, matches, {
            stamp: rb.stamp,
            capture: captured,
          });
          // report_sales mirror (owner, 2026-09-23): every walked report row
          // upserts verbatim; the Year tab computes Shark Tank standings
          // from these rows. Upsert + delete-reconcile only run when the
          // walk completed — a thrown page error lands in catch below and
          // leaves the board's rows untouched.
          // No parseable month = no report_month bucket: capture stands down
          // for the board (never guess a bucket) and the audit trail says so.
          if (res.month_start === null) {
            wcc.errors.push(`${rb.name}: month not parseable — report_sales capture skipped`);
          }
          for (const batch of chunks(captured, CHUNK)) {
            const { error } = await supabaseAdmin
              .from("report_sales")
              .upsert(batch, { onConflict: "monday_item_id" });
            if (error) throw new Error(`report_sales upsert: ${error.message}`);
          }
          // Reconcile whenever capture was ACTIVE for the walk (month parsed),
          // even if it yielded zero rows — an emptied board must still clear
          // its stale mirror rows, same as the Block-board reconcile.
          if (res.month_start !== null) {
            const existing: string[] = [];
            for (let from = 0; ; from += CHUNK) {
              const { data: page, error: exErr } = await supabaseAdmin
                .from("report_sales")
                .select("monday_item_id")
                .eq("board_id", rb.id)
                .lt("updated_at", walkStartISO)
                .order("monday_item_id")
                .range(from, from + CHUNK - 1);
              if (exErr) throw new Error(`report_sales reconcile: ${exErr.message}`);
              existing.push(...(page ?? []).map((r) => r.monday_item_id));
              if (!page || page.length < CHUNK) break;
            }
            const capturedIds = new Set(captured.map((r) => r.monday_item_id));
            const stale = existing.filter((id) => !capturedIds.has(id));
            for (const batch of chunks(stale, CHUNK)) {
              const { error } = await supabaseAdmin
                .from("report_sales")
                .delete()
                .in("monday_item_id", batch);
              if (error) throw new Error(`report_sales delete: ${error.message}`);
            }
            res.report_deleted = stale.length;
          }
          res.captured = captured.length;
          wcc.reports.push(res);
        } catch (err) {
          wcc.errors.push(`${rb.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Can/Save lookup for the MATCHED cards only. Comments are long free
      // text — fetching them for every candidate row would multiply the
      // whole-table read; the few hundred matched ids are the only ones the
      // reps decision consults.
      const canSaveIds = new Set<string>();
      if (repsAvailable) {
        for (const batch of chunks([...matches.keys()], CHUNK)) {
          const { data: rows, error } = await supabaseAdmin
            .from("block_cards")
            .select("monday_item_id, comments")
            .in("monday_item_id", batch);
          if (error) {
            wcc.errors.push(`can/save lookup: ${error.message}`);
            continue;
          }
          for (const r of rows ?? []) {
            if (isCanSave({ comments: r.comments })) canSaveIds.add(r.monday_item_id);
          }
        }
      }

      const byId = new Map(soldCards.map((c) => [c.monday_item_id, c]));
      // report_reps writes are GROUPED by desired stamp: distinct rep sets
      // across two offices are tens, matched cards on a backfill are
      // thousands — one UPDATE ... IN (...) per distinct set instead of one
      // round-trip per card.
      const stampGroups = new Map<string, { set: string[] | null; ids: string[] }>();
      for (const [cardId, hits] of matches) {
        const card = byId.get(cardId);
        if (!card) continue;
        const desired = chooseWcc(hits.map((h) => h.wcc));
        // WCC label ONLY here. The Sales Report must never write a sale
        // price: owner, 2026-07-30, after a card whose Block Sale Price was
        // blank showed $10,000 in Revenue because this pass copied the
        // report's Sale Amt in. The Block board's Sale Price column is the
        // single source of truth for volume — blank means $0, not "look
        // elsewhere". report_reps (who SHARES the volume) is the second
        // lawful stamp, written separately below so a missing column can
        // never take the cancel heal down with it.
        if ((card.wcc ?? null) !== (desired ?? null)) {
          const { error } = await supabaseAdmin
            .from("block_cards")
            .update({ wcc: desired })
            .eq("monday_item_id", cardId);
          if (error) {
            wcc.errors.push(`update ${cardId}: ${error.message}`);
          } else {
            card.wcc = desired;
            wcc.updated += 1;
          }
        }
        if (!repsAvailable) continue;
        // null decision = weak evidence (no date-anchored row from a board
        // whose Sales Rep column resolved): the stored stamp stays. A stamp
        // is only cleared by evidence as strong as what set it.
        const decision = chooseReportReps(hits, {
          sale_price: card.sale_price,
          card_date: card.card_date,
          can_save: canSaveIds.has(cardId),
        });
        if (decision === null) continue;
        if (sameRepSet(decision.set ?? [], card.report_reps ?? [])) continue;
        const key = JSON.stringify(decision.set);
        const group = stampGroups.get(key) ?? { set: decision.set, ids: [] };
        group.ids.push(cardId);
        stampGroups.set(key, group);
        card.report_reps = decision.set;
      }
      for (const { set, ids } of stampGroups.values()) {
        for (const batch of chunks(ids, CHUNK)) {
          const { error } = await supabaseAdmin
            .from("block_cards")
            .update({ report_reps: set })
            .in("monday_item_id", batch);
          if (error) {
            wcc.errors.push(`report_reps ×${batch.length}: ${error.message}`);
          } else if (set === null) {
            wcc.reps_cleared += batch.length;
          } else {
            wcc.reps_updated += batch.length;
          }
        }
      }

      // ── report_reps heal ── a card whose matched report rows vanished
      // outright (row deleted/renamed, or rebound to another card) keeps a
      // stale stamp that OVERRIDES the Block board's reps. Clear orphans,
      // but only where this pass produced PROOF of absence: spans from
      // boards that walked successfully, had rows, resolved the Sales Rep
      // column, and carry an office prefix — a legacy un-prefixed board
      // must never authorize clearing another office's month, and a renamed
      // column must never read as "the office removed everyone". Boundary
      // cards can be stamped by the ADJACENT month's board (Date Sold binds
      // within ±SALE_DATE_WINDOW_DAYS), so the card's whole window must be
      // covered before absence counts — otherwise a September quick sync
      // (Sept+Aug boards) would strip an Aug-1 card stamped from the July
      // report, and the next full sync would put it back, forever.
      if (repsAvailable) {
        const healSpans = wcc.reports
          .filter(
            (r) =>
              r.month_start !== null &&
              r.month_end !== null &&
              r.office !== null &&
              r.rows > 0 &&
              !r.reps_column_missing,
          )
          .map((r) => ({
            office: r.office as string,
            start: r.month_start as string,
            end: r.month_end as string,
          }));
        const coveredDay = (office: string, day: string) =>
          healSpans.some((s) => s.office === office && day >= s.start && day < s.end);
        const orphanIds: string[] = [];
        for (const card of soldCards) {
          if (card.report_reps == null) continue;
          if (matches.has(card.monday_item_id)) continue; // merge loop owns it
          const date = card.card_date;
          if (date === null) continue;
          const lo = addDaysISO(date, -SALE_DATE_WINDOW_DAYS);
          const hi = addDaysISO(date, SALE_DATE_WINDOW_DAYS);
          // Spans are whole months, so covering both endpoints and the date
          // itself covers the contiguous window between them.
          if (!coveredDay(card.office_location, lo)) continue;
          if (!coveredDay(card.office_location, date)) continue;
          if (!coveredDay(card.office_location, hi)) continue;
          orphanIds.push(card.monday_item_id);
          card.report_reps = null;
        }
        for (const batch of chunks(orphanIds, CHUNK)) {
          const { error } = await supabaseAdmin
            .from("block_cards")
            .update({ report_reps: null })
            .in("monday_item_id", batch);
          if (error) {
            wcc.errors.push(`report_reps heal ×${batch.length}: ${error.message}`);
          } else {
            wcc.reps_cleared += batch.length;
          }
        }
      }

      // ── Not-on-Sales-Report flag ── (owner, 2026-09-23) same proof-of-
      // absence doctrine as the report_reps heal: only (office, month) spans
      // that walked successfully WITH rows may testify that a sale's row is
      // absent — but reps_column_missing is deliberately not required here,
      // because row EXISTENCE doesn't need the Sales Rep column to resolve.
      // Uncovered windows write NOTHING: a quick sync (current + previous
      // books only) must never wipe a Full-history flag, so clearing an old
      // month's flag after the office adds the row takes a Full history run
      // — the Needs Attention copy says so. Diffed writes only, so a no-op
      // pass never churns updated_at/realtime.
      if (missingAvailable) {
        const flagSpans = wcc.reports
          .filter(
            (r) =>
              r.month_start !== null && r.month_end !== null && r.office !== null && r.rows > 0,
          )
          .map((r) => ({
            office: r.office as string,
            start: r.month_start as string,
            end: r.month_end as string,
          }));
        const flagCovered = (office: string, day: string) =>
          flagSpans.some((s) => s.office === office && day >= s.start && day < s.end);
        const wantTrue: SoldCardLite[] = [];
        const toFalse: string[] = [];
        for (const card of soldCards) {
          if (card.card_date === null) continue;
          const lo = addDaysISO(card.card_date, -SALE_DATE_WINDOW_DAYS);
          const hi = addDaysISO(card.card_date, SALE_DATE_WINDOW_DAYS);
          const covered =
            flagCovered(card.office_location, lo) &&
            flagCovered(card.office_location, card.card_date) &&
            flagCovered(card.office_location, hi);
          const want = decideMissingFlag({
            matched: matches.has(card.monday_item_id),
            covered,
            soldAlive: card.sold && !isDeadLabel(card.wcc),
          });
          if (want === null || want === (card.missing_from_report ?? null)) continue;
          if (want) wantTrue.push(card);
          else toFalse.push(card.monday_item_id);
        }
        // Can/Save exemption: a landed save card is sold-labeled and priced,
        // but its deal lives on the ORIGINAL sale's report row — never flag
        // it. Comments aren't in SoldCardLite (long free text); the would-be
        // flagged set is tiny, so look them up (the canSaveIds pattern).
        const toTrue: string[] = [];
        for (const batch of chunks(
          wantTrue.map((c) => c.monday_item_id),
          CHUNK,
        )) {
          const { data: rows, error } = await supabaseAdmin
            .from("block_cards")
            .select("monday_item_id, comments")
            .in("monday_item_id", batch);
          if (error) {
            wcc.errors.push(`missing-flag can/save lookup: ${error.message}`);
            continue; // conservative: an unreadable batch flags nothing
          }
          for (const r of rows ?? []) {
            if (!isCanSave({ comments: r.comments })) toTrue.push(r.monday_item_id);
          }
        }
        for (const [ids, value] of [
          [toTrue, true],
          [toFalse, false],
        ] as const) {
          for (const batch of chunks(ids, CHUNK)) {
            const { error } = await supabaseAdmin
              .from("block_cards")
              .update({ missing_from_report: value })
              .in("monday_item_id", batch);
            if (error) {
              wcc.errors.push(`missing_from_report ×${batch.length}: ${error.message}`);
            } else if (value) {
              wcc.missing_flagged += batch.length;
            } else {
              wcc.missing_cleared += batch.length;
            }
          }
        }
      }
    }
  } catch (err) {
    wcc.errors.push(err instanceof Error ? err.message : String(err));
  }

  // Owner-auditable trail, same as every other ingestion path.
  await supabaseAdmin.from("webhook_logs").insert({
    step: "Block_Cards_Synced",
    data: { scope: input.scope, boardIds: input.boardIds ?? null, results, skipped, wcc } as never,
  });

  return { results, skipped, wcc };
}

// ── WCC pass internals ───────────────────────────────────────────────────

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "July 2026"-style labels for the current and previous LA months. */
function recentMonthLabels(): string[] {
  const [y, m] = laTodayISO().split("-").map(Number);
  const cur = `${MONTH_NAMES[m - 1]} ${y}`;
  const prev = m === 1 ? `${MONTH_NAMES[11]} ${y - 1}` : `${MONTH_NAMES[m - 2]} ${y}`;
  return [cur, prev];
}

// normalizeCustomer / customerTokens moved to @/lib/close-kombat
// (2026-09-23): the pending-report client match needs them browser-side,
// and this pass imports them back from there.

type SoldCardLite = {
  monday_item_id: string;
  lead_name: string | null;
  office_location: string;
  card_date: string | null;
  wcc: string | null;
  sale_price: number | null;
  /** Current report_reps stamp — the merge diffs against it (no-op writes
   *  would churn updated_at/realtime) and the heal clears orphans. Always
   *  null when the pass runs with repsAvailable=false. */
  report_reps: string[] | null;
  /** Sale cell still carries a sold label. Cancelled sales usually get the
   *  Block card's Sale cell reverted too (the webhook's Sale_Lead_Voided
   *  flow), so cancel rows must be allowed to match non-sold cards. */
  sold: boolean;
  _norm: string;
  _tkey: string;
  /** phoneKey of the card's phone ("" when none) — the last-resort match
   *  when the two sides spell the customer differently (Bunzal/Punzal). */
  _phone: string;
  /** Current Not-on-Sales-Report stamp — the flag pass diffs against it so
   *  no-op writes never churn realtime. Always null when the pass runs with
   *  missingAvailable=false. */
  missing_from_report: boolean | null;
};

/** EVERY Block card, paged past PostgREST's 1000-row cap. Non-cancel report
 *  rows only stamp sold cards; cancel rows may stamp any card (see `sold`).
 *  Comments are deliberately NOT selected — they're long free text needed
 *  only for the few hundred matched cards, fetched separately.
 *
 *  repsAvailable=false when block_cards has no report_reps column yet (a
 *  deploy that raced the migration, or a rollback): the caller degrades to
 *  wcc-only for the pass instead of losing the cancel heal too. */
async function fetchCandidateCards(): Promise<{
  cards: SoldCardLite[];
  repsAvailable: boolean;
  missingAvailable: boolean;
}> {
  const soldSet = new Set(SOLD_VALUES as readonly string[]);
  // Each optional column degrades INDEPENDENTLY on an error naming it (a
  // deploy that raced its migration, or a rollback): report_reps loss costs
  // the reps pass, missing_from_report loss costs the flag pass — neither
  // may ever take the wcc cancel heal down with it.
  let repsAvailable = true;
  let missingAvailable = true;
  type PageRow = Pick<
    BlockCard,
    | "monday_item_id"
    | "lead_name"
    | "office_location"
    | "card_date"
    | "sale"
    | "sale_price"
    | "wcc"
    | "phone"
  > & { report_reps?: string[] | null; missing_from_report?: boolean | null };
  const out: SoldCardLite[] = [];
  const BASE_COLUMNS =
    "monday_item_id, lead_name, office_location, card_date, sale, sale_price, wcc, phone";
  for (let from = 0; ; from += 1000) {
    let rows: PageRow[] | null = null;
    while (rows === null) {
      const sel =
        BASE_COLUMNS +
        (repsAvailable ? ", report_reps" : "") +
        (missingAvailable ? ", missing_from_report" : "");
      const { data, error } = await supabaseAdmin
        .from("block_cards")
        .select(sel)
        .order("monday_item_id")
        .range(from, from + 999);
      if (error && missingAvailable && /missing_from_report/i.test(error.message)) {
        missingAvailable = false;
        continue;
      }
      if (error && repsAvailable && /report_reps/i.test(error.message)) {
        repsAvailable = false;
        continue;
      }
      if (error) throw new Error(error.message);
      // The dynamic column list defeats supabase-js's literal-type parsing.
      rows = (data ?? []) as unknown as PageRow[];
    }
    for (const r of rows) {
      out.push({
        monday_item_id: r.monday_item_id,
        lead_name: r.lead_name,
        office_location: r.office_location,
        card_date: r.card_date,
        wcc: r.wcc,
        sale_price: r.sale_price,
        report_reps: repsAvailable ? (r.report_reps ?? null) : null,
        sold: soldSet.has((r.sale ?? "").trim().toLowerCase()),
        _norm: normalizeCustomer(r.lead_name ?? ""),
        _tkey: customerTokens(r.lead_name ?? "").join(" "),
        _phone: phoneKey(r.phone),
        missing_from_report: missingAvailable ? (r.missing_from_report ?? null) : null,
      });
    }
    if (rows.length < 1000) break;
  }
  return { cards: out, repsAvailable, missingAvailable };
}

// SALE_DATE_WINDOW_DAYS moved to @/lib/close-kombat (2026-09-23) — the
// client-side pending match uses the same ±3-day identity window.

/** Cards that ran within `days` of `aroundISO`. Cards with no date can't be
 *  proven near it, so they only survive the unrestricted fallback pass. */
export function withinDays(cards: SoldCardLite[], aroundISO: string, days: number): SoldCardLite[] {
  const target = Date.parse(aroundISO);
  if (Number.isNaN(target)) return cards;
  const span = days * 86_400_000;
  return cards.filter(
    (c) => c.card_date !== null && Math.abs(Date.parse(c.card_date) - target) <= span,
  );
}

/** Bind one Sales-Report row to a Block card, DATE FIRST (owner, 2026-07-30).
 *
 *  The bug this exists to kill: bestSoldMatch returns as soon as a name tier
 *  yields a single candidate, so Date Sold was never consulted on the common
 *  path. A repeat customer whose two cards are written differently — "Mary &
 *  Joe LaBruno" on 7/24 vs "LaBruno, Mary & Joe" on 7/30 — had last week's
 *  report row bind to this week's card, because only the newer card hit the
 *  exact-name tier. That put a $10,000 sale from one week onto another.
 *
 *  So when the row carries a real Date Sold, match against cards that ran near
 *  it before considering anyone else. Only if that finds nothing do we fall
 *  back to the old date-blind search — a fuzzy match still beats an unmatched
 *  cancel, and the fallback keeps sloppy Date Sold entry working. `pools` is
 *  tried in order (sold cards first, then every card for cancel rows), and the
 *  date-true pass sweeps ALL pools before any date-blind one does. `amounts`
 *  is the row's dollar figures (Sale Amt / Cancel Amt) — see bestSoldMatch.
 *  `phone` is the row's phone digits (phoneKey), the last-resort tier when
 *  every name tier misses — see the Bunzal/Punzal note on bestSoldMatch. */
export function matchReportRow(
  pools: SoldCardLite[][],
  reportNorm: string,
  office: string | null,
  saleDateISO: string | null,
  fallbackISO: string | null,
  amounts: Array<number | null> = [],
  phone: string | null = null,
): { card: SoldCardLite; dateTrue: boolean } | null {
  if (saleDateISO) {
    for (const pool of pools) {
      const near = withinDays(pool, saleDateISO, SALE_DATE_WINDOW_DAYS);
      const hit = bestSoldMatch(near, reportNorm, office, saleDateISO, amounts, phone);
      // dateTrue: the row carried a real Date Sold and the card ran within
      // the window of it — the only tier trusted to rewrite report_reps.
      if (hit) return { card: hit, dateTrue: true };
    }
  }
  for (const pool of pools) {
    const hit = bestSoldMatch(pool, reportNorm, office, saleDateISO ?? fallbackISO, amounts, phone);
    if (hit) return { card: hit, dateTrue: false };
  }
  return null;
}

/** Exact normalized name first, then prefix containment (≥8 chars — report
 *  and card names truncate/extend each other: "Matismo, Reuben & Eli" vs
 *  "Matismo, Reuben & Elizabeth"). Office narrows when the report board is
 *  office-prefixed; a card priced at one of the row's dollar figures beats
 *  the rest (preferAmountMatch — a repeat customer's sale and reload rows
 *  must land on their own cards); nearest card_date breaks remaining ties.
 *  Phone fallback (owner, 2026-09-02): when EVERY name tier misses, cards
 *  sharing the row's phone digits qualify — the office spelled one side's
 *  customer wrong (report "Punzal, Melissa & Ray" vs Block card "Melissa and
 *  Ray Bunzal", Aug '26: the row never bound, so the rep-pair stamp never
 *  landed and Jovanny kept the whole split). Names first, always: the phone
 *  tier never overrides a name match, and a customer's other same-phone
 *  cards (office appts, resets) are held off by the pool order (sold cards
 *  first), the amount preference, and the nearest-date tiebreak — the same
 *  guards every name tier relies on.
 *  Amount-guided tier fallthrough (2026-09-08): when the winning name tier
 *  holds NO card at any of the row's dollar figures, a DEEPER tier whose
 *  card is cents-exact wins instead — the dollar figure is identity
 *  evidence (preferAmountMatch's rule) and it must arbitrate ACROSS tiers
 *  too. The Dang cancel row (Cancel Amt $68,200, "Dang, Nate & Andy") was
 *  an exact token match for the customer's $3,000 reload card and killed
 *  it, while the $68,200 sale card ("Nate (Son) Andy (Father) Dang") sat
 *  one tier deeper in token containment. Names still gate everything: the
 *  probe only visits tiers below the winner, so a probed card matched the
 *  customer by name (or shares the row's phone) either way.
 *  Callers should reach for matchReportRow instead — this alone is
 *  date-blind whenever a name tier produces exactly one candidate. */
export function bestSoldMatch(
  cards: SoldCardLite[],
  reportNorm: string,
  office: string | null,
  aroundISO: string | null,
  amounts: Array<number | null> = [],
  phone: string | null = null,
): SoldCardLite | null {
  if (!reportNorm) return null;
  const pool = office ? cards.filter((c) => c.office_location === office) : cards;
  // Order-insensitive tiers: "Muilwyk, Wolfgang & Trudi" (report) is
  // "Wolfgang and Trudi Muilwyk" (card). Exact sorted-token key after the
  // norm tiers, then full containment of the shorter name — the report
  // shortens "Norma(Daughter)& Jesus(Dad)&Rachel(mom) Miranda" to
  // "Miranda, Norma", so every one of the shorter side's tokens (≥2 of
  // them, at least one ≥4 chars as a surname-ish anchor) must appear in
  // the longer side. The phone tier stays last — see the Bunzal/Punzal
  // note above; it is only reached when every name tier found nothing.
  const tokens = customerTokens(reportNorm);
  const tkey = tokens.join(" ");
  const tset = new Set(tokens);
  const tiers: Array<() => SoldCardLite[]> = [
    () => pool.filter((c) => c._norm === reportNorm),
    () =>
      reportNorm.length >= 8
        ? pool.filter(
            (c) =>
              c._norm.length >= 8 &&
              (c._norm.startsWith(reportNorm) || reportNorm.startsWith(c._norm)),
          )
        : [],
    () => pool.filter((c) => c._tkey !== "" && c._tkey === tkey),
    () =>
      tokens.length >= 2
        ? pool.filter((c) => {
            const ctokens = c._tkey.split(" ").filter((t) => t !== "");
            if (ctokens.length < 2) return false;
            const [small, big] =
              ctokens.length <= tokens.length ? [ctokens, tset] : [tokens, new Set(ctokens)];
            return (
              small.length >= 2 &&
              small.some((t) => t.length >= 4) &&
              small.every((t) => big.has(t))
            );
          })
        : [],
    () =>
      phone !== null && phone !== ""
        ? pool.filter((c) => c._phone !== "" && c._phone === phone)
        : [],
  ];
  let cands: SoldCardLite[] = [];
  let tierIdx = tiers.length;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i]();
    if (t.length > 0) {
      cands = t;
      tierIdx = i;
      break;
    }
  }
  if (cands.length === 0) return null;
  const cents = new Set(
    amounts.filter((a): a is number => a !== null && a > 0).map((a) => Math.round(a * 100)),
  );
  const atAmount = (list: SoldCardLite[]) =>
    list.filter((c) => c.sale_price !== null && cents.has(Math.round(c.sale_price * 100)));
  let final = preferAmountMatch(cands, amounts);
  if (cents.size > 0 && atAmount(cands).length === 0) {
    // The Dang fallthrough (see the doc comment): the winning tier has no
    // card at the row's figure — a deeper tier's cents-exact card is the
    // better read. Without one, the winner stands unchanged.
    for (let i = tierIdx + 1; i < tiers.length; i++) {
      const exact = atAmount(tiers[i]());
      if (exact.length > 0) {
        final = exact;
        break;
      }
    }
  }
  if (final.length === 1 || !aroundISO) return final[0];
  const target = Date.parse(aroundISO);
  return final.reduce((best, c) => {
    const d = (x: SoldCardLite) =>
      x.card_date ? Math.abs(Date.parse(x.card_date) - target) : Number.MAX_SAFE_INTEGER;
    return d(c) < d(best) ? c : best;
  });
}

/** A label that kills the sale's volume: Cancelled, CTC (same bucket as a
 *  cancel — owner, 2026-07-30), or FTD (financial turn down — owner,
 *  2026-07-30). Keep in sync with the label tests in src/lib/close-kombat.ts
 *  and the SQL copies in notify_rep_sale (20260912230000) and
 *  mirror_wcc_cancel_to_leads (20260913010000) — the triggers use only the
 *  cancel/CTC arm, never FTD. */
export function isDeadLabel(v: string | null | undefined): boolean {
  return (
    /cancel/i.test(v ?? "") ||
    /\bctc\b/i.test(v ?? "") ||
    /\bftd\b/i.test(v ?? "") ||
    /financial\s*turn/i.test(v ?? "")
  );
}

/** Dead-label-wins merge for one card's matched report-row labels: a cancel
 *  (Cancelled or CTC — same bucket) sticks first, then an FTD, otherwise the
 *  first real label; otherwise null (heals a stale stamp when every matching
 *  row went back to unset). */
export function chooseWcc(values: Array<string | null>): string | null {
  const cancel = values.find((v) => /cancel/i.test(v ?? "") || /\bctc\b/i.test(v ?? ""));
  if (cancel) return cancel;
  const ftd = values.find((v) => /\bftd\b/i.test(v ?? "") || /financial\s*turn/i.test(v ?? ""));
  if (ftd) return ftd;
  return values.find((v) => v !== null) ?? null;
}

// ReportRepHit (one report row's evidence) and chooseReportReps (the
// best-single-row decision ladder) live in src/lib/close-kombat.ts so the
// verify suite can exercise them — this module drags in supabaseAdmin and
// can't be imported by a pure test script.

async function collectReportBoard(
  token: string,
  board: { id: string; name: string },
  soldCards: SoldCardLite[],
  matches: Map<string, ReportRepHit[]>,
  // stamp: run the wcc/report_reps matcher (SD/OC-prefixed boards only —
  // un-prefixed books have no Block cards and the date-blind fallback could
  // mis-bind). capture: every walked row lands here for report_sales.
  opts: { stamp: boolean; capture: ReportSaleInsert[] },
): Promise<WccReportResult> {
  const office = /^OC\b/i.test(board.name.trim())
    ? "Orange County"
    : /^SD\b/i.test(board.name.trim())
      ? "San Diego"
      : null;
  // Mid-month fallback for rows without a parseable Date Sold.
  const m = board.name.match(new RegExp(`(${MONTH_NAMES.join("|")})\\s+(\\d{4})`, "i"));
  const monthIdx = m ? MONTH_NAMES.findIndex((n) => n.toLowerCase() === m[1].toLowerCase()) + 1 : 0;
  const monthMidISO = m ? `${m[2]}-${String(monthIdx).padStart(2, "0")}-15` : null;
  // Month span [start, end) for the report_reps heal — only months that
  // walked successfully may clear stale stamps. Derived from the mid-month
  // date via the shared LA date helpers (dates.ts), not hand-rolled math.
  const reportMonthStart = monthMidISO ? monthStartISO(monthMidISO) : null;
  const reportMonthEnd = monthMidISO ? nextMonthStartISO(monthMidISO) : null;

  const result: WccReportResult = {
    board_id: board.id,
    name: board.name,
    rows: 0,
    cancelled: 0,
    unmatched: [],
    office,
    month_start: reportMonthStart,
    month_end: reportMonthEnd,
  };
  let sawRepsCol = false;

  // Pool order handed to matchReportRow: sold cards first, and for cancel rows
  // every card after them (a dead sale usually had its Sale cell reverted).
  const soldPool = soldCards.filter((c) => c.sold);
  const soldOnly = [soldPool];
  const soldThenAll = [soldPool, soldCards];

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
      : (((data.boards as Array<{ items_page: ItemsPage }> | null) ?? [])[0]?.items_page ?? null);
    if (!page) throw new Error("items_page missing from Monday response");

    for (const item of page.items ?? []) {
      const name = item.name == null ? "" : String(item.name);
      const cols: MondayCol[] = item.column_values ?? [];
      const wccRaw = (colText(cols, "wcc") ?? "").trim();
      // The WCC column is the ONLY cancel authority (owner, 2026-09-02):
      // "LVM"/"Completed" = good sale even when the row's Sales Count says
      // "Cancelled" — on a rescued deal Sales Count keeps recording the
      // pre-save cancellation (Hagmann/Pinel/Chemberlen, Aug '26), and the
      // 8/25 fallback that read it was killing exactly those saved deals.
      // The stamp keeps following the current WCC text, so a later label
      // change flips the card either way on the next pass.
      const wccStored = wccRaw === "" || /^none$/i.test(wccRaw) ? null : wccRaw;
      const dateSold = colText(cols, "date sold");
      // Only a REAL Date Sold may narrow by date; monthMidISO is a guess off
      // the board name (the 15th), so it stays a tiebreaker, never a filter.
      const saleDate = dateSold && !Number.isNaN(Date.parse(dateSold)) ? dateSold : null;
      // The row's "Sales Rep" people column (exact title — the boards also
      // carry a "Sales Rep count" formula this must not hit). One find
      // yields both the cell text and the column-presence fact: an
      // all-empty month is data, a never-resolving title is a rename that
      // must read as "unknown" downstream, never as "reps removed".
      const repsCol = cols.find(
        (c) => (c.column?.title || "").trim().toLowerCase() === "sales rep",
      );
      if (repsCol) sawRepsCol = true;
      const rowReps = cleanReps((repsCol?.text || "").split(","));
      // The row's dollar figures. Sale Amt feeds the best-row tiebreak in
      // chooseReportReps and NEVER becomes a card's sale_price; Cancel Amt
      // often holds a cancelled row's only figure. Both steer the matcher
      // toward the card priced at that figure when a repeat customer has
      // several cards in the date window (preferAmountMatch — Buford,
      // Aug '26). display_value covers a formula-typed money column,
      // matching findSalePriceCol's readers.
      const colMoney = (title: string) => {
        const c = cols.find((c) => (c.column?.title || "").trim().toLowerCase() === title);
        return parseMoney(c?.text || c?.display_value || "");
      };
      const rowAmt = colMoney("sale amt");
      const cancelAmt = colMoney("cancel amt");
      // report_sales mirror (owner, 2026-09-23): EVERY row captures — even
      // unnamed ones (the Shark Tank widgets sum the whole column, so a row
      // with money but no customer still counts) and $0 utility rows
      // ("Move each month" sums to nothing downstream). Blank money = $0,
      // never guessed. Skipped only when the board name yields no month —
      // report_month is the Year bucket and is never invented.
      if (reportMonthStart !== null) {
        opts.capture.push({
          monday_item_id: String(item.id),
          board_id: board.id,
          board_name: board.name,
          office,
          report_month: reportMonthStart,
          customer_name: name.trim() === "" ? null : name.trim(),
          date_sold: saleDate,
          sale_amt: rowAmt ?? 0,
          cancel_amt: cancelAmt ?? 0,
          wcc: wccStored,
          sales_count: colText(cols, "sales count"),
          phone: colText(cols, "phone"),
          reps: rowReps,
        });
      }
      // Capture-only boards stop here: the stamp matcher below must never
      // see a board with no Block-card era (see opts doc above).
      if (!opts.stamp) continue;
      if (!name.trim()) continue;
      result.rows += 1;
      // FTDs count with cancels here: both kill the sale, both may have had
      // the Block card's Sale cell reverted.
      const isCancel = isDeadLabel(wccStored);
      if (isCancel) result.cancelled += 1;
      // Unset rows still run the matcher: a previously stamped card heals
      // back to null when the report row un-cancels.
      // The row's phone digits, for the matcher's last-resort tier when the
      // two sides spell the customer differently (Bunzal/Punzal, Aug '26).
      const rowPhone = phoneKey(colText(cols, "phone"));
      // Non-cancel rows only stamp cards still marked sold; a CANCEL row
      // falls back to any card for that customer — the sale's Block card
      // usually had its Sale cell reverted when the job died.
      const norm = normalizeCustomer(name);
      const match = matchReportRow(
        isCancel ? soldThenAll : soldOnly,
        norm,
        office,
        saleDate,
        monthMidISO,
        [rowAmt, cancelAmt],
        rowPhone,
      );
      if (!match) {
        if (isCancel) result.unmatched.push(name);
        continue;
      }
      // Collect only — the caller merges every board's rows per card
      // (cancel-wins for wcc, best-single-row for report_reps) and writes
      // once.
      const list = matches.get(match.card.monday_item_id) ?? [];
      list.push({
        wcc: wccStored,
        amt: rowAmt,
        reps: rowReps,
        saleDate,
        dateTrue: match.dateTrue,
        repsKnown: repsCol !== undefined,
      });
      matches.set(match.card.monday_item_id, list);
    }
    cursor = page.cursor ?? null;
  } while (cursor);

  if (result.rows > 0 && !sawRepsCol) result.reps_column_missing = true;
  return result;
}
