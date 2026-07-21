#!/usr/bin/env node
/**
 * Monday.com ops for the Turf Invaders migration (Node 22, zero deps).
 *
 * Commands:
 *   list-boards                      List boards (newest first) to pick backfill sources
 *   list-webhooks --board <id>      Show webhooks registered on a board
 *   register-active                  Register create_item + change_column_value webhooks
 *                                    on both active boards from system_settings
 *   register-webhooks --boards a,b   Same, for explicit board ids
 *   deregister-webhook --id <id>     Delete one webhook by id
 *   create-test-item --board <id> --agent "Name" [--name "ZZ Webhooktest"]
 *   delete-item --item <id>
 *   backfill --boards a,b --since YYYY-MM-DD --until YYYY-MM-DD
 *            [--apply] [--create-agents]        (dry-run is the default)
 *   reconcile [--apply] [--create-agents]       Backfill scoped to the CURRENT
 *                                    week (Mon..Sat, LA time) on the two active
 *                                    boards from system_settings. Covers events
 *                                    lost to webhook outages >30min (Monday
 *                                    retries once/min for 30min, then drops).
 *                                    Run after any suspected outage or weekly
 *                                    before payroll; dry-run default, no-op
 *                                    when nothing was missed. Past weeks: use
 *                                    backfill with explicit --boards/--since/--until.
 *
 * DB access via psql using DEST_DB_URL (or ~/.turf-dest-db-url).
 * The Monday token is read from system_settings in-process and never printed.
 *
 * Outcome mapping and column detection are ports of
 * supabase/functions/monday-live-dispatch/index.ts (keep in sync).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// ── args ────────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) {
    const k = rest[i].slice(2);
    const v = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
    args[k] = v;
  }
}
const die = (msg) => {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
};

// ── db helpers (psql) ───────────────────────────────────────────────────────
const DEST_DB_URL =
  process.env.DEST_DB_URL || readFileSync(join(homedir(), ".turf-dest-db-url"), "utf8").trim();
const PSQL = "/opt/homebrew/opt/postgresql@18/bin/psql";

function sqlRows(query) {
  const out = execFileSync(
    PSQL,
    [
      DEST_DB_URL,
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${query}) t`,
    ],
    { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
  );
  return JSON.parse(out.trim() || "[]");
}
function sqlExecFile(path) {
  execFileSync(PSQL, [DEST_DB_URL, "-v", "ON_ERROR_STOP=1", "-q", "-f", path], {
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, LC_ALL: "C" },
  });
}
const q = (s) => (s === null || s === undefined ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);

// ── monday client ───────────────────────────────────────────────────────────
// Env overrides: MONDAY_API_TOKEN skips the DB read; MONDAY_API_URL points the
// client at a mock server (used by the retry test harness).
const MONDAY_API = process.env.MONDAY_API_URL || "https://api.monday.com/v2";
let _token;
function mondayToken() {
  if (_token) return _token;
  _token = process.env.MONDAY_API_TOKEN;
  if (_token) return _token;
  const rows = sqlRows("SELECT monday_api_token FROM public.system_settings LIMIT 1");
  _token = rows[0]?.monday_api_token;
  if (!_token) die("no monday_api_token in system_settings");
  return _token;
}

// Retry policy (keep in sync with the edge fn's monday.ts and the
// rotate-boards cron route): HTTP 429/5xx, network failures, and GraphQL
// rate-limit/complexity/concurrency errors are retried up to MAX_ATTEMPTS,
// waiting the API's own hint (retry_in_seconds, Retry-After, or the RateLimit
// header's t=<reset-seconds>), exponential fallback, waits clamped to
// MAX_WAIT_S so a dead API can never tight-loop. Anything else (auth, bad
// query) dies immediately with the API's message. Mutations that must not
// double-fire on a retry pass an Idempotency-Key: Monday replays the first
// response for a repeated key for 30 minutes instead of re-executing.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE_GQL = /complexity|rate.?limit|concurrency|minute limit|call limit/i;
const MAX_ATTEMPTS = 3;
const MAX_WAIT_S = 60;
// Idempotency keys are scoped per process run: within a run a retried
// mutation dedupes, while a deliberate re-run (e.g. deregister + re-register
// inside the 30-minute replay window) still executes fresh.
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`;

function headerWaitSeconds(resp) {
  const ra = (resp.headers.get("retry-after") ?? "").trim();
  if (/^\d+$/.test(ra)) return Number(ra);
  const m = (resp.headers.get("ratelimit") ?? "").match(/(?:^|[;,\s])t=(\d+)/);
  return m ? Number(m[1]) : null;
}

// GraphQL error payload (current errors[].extensions shape or legacy
// top-level error_code/error_message): is it retryable, and how long does
// Monday ask us to wait?
function gqlRetryInfo(json) {
  const errs = Array.isArray(json?.errors) ? [...json.errors] : [];
  if (json?.error_code || json?.error_message)
    errs.push({ message: json.error_message, extensions: { code: json.error_code } });
  let retryable = false;
  let waitSeconds = null;
  for (const e of errs) {
    const code = String(e?.extensions?.code ?? "");
    const msg = String(e?.message ?? "");
    if (!RETRYABLE_GQL.test(code) && !RETRYABLE_GQL.test(msg)) continue;
    retryable = true;
    const hint = Number(e?.extensions?.retry_in_seconds ?? NaN);
    const parsed = Number.isFinite(hint) ? hint : Number((msg.match(/reset in (\d+)/i) ?? [])[1]);
    if (Number.isFinite(parsed)) waitSeconds = Math.max(waitSeconds ?? 0, parsed);
  }
  return { retryable, waitSeconds };
}

async function monday(query, variables, { idempotencyKey } = {}) {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp = null;
    let bodyText = "";
    let waitS = 2 ** attempt;
    try {
      resp = await fetch(MONDAY_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: mondayToken(),
          "API-Version": "2026-07",
          ...(idempotencyKey ? { "Idempotency-Key": `${idempotencyKey}-${RUN_ID}` } : {}),
        },
        body: JSON.stringify(variables ? { query, variables } : { query }),
      });
      bodyText = await resp.text();
    } catch (e) {
      lastError = `Monday API network error: ${e?.message ?? e}`;
      resp = null;
    }
    if (resp) {
      let json = null;
      try {
        json = JSON.parse(bodyText);
      } catch {
        /* non-JSON error body */
      }
      // 409 with an Idempotency-Key = the first send of this key is still
      // being processed; Retry-After says when its response will be ready.
      if (resp.status === 429 || resp.status >= 500 || (resp.status === 409 && idempotencyKey)) {
        lastError = `Monday API: HTTP ${resp.status}: ${bodyText.slice(0, 200)}`;
        waitS = headerWaitSeconds(resp) ?? gqlRetryInfo(json ?? {}).waitSeconds ?? 2 ** attempt;
      } else if (json && (json.errors || json.error_code || json.error_message)) {
        const { retryable, waitSeconds } = gqlRetryInfo(json);
        lastError = `Monday API: ${JSON.stringify(json.errors ?? json.error_message).slice(0, 500)}`;
        if (!retryable) die(lastError);
        waitS = waitSeconds ?? 2 ** attempt;
      } else if (json) {
        return json.data;
      } else {
        die(`Monday API: HTTP ${resp.status} non-JSON response: ${bodyText.slice(0, 200)}`);
      }
    }
    if (attempt === MAX_ATTEMPTS) break;
    const w = Math.min(waitS, MAX_WAIT_S);
    console.error(`# monday retry ${attempt}/${MAX_ATTEMPTS - 1} in ${w}s: ${lastError}`);
    await sleep(w * 1000);
  }
  die(`${lastError} (after ${MAX_ATTEMPTS} attempts)`);
}

