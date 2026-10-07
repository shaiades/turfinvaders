// Self-contained Monday GraphQL client (read + write) for the OOH write-back
// receiver — Deno runtime. Bounded retries on 429/5xx; mutations may carry a
// stable Idempotency-Key (Monday replays the first response for 30 min). The
// read-only live-dispatch client (../monday-live-dispatch/monday.ts) is kept
// separate on purpose: this one adds the write mutations the OOH flow needs,
// and the edge runtime cannot share modules across functions safely.
import {
  BLOCK_COL,
  SOURCE_CODE_COL_IDS,
  type ColMap,
  type DayItem,
  laWallMinutesFromUtc,
  normName,
} from "./engine.ts";
import {
  type DispatchLead,
  type LatLng,
  detectRequestedLanguage,
  firstName,
  isCanSaveMarker,
  isJobWalkMarker,
  isOlderHomeownerMarker,
  isRehashMarker,
} from "./dispatch.ts";

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
  /** Office the card belongs to, from the Office column (color_mm2yd84r): San
   *  Diego → "SD", Orange County → "OC". null when unreadable. Lets an old-block
   *  report reuse the card's office when auto-creating onto the current block. */
  office: "SD" | "OC" | null;
  source: string | null;
  sourceCode: number | null;
  details: string | null;
  apptWallMinutes: number | null;
  reps: string[];
  /** House coordinates (Monday Location column) — the rep's "last address" for
   *  live-dispatch drive-time. null when the card is unmapped. */
  coords: LatLng | null;
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
  // Both offices' Source Code ids — the OC id and the SD id differ; Monday
  // omits whichever the board doesn't have, so we read the code either way.
  ...SOURCE_CODE_COL_IDS,
  BLOCK_COL.details,
  BLOCK_COL.apptDateTime,
  BLOCK_COL.reps,
  BLOCK_COL.location,
  BLOCK_COL.office,
  BLOCK_COL.iss,
  BLOCK_COL.pm,
  BLOCK_COL.rs,
  BLOCK_COL.ol,
  BLOCK_COL.bo,
  BLOCK_COL.sale,
];

/** Parse a Monday Location column's value JSON ({lat,lng,address}) → LatLng.
 *  Monday stores lat/lng as strings; a (0,0) or unparseable value → null. */
