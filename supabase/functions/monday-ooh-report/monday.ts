// Self-contained Monday GraphQL client (read + write) for the OOH write-back
// receiver — Deno runtime. Bounded retries on 429/5xx; mutations may carry a
// stable Idempotency-Key (Monday replays the first response for 30 min). The
// read-only live-dispatch client (../monday-live-dispatch/monday.ts) is kept
// separate on purpose: this one adds the write mutations the OOH flow needs,
// and the edge runtime cannot share modules across functions safely.
import { BLOCK_COL, type ColMap, type DayItem, laWallMinutesFromUtc, normName } from "./engine.ts";

const denoEnv = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno
  ?.env;
const MONDAY_API_URL = denoEnv?.get("MONDAY_API_URL") ?? "https://api.monday.com/v2";
const API_VERSION = "2026-07";
const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 8_000;
const RETRYABLE_GQL = /complexity|rate.?limit|concurrency|minute limit|call limit/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type MondayResult = { data: Record<string, unknown> | null; error: string | null };

async function graphql(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<MondayResult> {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp: Response | null = null;
    let bodyText = "";
    const waitMs = 2 ** attempt * 1000;
    try {
      resp = await fetch(MONDAY_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
          "API-Version": API_VERSION,
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify(variables ? { query, variables } : { query }),
      });
      bodyText = await resp.text();
    } catch (e) {
      lastError = `network error: ${e instanceof Error ? e.message : String(e)}`;
      resp = null;
    }
    if (resp) {
      let json: { data?: Record<string, unknown>; errors?: unknown } | null = null;
      try {
        json = JSON.parse(bodyText);
      } catch {
        /* non-JSON */
      }
      if (resp.status === 429 || resp.status >= 500 || (resp.status === 409 && idempotencyKey)) {
        lastError = `HTTP ${resp.status}: ${bodyText.slice(0, 200)}`;
      } else if (json && json.errors) {
        const msg = JSON.stringify(json.errors).slice(0, 300);
        if (!RETRYABLE_GQL.test(msg)) return { data: null, error: msg };
        lastError = msg;
      } else if (json) {
        return { data: json.data ?? null, error: null };
      } else {
        lastError = `HTTP ${resp.status}: non-JSON response`;
      }
    }
    if (attempt === MAX_ATTEMPTS || waitMs > MAX_WAIT_MS) break;
    await sleep(waitMs);
  }
  return { data: null, error: lastError };
}

function colMapOf(
  columnValues: Array<{ id: string; text: string | null; value: string | null }>,
): ColMap {
  const m: ColMap = {};
  for (const c of columnValues ?? []) m[c.id] = { text: c.text ?? null, value: c.value ?? null };
  return m;
}

export type FormItem = {
  id: string;
  name: string;
  createdAtMs: number;
  boardId: string;
  cols: ColMap;
};

/** Fetch the submitted form item's full column values. */
export async function fetchFormItem(token: string, itemId: string): Promise<FormItem | null> {
  const { data } = await graphql(
    token,
    `
      query ($ids: [ID!]) {
        items(ids: $ids) {
          id
          name
          created_at
          board {
            id
          }
          column_values {
            id
            text
            value
          }
        }
      }
    `,
    { ids: [itemId] },
  );
  const it = ((data?.items as Array<Record<string, unknown>>) ?? [])[0];
  if (!it) return null;
  return {
    id: String(it.id),
    name: String(it.name ?? ""),
    createdAtMs: it.created_at ? Date.parse(String(it.created_at)) : Date.now(),
    boardId: String((it.board as { id?: string })?.id ?? ""),
    cols: colMapOf(
      it.column_values as Array<{ id: string; text: string | null; value: string | null }>,
    ),
  };
}