// ── ports of the edge-function mapping logic (keep in sync) ─────────────────
const normalizeName = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");

function mapScheduleOutcome(columnTitle, value) {
  const col = (columnTitle || "").trim().toLowerCase();
  const v = (value || "").trim().toLowerCase();
  if (!v) return null;
  if (
    (col === "bo" || col.includes("blowout")) &&
    (v === "no show" || v === "no demo" || v === "bo")
  )
    return "blowouts";
  if ((col === "ol" || col.includes("outside lead")) && (v === "ol" || v === "outside lead"))
    return "outside_leads";
  if ((col === "rs" || col.includes("reset")) && (v === "reset" || v === "rs")) return "resets";
  if ((col === "pm" || col.includes("pitch missed")) && (v === "pm" || v.startsWith("pm")))
    return "pitch_missed";
  if ((col === "sale" || col.includes("sale")) && ["sold", "reload", "upsell", "sale"].includes(v))
    return "sales";
  if (v === "no show" || v === "no demo") return "blowouts";
  if (v === "ol") return "outside_leads";
  if (v === "reset") return "resets";
  if (v === "pm" || v === "pm w/ reset" || v === "pm w reset") return "pitch_missed";
  if (v === "sold" || v === "reload" || v === "upsell") return "sales";
  if (v === "confirmed" || v === "future reconf") return "leads_confirmed";
  if (v.startsWith("n/a")) return "no_answers";
  if (v === "blowout" || v === "disconnected") return "killed";
  if (v === "unconfirmed" || v === "future" || v === "room lead") return "pending";
  return null;
}
const OUTCOME_PRIORITY = [
  "sales",
  "pitch_missed",
  "resets",
  "blowouts",
  "killed",
  "outside_leads",
  "leads_confirmed",
  "no_answers",
  "pending",
];
// CSV-importer parity: per-item daily_logs counter vectors.
const LOG_VECS = {
  sales: { demos_sits: 1, sales: 1 },
  pitch_missed: { demos_sits: 1 },
  resets: { future_leads: 1 },
  blowouts: { no_demo: 1 },
  killed: { no_demo: 1 },
  outside_leads: { one_legs: 1 },
  leads_confirmed: { confirmed_leads: 1 },
  no_answers: {},
  pending: {},
};
const LOG_KEYS = [
  "no_demo",
  "one_legs",
  "future_leads",
  "demos_sits",
  "sales",
  "confirmed_leads",
  "unmarked",
];

