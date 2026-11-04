// Replay the Nov 2–? outage window through the monday-live-dispatch edge fn.
//
// Why: the Monday API token was swapped to the Dispatcher bot (user 120970699)
// on 2026-11-02 at 19:03 UTC, and the bot could not see the Incoming Leads
// board, so every webhook event's item re-fetch returned empty and the handler
// dropped it with HTTP 200 (Error_Monday_No_Item — Monday never retried).
// webhook_logs kept a 2_Payload_Parsed row per delivery, which carries enough
// (pulseId, boardId, columnId, status labels, isCreateEvent, triggerUuid) to
// rebuild each event. Posting them back runs the NORMAL ingestion path —
// outcome counters, payroll daily_logs, sale→leads sync, lead credits, dedupe
// markers — with production semantics. Idempotent: re-running is a stream of
// no-ops (triggerUuid guard + claim gates + unique credit indexes).
//
// A full-board sweep of the Block boards follows the event replay, exactly
// like scripts/replay-block-cards.mjs did for the week of 8/3: the new week's
// boards had no create_item webhooks until 11/3 13:30 UTC, so some cards never
// produced an event at all. Bare {pulseId, boardId} makes the edge fn re-fetch
// the card and record its current state. Block outcomes self-date to the
// card's BLOCK day while the board week is this week or last week — run this
// before Mon 11/9 06:00 PT so the 10/26 grace boards still self-date.
//
// Prereqs:
//   1. Dispatcher (120970699) must be able to read the Incoming Leads board
//      (4155518549) — verify webhook_logs shows hasItem:true before replaying.
//   2. system_settings.active_monday_board_sd/oc point at the crew boards
//      (verified 11/3: SD 18437949179, OC 18437949264).
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=<key> [MONDAY_WEBHOOK_SECRET=<secret>] \
//     node scripts/replay-outage-20261102.mjs [--dry-run] [--phase=events|sweep]
//
// --dry-run prints what would be posted without sending anything.

const PROJECT_URL = "https://xogitpqeuwalerxygvjw.supabase.co";
const EDGE_URL =
  `${PROJECT_URL}/functions/v1/monday-live-dispatch` +
  "?apikey=sb_publishable_ivjX0mrVvSLM1DHfDTDVuw_qHUtGeS2";

// First Error_Monday_No_Item after the token swap.
const WINDOW_START = "2026-11-02T19:03:29Z";

// Boards to sweep card-by-card (events alone can't cover the hook gaps).
// This week's boards from system_settings 11/3; last week's ("10/26 grace")
// from the 11/1 Webhook_Check log row.
const SWEEP_BOARDS = [
  { board: "18437949179", label: "SD Block 11/02/26-11/08/26" },
  { board: "18437949264", label: "OC Block 11/02/26 - 11/08/26" },
  { board: "18436881142", label: "SD Block 10/26 (grace)" },
  { board: "18436881031", label: "OC Block 10/26 (grace)" },
];