export type BlockItem = {
  id: string;
  name: string;
  state: string;
  boardId: string;
  groupId: string;
  source: string | null;
  sourceCode: number | null;
  details: string | null;
  apptWallMinutes: number | null;
  reps: string[];
  // Current disposition column labels (for the already-dispositioned guard).
  iss: string | null;
  pm: string | null;
  rs: string | null;
  ol: string | null;
  bo: string | null;
  sale: string | null;
};

const BLOCK_READ_COLS = [
  BLOCK_COL.source,
  BLOCK_COL.sourceCode,
  BLOCK_COL.details,
  BLOCK_COL.apptDateTime,
  BLOCK_COL.reps,
  BLOCK_COL.iss,
  BLOCK_COL.pm,
  BLOCK_COL.rs,
  BLOCK_COL.ol,
  BLOCK_COL.bo,
  BLOCK_COL.sale,
];

function wallMinutesFromDate(value: string | null, text: string | null): number | null {
  // date9 value JSON: {date,time} in UTC (Monday stores date columns in UTC).
  // Convert to LA wall-minutes — reading the UTC time raw mis-orders late-day
  // appointments (5:30 PM PT is stored "00:30" the NEXT UTC day). All items in
  // one day group share a date, so LA wall-minutes is a valid ordering key.
  try {
    if (value) {
      const v = JSON.parse(value) as { date?: string | null; time?: string | null };
      const la = laWallMinutesFromUtc(v.date ?? null, v.time ?? null);
      if (la != null) return la;
    }
  } catch {
    /* fall through */
  }
  // Fallback: `text` is already rendered in the account's timezone (Pacific).
  const m = (text ?? "").match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Fetch one block item (the report target). */
export async function fetchBlockItem(token: string, itemId: string): Promise<BlockItem | null> {
  const { data } = await graphql(
    token,
    `
      query ($ids: [ID!], $cols: [String!]) {
        items(ids: $ids) {
          id
          name
          state
          board {
            id
          }
          group {
            id
          }
          column_values(ids: $cols) {
            id
            text
            value
          }
        }
      }
    `,
    { ids: [itemId], cols: BLOCK_READ_COLS },
  );
  const it = ((data?.items as Array<Record<string, unknown>>) ?? [])[0];
  if (!it) return null;
  const cols = colMapOf(
    it.column_values as Array<{ id: string; text: string | null; value: string | null }>,
  );
  const sc = cols[BLOCK_COL.sourceCode]?.text ?? "";
  const label = (id: string) => cols[id]?.text?.trim() || null;
  return {
    id: String(it.id),
    name: String(it.name ?? ""),
    state: String(it.state ?? ""),
    boardId: String((it.board as { id?: string })?.id ?? ""),
    groupId: String((it.group as { id?: string })?.id ?? ""),
    source: cols[BLOCK_COL.source]?.text?.trim() || null,
    sourceCode: sc && Number.isFinite(Number(sc)) ? Number(sc) : null,
    details: cols[BLOCK_COL.details]?.text ?? null,
    apptWallMinutes: wallMinutesFromDate(
      cols[BLOCK_COL.apptDateTime]?.value ?? null,
      cols[BLOCK_COL.apptDateTime]?.text ?? null,
    ),
    reps: (cols[BLOCK_COL.reps]?.text ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    iss: label(BLOCK_COL.iss),
    pm: label(BLOCK_COL.pm),
    rs: label(BLOCK_COL.rs),
    ol: label(BLOCK_COL.ol),
    bo: label(BLOCK_COL.bo),
    sale: label(BLOCK_COL.sale),
  };
}

/** Every item in one block day-group, shaped for the release planner. */
export async function fetchDayGroupItems(
  token: string,
  boardId: string,
  groupId: string,
): Promise<DayItem[]> {
  const { data } = await graphql(
    token,
    `
      query ($b: ID!, $g: [String]) {
        boards(ids: [$b]) {
          groups(ids: $g) {
            items_page(limit: 200) {
              items {
                id
                column_values(
                  ids: [
                    "people6"
                    "status"
                    "date9"
                    "status_1"
                    "status_2"
                    "status_3"
                    "status4"
                    "status9"
                  ]
                ) {
                  id
                  text
                  value
                }
              }
            }
          }
        }
      }
    `,
    { b: boardId, g: [groupId] },
  );
  const boards =
    (data?.boards as Array<{
      groups?: Array<{ items_page?: { items?: Array<Record<string, unknown>> } }>;
    }>) ?? [];
  const items = boards[0]?.groups?.[0]?.items_page?.items ?? [];
  const label = (c: ColMap, id: string) => c[id]?.text?.trim() || null;
  return items.map((it) => {
    const cols = colMapOf(
      it.column_values as Array<{ id: string; text: string | null; value: string | null }>,
    );
    return {
      id: String(it.id),
      reps: (cols["people6"]?.text ?? "")
        .split(",")
        .map((s) => normName(s))
        .filter(Boolean),
      statusLabel: label(cols, BLOCK_COL.iss),
      timeMs: wallMinutesFromDate(cols["date9"]?.value ?? null, cols["date9"]?.text ?? null),
      pm: label(cols, BLOCK_COL.pm),
      rs: label(cols, BLOCK_COL.rs),
      ol: label(cols, BLOCK_COL.ol),
      bo: label(cols, BLOCK_COL.bo),
      sale: label(cols, BLOCK_COL.sale),
    };
  });
}

/** change_multiple_column_values — the FIRST write (non-status fields). */
export async function setColumns(
  token: string,
  boardId: string,
  itemId: string,
  values: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<MondayResult> {
  return graphql(
    token,
    `
      mutation ($b: ID!, $i: ID!, $vals: JSON!) {
        change_multiple_column_values(board_id: $b, item_id: $i, column_values: $vals) {
          id
        }
      }
    `,
    { b: boardId, i: itemId, vals: JSON.stringify(values) },
    idempotencyKey,
  );
}

/** Press ONE status by label — the SECOND write (the disposition / Iss). */
export async function setStatus(
  token: string,
  boardId: string,
  itemId: string,
  col: string,
  label: string,
  idempotencyKey?: string,
): Promise<MondayResult> {
  return graphql(
    token,
    `
      mutation ($b: ID!, $i: ID!, $vals: JSON!) {
        change_multiple_column_values(board_id: $b, item_id: $i, column_values: $vals) {
          id
        }
      }
    `,
    { b: boardId, i: itemId, vals: JSON.stringify({ [col]: { label } }) },
    idempotencyKey,
  );
}

/** Post a Monday update (activity-log note) on the block item. The caller passes
 *  a per-SUBMISSION idempotency key (keyed by the form item id) — keying by the
 *  block item id made a SECOND report on the same lead replay the first and the
 *  note was dropped. */
export async function postUpdate(
  token: string,
  itemId: string,
  body: string,
  idempotencyKey: string,
): Promise<MondayResult> {
  return graphql(
    token,
    `
      mutation ($i: ID!, $b: String!) {
        create_update(item_id: $i, body: $b) {
          id
        }
      }
    `,
    { i: itemId, b: body },
    idempotencyKey,
  );
}

/** Create a new block item (self-gen / upsell / reload). */
export async function createItem(
  token: string,
  boardId: string,
  groupId: string,
  name: string,
  values: Record<string, unknown>,
  idempotencyKey: string,
): Promise<string | null> {
  const { data } = await graphql(
    token,
    `
      mutation ($b: ID!, $g: String!, $n: String!, $vals: JSON!) {
        create_item(board_id: $b, group_id: $g, item_name: $n, column_values: $vals) {
          id
        }
      }
    `,
    { b: boardId, g: groupId, n: name, vals: JSON.stringify(values) },
    idempotencyKey,
  );
  const id = (data?.create_item as { id?: string })?.id;
  return id ? String(id) : null;
}