function parseMoney(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n >= 1e10) return null;
  return Math.round(n * 100) / 100;
}
const norm = (s) => (s || "").trim().toLowerCase();
const findAgentCol = (cols) =>
  cols.find((c) => {
    const t = norm(c.column?.title);
    return t === "agent" || t.includes("agent") || t.includes("canvasser");
  });
const findSalePriceCol = (cols) =>
  cols.find((c) => norm(c.column?.title) === "sale price") ??
  cols.find((c) => norm(c.column?.title).replace(/\s+/g, "") === "saleprice") ??
  cols.find((c) => norm(c.column?.title).includes("price"));
const findDateCol = (cols) =>
  cols.find((c) => norm(c.column?.title) === "datetime") ??
  cols.find((c) => norm(c.column?.title) === "date") ??
  cols.find((c) => norm(c.column?.title).includes("date"));

function parseDateText(t) {
  if (!t) return null;
  const m1 = String(t).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
  const m2 = String(t).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m2) {
    const y = m2[3].length === 2 ? `20${m2[3]}` : m2[3];
    return `${y}-${String(m2[1]).padStart(2, "0")}-${String(m2[2]).padStart(2, "0")}`;
  }
  return null;
}

// ── item extraction ─────────────────────────────────────────────────────────
async function fetchBoardItems(boardId) {
  const items = [];
  let data = await monday(`query { boards(ids: [${boardId}]) { name items_page(limit: 100) {
    cursor items { id name created_at column_values { id text column { id title } } } } } }`);
  const board = data.boards?.[0];
  if (!board) die(`board ${boardId} not found/accessible`);
  let page = board.items_page;
  items.push(...page.items);
  while (page.cursor) {
    data =
      await monday(`query { next_items_page(cursor: ${JSON.stringify(page.cursor)}, limit: 100) {
      cursor items { id name created_at column_values { id text column { id title } } } } }`);
    page = data.next_items_page;
    items.push(...page.items);
  }
  return { boardName: board.name, items };
}