const INCOMING_LEADS_BOARD = "4155518549";
const LEAD_STATUS_COL = "dup__of_sd_lead";
const LEAD_DATE_COL = "date8__1";

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required");
  process.exit(1);
}
const DRY_RUN = process.argv.includes("--dry-run");
const phaseArg = (process.argv.find((a) => a.startsWith("--phase=")) ?? "").split("=")[1];
const RUN_EVENTS = !phaseArg || phaseArg === "events";
const RUN_SWEEP = !phaseArg || phaseArg === "sweep";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(path) {
  const resp = await fetch(`${PROJECT_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!resp.ok) throw new Error(`REST ${path} → ${resp.status} ${await resp.text()}`);
  return resp.json();
}

// ── 1. Pull every parsed delivery from the outage window ──────────────────
async function fetchParsedRows() {
  const rows = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const batch = await rest(
      `webhook_logs?step=eq.2_Payload_Parsed&created_at=gte.${WINDOW_START}` +
        `&select=created_at,data&order=created_at.asc&limit=${page}&offset=${offset}`,
    );
    rows.push(...batch);
    if (batch.length < page) break;
  }
  return rows;
}

function synthesize(rows) {
  // One event per (pulseId, columnId|'create'), keeping the LAST delivery —
  // the handler re-fetches the item and converges on current state, so
  // intermediate duplicates (the leads board fans every event out through
  // several registered hooks) add nothing.
  const byKey = new Map();
  let skipped = 0;
  for (const row of rows) {
    const d = row.data ?? {};
    const pulseId = d.pulseId != null ? String(d.pulseId) : "";
    if (!/^\d+$/.test(pulseId)) {
      skipped++;
      continue;
    }
    const boardId = String(d.boardId ?? "");
    const isCreate = d.isCreateEvent === true;
    const key = `${pulseId}:${isCreate ? "create" : d.changedColumnId ?? "none"}`;
    const event = { pulseId, boardId };
    if (isCreate) event.type = "create_pulse";
    if (!isCreate && d.changedColumnId) event.columnId = String(d.changedColumnId);
    if (d.statusFromEvent) event.value = { label: { text: String(d.statusFromEvent) } };
    if (d.previousStatusFromEvent)
      event.previousValue = { label: { text: String(d.previousStatusFromEvent) } };
    if (d.triggerUuid) event.triggerUuid = String(d.triggerUuid);
    byKey.set(key, { event, at: row.created_at });
  }
  return { events: [...byKey.values()], skipped };
}

function orderEvents(events) {
  // Leads-board creates first (once-per-item credit), then Lead Status, then
  // Lead Date, then everything else (block outcomes) — chronological inside
  // each bucket.
  const bucket = ({ event: e }) => {
    if (e.boardId !== INCOMING_LEADS_BOARD) return 4;
    if (e.type === "create_pulse") return 0;
    if (e.columnId === LEAD_STATUS_COL) return 1;
    if (e.columnId === LEAD_DATE_COL) return 2;
    return 3;
  };
  return events.sort((a, b) => bucket(a) - bucket(b) || a.at.localeCompare(b.at));
}

// ── 2. Enumerate current cards on the Block boards for the sweep ──────────
async function fetchMondayToken() {
  const [settings] = await rest("system_settings?select=monday_api_token&limit=1");
  const token = settings?.monday_api_token;
  if (!token) throw new Error("system_settings.monday_api_token is empty");
  return token;
}

async function listBoardItems(token, boardId) {
  const items = [];
  let cursor = null;
  do {
    const args = cursor ? `cursor: "${cursor}"` : `limit: 100`;
    const query = cursor
      ? `{ next_items_page(${args}) { cursor items { id } } }`
      : `{ boards(ids: [${boardId}]) { items_page(${args}) { cursor items { id } } } }`;
    const resp = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2024-10" },
      body: JSON.stringify({ query }),
    });
    const json = await resp.json();
    if (json.errors) throw new Error(`Monday ${boardId}: ${JSON.stringify(json.errors).slice(0, 300)}`);
    const pageData = cursor ? json.data?.next_items_page : json.data?.boards?.[0]?.items_page;
    for (const it of pageData?.items ?? []) items.push(String(it.id));
    cursor = pageData?.cursor ?? null;
    await sleep(200);
  } while (cursor);
  return items;
}

// ── 3. POST events through the production path ────────────────────────────
async function post(event) {
  const secret = process.env.MONDAY_WEBHOOK_SECRET;
  const url = secret ? `${EDGE_URL}&secret=${encodeURIComponent(secret)}` : EDGE_URL;
  const body = JSON.stringify({ event });
  for (let attempt = 1; ; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const text = (await resp.text()).slice(0, 120);
    if (resp.status !== 502 || attempt === 2) return { status: resp.status, text };
    await sleep(3000); // transient Monday API error — one retry
  }
}

async function replay(label, events) {
  let ok = 0;
  let failed = 0;
  const tally = new Map();
  for (const { event } of events) {
    if (DRY_RUN) {
      console.log(`[dry] ${label} ${JSON.stringify(event)}`);
      continue;
    }
    const { status, text } = await post(event);
    tally.set(text, (tally.get(text) ?? 0) + 1);
    if (status === 200) ok++;
    else {
      failed++;
      console.error(`FAIL ${label} ${event.boardId} ${event.pulseId} → ${status} ${text}`);
    }
    await sleep(300); // stay well inside Monday API rate limits
  }
  console.log(`\n${label}: ${ok} ok, ${failed} failed of ${events.length}`);
  for (const [text, n] of [...tally.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(5)} × ${text}`);
  return failed;
}

// ── main ───────────────────────────────────────────────────────────────────
let failures = 0;

if (RUN_EVENTS) {
  const rows = await fetchParsedRows();
  const { events, skipped } = synthesize(rows);
  orderEvents(events);
  const leads = events.filter((e) => e.event.boardId === INCOMING_LEADS_BOARD);
  const other = events.filter((e) => e.event.boardId !== INCOMING_LEADS_BOARD);
  console.log(
    `${rows.length} deliveries since ${WINDOW_START} → ${events.length} unique events ` +
      `(${leads.length} leads-board, ${other.length} block/other, ${skipped} skipped bad pulseId)`,
  );
  failures += await replay("events", events);
}

if (RUN_SWEEP) {
  const token = await fetchMondayToken();
  for (const { board, label } of SWEEP_BOARDS) {
    let ids;
    try {
      ids = await listBoardItems(token, board);
    } catch (err) {
      console.error(`SWEEP SKIPPED ${label}: ${err.message}`);
      failures++;
      continue;
    }
    console.log(`\nsweep ${label} (${board}): ${ids.length} cards`);
    failures += await replay(
      `sweep ${board}`,
      ids.map((pulseId) => ({ event: { pulseId, boardId: board }, at: "" })),
    );
  }
}

if (failures > 0) {
  console.error(
    "\nFailures above did not write counters — safe to re-run this script; " +
      "already-processed events no-op.",
  );
  process.exit(1);
}