export function parseLocation(value: string | null | undefined): LatLng | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as { lat?: string | number; lng?: string | number };
    const lat = typeof v.lat === "string" ? Number(v.lat) : v.lat;
    const lng = typeof v.lng === "string" ? Number(v.lng) : v.lng;
    if (!Number.isFinite(lat as number) || !Number.isFinite(lng as number)) return null;
    if (lat === 0 && lng === 0) return null;
    return { lat: lat as number, lng: lng as number };
  } catch {
    return null;
  }
}

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
  // Source Code: read whichever office's column this board actually has (only
  // one of the ids is ever present in the response — see BLOCK_READ_COLS).
  const sc = SOURCE_CODE_COL_IDS.map((id) => cols[id]?.text).find((t) => t != null) ?? "";
  const label = (id: string) => cols[id]?.text?.trim() || null;
  const officeText = cols[BLOCK_COL.office]?.text?.trim() ?? "";
  const office: "SD" | "OC" | null = /san\s*diego/i.test(officeText)
    ? "SD"
    : /orange/i.test(officeText)
      ? "OC"
      : null;
  return {
    id: String(it.id),
    name: String(it.name ?? ""),
    state: String(it.state ?? ""),
    boardId: String((it.board as { id?: string })?.id ?? ""),
    groupId: String((it.group as { id?: string })?.id ?? ""),
    office,
    source: cols[BLOCK_COL.source]?.text?.trim() || null,
    sourceCode: sc && Number.isFinite(Number(sc)) ? Number(sc) : null,
    details: cols[BLOCK_COL.details]?.text ?? null,
    apptWallMinutes: wallMinutesFromDate(
      cols[BLOCK_COL.apptDateTime]?.value ?? null,
      cols[BLOCK_COL.apptDateTime]?.text ?? null,
    ),
    coords: parseLocation(cols[BLOCK_COL.location]?.value ?? null),
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

// ═══════════════════════════════════════════════════════════════════════════
// LIVE DISPATCH reads/writes (Step 7). Attendance (who's working), today's block
// with coordinates + markers, Monday user ids (to write people6), and the
// people-column write that hands a rep their next lead. Board + column ids were
// read live 2026-10-04/05 from boards 5291879937 / 18411800909 (attendance) and
// 18432844990 (SD block).
// ═══════════════════════════════════════════════════════════════════════════

/** Rep Attendance boards (one per office). */
export const ATTENDANCE_BOARD: Record<"SD" | "OC", string> = {
  SD: "5291879937",
  OC: "18411800909",
};

/** Weekday (0=Sun..6=Sat) → {am,pm} attendance status column ids (identical on
 *  both office boards; read live 2026-10-05). Mirrors SHIFT_ATTENDANCE_COL in
 *  src/lib/respawn.ts — the Deno edge fn can't import from src/. Labels are
 *  "On"/"Off" and the index differs per column, so ALWAYS read by label text. */
const ATTENDANCE_SHIFT_COL: Record<number, { am: string; pm: string }> = {
  1: { am: "color0", pm: "dup__of_mon_am" }, // Monday
  2: { am: "status", pm: "dup__of_tuesday" }, // Tuesday
  3: { am: "dup__of_status", pm: "dup__of_wednesday" }, // Wednesday
  4: { am: "color", pm: "dup__of_thursday" }, // Thursday
  5: { am: "color2", pm: "dup__of_fri_am" }, // Friday
  6: { am: "color22", pm: "dup__of_sat_am" }, // Saturday
  0: { am: "color7", pm: "status_mkn3rnr9" }, // Sunday
};

export type Attendance = { amOn: boolean; pmOn: boolean; amOff: boolean; pmOff: boolean };

/** Read an office's attendance board for `weekday` → Map(normName → shifts).
 *  Rows are keyed by the employee's item name (the rep's display name). */
export async function fetchAttendance(
  token: string,
  office: "SD" | "OC",
  weekday: number,
): Promise<Map<string, Attendance>> {
  const cols = ATTENDANCE_SHIFT_COL[weekday] ?? ATTENDANCE_SHIFT_COL[1];
  const boardId = ATTENDANCE_BOARD[office];
  const { data } = await graphql(
    token,
    `
      query ($b: ID!, $cols: [String!]) {
        boards(ids: [$b]) {
          items_page(limit: 200) {
            items {
              id
              name
              column_values(ids: $cols) {
                id
                text
              }
            }
          }
        }
      }
    `,
    { b: boardId, cols: [cols.am, cols.pm] },
  );
  const items =
    ((data?.boards as Array<{ items_page?: { items?: Array<Record<string, unknown>> } }>) ?? [])[0]
      ?.items_page?.items ?? [];
  const out = new Map<string, Attendance>();
  for (const it of items) {
    const cv = (it.column_values as Array<{ id: string; text: string | null }>) ?? [];
    const amText = (cv.find((c) => c.id === cols.am)?.text ?? "").trim();
    const pmText = (cv.find((c) => c.id === cols.pm)?.text ?? "").trim();
    // Key by FIRST NAME: the SD board labels rows loosely ("Jaxon no day off
    // reply", "Nick S", "Josh O'Conner"), so a full-name key would never match
    // the form/people6 full name. First names are unique within an office.
    out.set(firstName(String(it.name ?? "")), {
      amOn: amText === "On",
      pmOn: pmText === "On",
      amOff: amText === "Off",
      pmOff: pmText === "Off",
    });
  }
  return out;
}

/** A day item enriched for the live-dispatch planner — a DispatchLead plus the
 *  disposition labels (so the caller can count a rep's OPEN leads with the
 *  engine's isOpenLead). `excludedReps`/`jobWalkReps` start empty; the edge fn
 *  fills them from the Supabase history mirrors. */
export type DispatchDayItem = DispatchLead & {
  pm: string | null;
  rs: string | null;
  ol: string | null;
  bo: string | null;
  sale: string | null;
};

const DISPATCH_DAY_COLS = [
  BLOCK_COL.reps,
  BLOCK_COL.iss,
  BLOCK_COL.apptDateTime,
  BLOCK_COL.location,
  BLOCK_COL.products,
  BLOCK_COL.reloads,
  BLOCK_COL.source,
  BLOCK_COL.agent,
  BLOCK_COL.comments,
  BLOCK_COL.details,
  BLOCK_COL.pm,
  BLOCK_COL.rs,
  BLOCK_COL.ol,
  BLOCK_COL.bo,
  BLOCK_COL.sale,
];

/** Fetch today's block day-group as DispatchDayItems (coords + markers + labels).
 *  The marker flags (rehash/can-save/job walk/language/older homeowner) are
 *  computed from the card's free text; history-based exclusions are added later. */
export async function fetchDispatchDayItems(
  token: string,
  boardId: string,
  groupId: string,
): Promise<DispatchDayItem[]> {
  const { data } = await graphql(
    token,
    `
      query ($b: ID!, $g: [String], $cols: [String!]) {
        boards(ids: [$b]) {
          groups(ids: $g) {
            items_page(limit: 200) {
              items {
                id
                name
                column_values(ids: $cols) {
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
    { b: boardId, g: [groupId], cols: DISPATCH_DAY_COLS },
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
    const products = (cols[BLOCK_COL.products]?.text ?? "")
      .split(/[,;]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    // Free-text pooled for marker + language scanning.
    const freeText = [
      cols[BLOCK_COL.source]?.text,
      cols[BLOCK_COL.agent]?.text,
      cols[BLOCK_COL.comments]?.text,
      cols[BLOCK_COL.details]?.text,
      cols[BLOCK_COL.reloads]?.text,
    ]
      .filter(Boolean)
      .join(" | ");
    const rsLabel = label(cols, BLOCK_COL.rs);
    const reloadsText = cols[BLOCK_COL.reloads]?.text ?? "";
    const isReset =
      /\brep\s*reset\b|\breset\b/i.test(reloadsText) ||
      /\breset\b/i.test(cols[BLOCK_COL.source]?.text ?? "") ||
      (rsLabel ?? "").toLowerCase() === "reset";
    return {
      itemId: String(it.id),
      name: String(it.name ?? ""),
      boardId,
      reps: (cols[BLOCK_COL.reps]?.text ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      issLabel: label(cols, BLOCK_COL.iss),
      apptWallMinutes: wallMinutesFromDate(
        cols[BLOCK_COL.apptDateTime]?.value ?? null,
        cols[BLOCK_COL.apptDateTime]?.text ?? null,
      ),
      coords: parseLocation(cols[BLOCK_COL.location]?.value ?? null),
      products,
      isReset,
      isJobWalk: isJobWalkMarker(freeText) || /\bjob\s*walk\b/i.test(reloadsText),
      isCanSave: isCanSaveMarker(freeText),
      isRehash: isRehashMarker(freeText),
      excludedReps: [],
      jobWalkReps: [],
      requestedLanguage: detectRequestedLanguage(freeText),
      olderHomeowner: isOlderHomeownerMarker(freeText),
      pm: label(cols, BLOCK_COL.pm),
      rs: rsLabel,
      ol: label(cols, BLOCK_COL.ol),
      bo: label(cols, BLOCK_COL.bo),
      sale: label(cols, BLOCK_COL.sale),
    };
  });
}

/** All active Monday users (id + name) — to resolve a rep name → the user id a
 *  people column write needs. Cached by the caller per invocation. */
export async function fetchMondayUsers(
  token: string,
): Promise<Array<{ id: string; name: string }>> {
  const { data } = await graphql(
    token,
    `
      query {
        users(kind: all, limit: 500) {
          id
          name
        }
      }
    `,
  );
  const users = (data?.users as Array<{ id?: string; name?: string }>) ?? [];
  return users
    .filter((u) => u.id && u.name)
    .map((u) => ({ id: String(u.id), name: String(u.name) }));
}

/** Resolve a rep display name to a Monday user id (exact, then first+last, then
 *  startsWith). null when no confident single match — the caller then routes to
 *  the managers rather than guessing who to assign. */
export function resolveUserId(
  users: Array<{ id: string; name: string }>,
  repName: string,
): string | null {
  const want = normName(repName);
  if (!want) return null;
  const exact = users.filter((u) => normName(u.name) === want);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null; // ambiguous — a human decides
  // first + last token match (handles a middle name on one side only).
  const [wf, wl] = [want.split(" ")[0], want.split(" ").slice(-1)[0]];
  const fl = users.filter((u) => {
    const n = normName(u.name);
    return n.split(" ")[0] === wf && n.split(" ").slice(-1)[0] === wl;
  });
  if (fl.length === 1) return fl[0].id;
  return null;
}

/** Write a people column (e.g. people6 Reps) with the given Monday user ids. */
export async function setPeopleColumn(
  token: string,
  boardId: string,
  itemId: string,
  columnId: string,
  userIds: string[],
  idempotencyKey?: string,
): Promise<MondayResult> {
  const personsAndTeams = userIds.map((id) => ({ id: Number(id), kind: "person" }));
  return graphql(
    token,
    `
      mutation ($b: ID!, $i: ID!, $vals: JSON!) {
        change_multiple_column_values(board_id: $b, item_id: $i, column_values: $vals) {
          id
        }
      }
    `,
    { b: boardId, i: itemId, vals: JSON.stringify({ [columnId]: { personsAndTeams } }) },
    idempotencyKey,
  );
}