function mapItem(item) {
  const cols = item.column_values || [];
  const agent = (findAgentCol(cols)?.text || "").trim();
  const dateCol = findDateCol(cols);
  const date =
    parseDateText(dateCol?.text) || (item.created_at ? String(item.created_at).slice(0, 10) : null);
  const found = new Set();
  for (const c of cols) {
    const b = mapScheduleOutcome(c.column?.title || "", c.text || "");
    if (b) found.add(b);
  }
  const outcome = OUTCOME_PRIORITY.find((p) => found.has(p)) ?? null;
  const salePrice = parseMoney(findSalePriceCol(cols)?.text ?? "");
  return { id: String(item.id), name: item.name, agent, date, outcome, salePrice };
}

// ── canvasser resolution ────────────────────────────────────────────────────
function loadProfiles() {
  return sqlRows("SELECT id, display_name, team_id, office_location FROM public.profiles")
    .filter((p) => p.display_name)
    .map((p) => ({ ...p, _norm: normalizeName(p.display_name) }));
}
function matchProfile(profiles, agentName) {
  const wanted = normalizeName(agentName);
  return (
    profiles.find((p) => p._norm === wanted) ??
    profiles.find((p) => p._norm.includes(wanted)) ??
    profiles.find((p) => wanted.includes(p._norm)) ??
    (wanted.split(" ")[0]
      ? profiles.find((p) => p._norm.split(" ")[0] === wanted.split(" ")[0])
      : undefined)
  );
}

// ── commands ────────────────────────────────────────────────────────────────
async function cmdListBoards() {
  const data = await monday(
    "query { boards(limit: 100, order_by: created_at, state: all) { id name state items_count } }",
  );
  const boards = (data.boards || []).sort((a, b) => Number(b.id) - Number(a.id));
  console.log("id\tstate\titems\tname");
  for (const b of boards) console.log(`${b.id}\t${b.state}\t${b.items_count ?? "?"}\t${b.name}`);
}

async function cmdListWebhooks(boardId) {
  const data = await monday(`query { webhooks(board_id: ${boardId}) { id event config } }`);
  console.log(JSON.stringify(data.webhooks ?? [], null, 2));
}

// Shared secret enforced by the edge function. Never committed: read from env
// or ~/.turf-monday-webhook-secret (same pattern as DEST_DB_URL above).
const WEBHOOK_SECRET = (
  process.env.MONDAY_WEBHOOK_SECRET ||
  readFileSync(join(homedir(), ".turf-monday-webhook-secret"), "utf8")
).trim();
const EDGE_URL =
  "https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/monday-live-dispatch" +
  `?apikey=sb_publishable_ivjX0mrVvSLM1DHfDTDVuw_qHUtGeS2&secret=${WEBHOOK_SECRET}`;
if (EDGE_URL.length > 255)
  die(`EDGE_URL is ${EDGE_URL.length} chars — Monday caps webhook URLs at 255`);

async function registerOn(boardId) {
  const out = [];
  for (const event of ["create_item", "change_column_value"]) {
    const data = await monday(
      `mutation ($b: ID!, $u: String!, $e: WebhookEventType!) { create_webhook(board_id: $b, url: $u, event: $e) { id board_id } }`,
      { b: String(boardId), u: EDGE_URL, e: event },
      { idempotencyKey: `wh-${boardId}-${event}` },
    );
    const wh = data.create_webhook;
    if (!wh?.id) die(`create_webhook returned no id for board ${boardId} event ${event}`);
    out.push({
      board_id: String(boardId),
      webhook_id: String(wh.id),
      event,
      registered_at: new Date().toISOString(),
    });
    console.log(`registered ${event} on board ${boardId} -> webhook ${wh.id}`);
  }
  const patch = q(JSON.stringify(out));
  execFileSync(
    PSQL,
    [
      DEST_DB_URL,
      "-v",
      "ON_ERROR_STOP=1",
      "-qc",
      `UPDATE public.system_settings SET monday_webhooks = COALESCE(monday_webhooks,'[]'::jsonb) || ${patch}::jsonb`,
    ],
    { encoding: "utf8" },
  );
  return out;
}

async function cmdRegisterActive() {
  const s = sqlRows(
    "SELECT active_monday_board_oc, active_monday_board_sd FROM public.system_settings LIMIT 1",
  )[0];
  if (!s) die("no system_settings row");
  for (const [label, id] of [
    ["OC", s.active_monday_board_oc],
    ["SD", s.active_monday_board_sd],
  ]) {
    if (!id) {
      console.log(`(${label}: no active board id set — skipped)`);
      continue;
    }
    console.log(`--- ${label} board ${id}: existing webhooks ---`);
    await cmdListWebhooks(id);
    await registerOn(id);
  }
}

async function cmdCreateTestItem(boardId, agent, name) {
  const data = await monday(`query { boards(ids: [${boardId}]) { columns { id title type } } }`);
  const agentCol = (data.boards?.[0]?.columns || []).find((c) => {
    const t = norm(c.title);
    return t === "agent" || t.includes("agent") || t.includes("canvasser");
  });
  const colVals = agentCol ? JSON.stringify(JSON.stringify({ [agentCol.id]: agent })) : "null";
  const created = await monday(
    `mutation { create_item(board_id: ${boardId}, item_name: ${JSON.stringify(name)}, column_values: ${colVals}) { id } }`,
  );
  console.log(
    `created item ${created.create_item.id} on board ${boardId} (agent col: ${agentCol?.id ?? "NONE"})`,
  );
}

async function cmdDeleteItem(itemId) {
  await monday(`mutation { delete_item(item_id: ${itemId}) { id } }`);
  console.log(`deleted item ${itemId}`);
}

// ── backfill ────────────────────────────────────────────────────────────────
async function cmdBackfill() {
  const boards = String(args.boards || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const since = args.since,
    until = args.until;
  if (
    !boards.length ||
    !/^\d{4}-\d{2}-\d{2}$/.test(since || "") ||
    !/^\d{4}-\d{2}-\d{2}$/.test(until || "")
  )
    die(
      "usage: backfill --boards a,b --since YYYY-MM-DD --until YYYY-MM-DD [--apply] [--create-agents]",
    );

  // 1. Extract
  const all = [];
  for (const b of boards) {
    const { boardName, items } = await fetchBoardItems(b);
    console.error(`# board ${b} "${boardName}": ${items.length} items`);
    for (const it of items) all.push({ board: b, boardName, ...mapItem(it) });
  }
  const inSpan = all.filter((r) => r.date && r.date >= since && r.date <= until);
  const skippedNoAgent = inSpan.filter((r) => !r.agent);
  const rows = inSpan.filter((r) => r.agent);
  console.error(
    `# ${all.length} items total, ${inSpan.length} in span, ${skippedNoAgent.length} skipped (no agent)`,
  );

  // 2. Resolve canvassers
  let profiles = loadProfiles();
  const resolve = () => {
    const unknown = new Map();
    for (const r of rows) {
      const m = matchProfile(profiles, r.agent);
      if (m) {
        r.canvasser_id = m.id;
        r.team_id = m.team_id;
        r.office = m.office_location;
      } else unknown.set(normalizeName(r.agent), r.agent);
    }
    return unknown;
  };
  let unknown = resolve();
  if (unknown.size && args["create-agents"] && args.apply) {
    // Create placeholder profiles up front (Bouncer-style), then re-resolve so
    // the new agents' rows are included in the aggregation below.
    for (const name of unknown.values()) {
      execFileSync(
        PSQL,
        [
          DEST_DB_URL,
          "-v",
          "ON_ERROR_STOP=1",
          "-qc",
          `WITH np AS (INSERT INTO public.profiles (id, display_name, office_location, is_placeholder, team_id)
           VALUES (gen_random_uuid(), ${q(name)}, 'San Diego', true, NULL) RETURNING id)
         INSERT INTO public.user_roles (user_id, role) SELECT id, 'canvasser'::public.app_role FROM np`,
        ],
        { encoding: "utf8" },
      );
      console.error(`# created placeholder profile: ${name}`);
    }
    profiles = loadProfiles();
    unknown = resolve();
  }
  if (unknown.size) {
    console.error(
      `\nUNKNOWN AGENTS (${unknown.size})${args["create-agents"] ? "" : " — re-run with --create-agents to auto-create placeholders, or fix names"}:`,
    );
    for (const name of unknown.values()) console.error(`  - ${name}`);
    if (args.apply) die("aborting apply: unknown agents still present");
  }

  // 3. Aggregate
  const logs = new Map(); // key canvasser|date
  const sales = [];
  for (const r of rows) {
    if (!r.canvasser_id) continue;
    const key = `${r.canvasser_id}|${r.date}`;
    if (!logs.has(key))
      logs.set(key, {
        canvasser_id: r.canvasser_id,
        team_id: r.team_id,
        log_date: r.date,
        no_demo: 0,
        one_legs: 0,
        future_leads: 0,
        demos_sits: 0,
        sales: 0,
        confirmed_leads: 0,
        unmarked: 0,
      });
    const agg = logs.get(key);
    if (r.outcome) for (const [k, v] of Object.entries(LOG_VECS[r.outcome] || {})) agg[k] += v;
    else agg.unmarked += 1;
    if (r.outcome === "sales") sales.push(r);
  }

  // 4. Report
  const cur = sqlRows(`SELECT p.display_name AS agent, dl.log_date::text AS date,
      dl.no_demo, dl.one_legs, dl.future_leads, dl.demos_sits, dl.sales, dl.confirmed_leads, dl.unmarked
    FROM public.daily_logs dl JOIN public.profiles p ON p.id = dl.canvasser_id
    WHERE dl.log_date BETWEEN '${since}' AND '${until}' ORDER BY 1, 2`);
  const curLeads =
    sqlRows(`SELECT count(*)::int AS n, COALESCE(sum(sale_amount),0)::numeric AS total
    FROM public.leads WHERE status='confirmed' AND is_sale
      AND COALESCE(reviewed_at, created_at) BETWEEN '${since}T00:00:00Z' AND '${until}T23:59:59Z'`)[0];
  const nameOf = new Map(profiles.map((p) => [p.id, p.display_name]));
  console.log(
    `\n=== BACKFILL ${args.apply ? "APPLY" : "DRY RUN"} ${since}..${until} (boards: ${boards.join(", ")}) ===`,
  );
  console.log(`\n--- would write: per-agent/date daily_logs (${logs.size} rows) ---`);
  console.log("agent\tdate\tsits\tsales\tresets\tno_demo\tone_legs\tconf\tunmarked");
  for (const a of [...logs.values()].sort(
    (x, y) =>
      (nameOf.get(x.canvasser_id) || "").localeCompare(nameOf.get(y.canvasser_id) || "") ||
      x.log_date.localeCompare(y.log_date),
  ))
    console.log(
      `${nameOf.get(a.canvasser_id)}\t${a.log_date}\t${a.demos_sits}\t${a.sales}\t${a.future_leads}\t${a.no_demo}\t${a.one_legs}\t${a.confirmed_leads}\t${a.unmarked}`,
    );
  console.log(
    `\n--- would write: ${sales.length} confirmed sale leads (total $${sales.reduce((s, r) => s + (r.salePrice ?? 0), 0)}) ---`,
  );
  for (const s of sales)
    console.log(
      `${nameOf.get(s.canvasser_id)}\t${s.date}\t$${s.salePrice ?? "MISSING"}\t${s.name}\titem=${s.id}`,
    );
  console.log(
    `\n--- current DB in span (will be REPLACED): ${cur.length} daily_logs rows; ${curLeads.n} sale leads ($${curLeads.total}) ---`,
  );
  if (!args.apply) {
    console.log("\nDry run only. Re-run with --apply to execute.");
    return;
  }

  // 5. Apply — one transaction
  const dir = mkdtempSync(join(tmpdir(), "ti-backfill-"));
  const sqlPath = join(dir, "apply.sql");
  const stmts = ["BEGIN;"];
  stmts.push(`DELETE FROM public.daily_logs WHERE log_date BETWEEN '${since}' AND '${until}';`);
  const itemIds = sales.map((s) => q(s.id)).join(",") || `''`;
  stmts.push(`DELETE FROM public.leads WHERE (status='confirmed' AND is_sale
    AND COALESCE(reviewed_at, created_at) BETWEEN '${since}T00:00:00Z' AND '${until}T23:59:59Z')
    OR monday_item_id IN (${itemIds});`);
  for (const a of logs.values()) {
    stmts.push(`INSERT INTO public.daily_logs (canvasser_id, team_id, log_date, no_demo, one_legs, future_leads, demos_sits, sales, confirmed_leads, unmarked)
      VALUES (${q(a.canvasser_id)}, ${q(a.team_id)}, '${a.log_date}', ${a.no_demo}, ${a.one_legs}, ${a.future_leads}, ${a.demos_sits}, ${a.sales}, ${a.confirmed_leads}, ${a.unmarked})
      ON CONFLICT (canvasser_id, log_date) DO UPDATE SET no_demo=EXCLUDED.no_demo, one_legs=EXCLUDED.one_legs,
        future_leads=EXCLUDED.future_leads, demos_sits=EXCLUDED.demos_sits, sales=EXCLUDED.sales,
        confirmed_leads=EXCLUDED.confirmed_leads, unmarked=EXCLUDED.unmarked;`);
  }
  for (const s of sales) {
    stmts.push(`INSERT INTO public.leads (canvasser_id, team_id, status, is_sale, customer_name, sale_amount, created_at, reviewed_at, notes, monday_item_id)
      VALUES (${q(s.canvasser_id)}, ${q(s.team_id)}, 'confirmed', true, ${q(s.name)}, ${s.salePrice ?? "NULL"},
        '${s.date}T20:00:00Z', '${s.date}T20:00:00Z', 'Monday backfill', ${q(s.id)})
      ON CONFLICT (monday_item_id) DO UPDATE SET sale_amount=EXCLUDED.sale_amount, status='confirmed', deny_reason=NULL;`);
  }
  stmts.push("COMMIT;");
  writeFileSync(sqlPath, stmts.join("\n"));
  console.log(`\napplying ${stmts.length - 2} statements...`);
  sqlExecFile(sqlPath);

  // 6. Post pass: rank/pay refresh per canvasser (daily_logs trigger is dropped)
  const ids = [...new Set([...logs.values()].map((a) => a.canvasser_id))];
  for (const id of ids)
    execFileSync(PSQL, [DEST_DB_URL, "-Atqc", `SELECT public.refresh_canvasser_rank(${q(id)})`], {
      encoding: "utf8",
    });
  console.log(`refreshed rank/pay for ${ids.length} canvassers`);

  // 7. Duplicate guard
  const dups = sqlRows(`SELECT monday_item_id, count(*)::int AS n FROM public.leads
    WHERE monday_item_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1`);
  console.log(
    dups.length
      ? `!!! DUPLICATE monday_item_id rows: ${JSON.stringify(dups)}`
      : "duplicate guard clean ✓",
  );
}

// ── reconcile ───────────────────────────────────────────────────────────────
// Current week's Monday..Saturday in LA time, plus the board-name date token
// (M/DD/YY, same format the rotation cron uses when naming Block boards).
function laWeek() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = new Date(`${fmt.format(new Date())}T00:00:00Z`);
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
  const saturday = new Date(monday);
  saturday.setUTCDate(monday.getUTCDate() + 5);
  const iso = (d) => d.toISOString().slice(0, 10);
  const token = `${monday.getUTCMonth() + 1}/${String(monday.getUTCDate()).padStart(2, "0")}/${String(monday.getUTCFullYear()).slice(2)}`;
  return {
    since: iso(monday),
    until: iso(saturday),
    token,
    tokenLoose: token.replace("/0", "/"),
  };
}

async function cmdReconcile() {
  const s = sqlRows(
    "SELECT active_monday_board_sd, active_monday_board_oc FROM public.system_settings LIMIT 1",
  )[0];
  const boards = [s?.active_monday_board_sd, s?.active_monday_board_oc].filter(Boolean);
  if (boards.length < 2)
    die("active_monday_board_sd/oc missing in system_settings — run the board rotation first");
  const { since, until, token, tokenLoose } = laWeek();

  // Guard: the active boards must actually be THIS week's boards. If rotation
  // hasn't run yet, replace-semantics would wipe the current week's logs and
  // rebuild them from last week's board (whose items all fall outside the span).
  const data = await monday(`query { boards(ids: [${boards.join(",")}]) { id name } }`);
  for (const b of data.boards || []) {
    if (!b.name.includes(token) && !b.name.includes(tokenLoose))
      die(
        `active board ${b.id} "${b.name}" does not look like the current week (${token}). ` +
          `Has the Monday rotation run this week? For a past week use: backfill --boards ... --since ... --until ...`,
      );
  }

  args.boards = boards.join(",");
  args.since = since;
  args.until = until;
  console.error(
    `# reconcile: boards ${args.boards}, week ${since}..${until} (${args.apply ? "APPLY" : "dry run"})`,
  );
  await cmdBackfill();
}

// ── dispatch ────────────────────────────────────────────────────────────────
const run = {
  "list-boards": cmdListBoards,
  "list-webhooks": () => cmdListWebhooks(args.board || die("--board required")),
  "register-active": cmdRegisterActive,
  "register-webhooks": async () => {
    for (const b of String(args.boards || "")
      .split(",")
      .filter(Boolean))
      await registerOn(b);
  },
  "deregister-webhook": async () => {
    await monday(`mutation { delete_webhook(id: ${args.id || die("--id required")}) { id } }`);
    console.log("deleted");
  },
  "create-test-item": () =>
    cmdCreateTestItem(
      args.board || die("--board required"),
      args.agent || die("--agent required"),
      args.name || "ZZ Webhooktest",
    ),
  "delete-item": () => cmdDeleteItem(args.item || die("--item required")),
  "duplicate-board": async () => {
    const data = await monday(
      `mutation ($b: ID!, $n: String!) { duplicate_board(board_id: $b, duplicate_type: duplicate_board_with_structure, board_name: $n) { board { id name } } }`,
      {
        b: String(args.board || die("--board required")),
        n: String(args.name || die("--name required")),
      },
      { idempotencyKey: `dup-${args.board}` },
    );
    console.log(JSON.stringify(data.duplicate_board.board));
  },
  backfill: cmdBackfill,
  reconcile: cmdReconcile,
}[cmd];
if (!run) die(`unknown command "${cmd}". See header for usage.`);
await run();
