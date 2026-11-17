// Replay the week-of-11/16/26 Block boards through monday-live-dispatch.
//
// Why: the Mon 11/16 13:00 UTC rotation (and every 13:30 daily check since)
// died in edgeUrl() — the Vercel Production MONDAY_WEBHOOK_SECRET held a
// 191-char bad paste, pushing the hook URL to 327 chars over Monday's 255
// cap — so the crews' new-week boards (SD 18439987115 "SD Block
// 11/16/26-11/22/26", OC 18439987351 "OC Block 11/16/26 - 11/22/26") were
// never adopted: no create_item/change_column_value hooks, settings still on
// the 11/9 boards. Every outcome marked on them reached nobody; there are no
// webhook_logs deliveries to rebuild from, so unlike the 11/2 replay there is
// no events phase — a full-board sweep is the whole recovery.
//
// Each card is posted as a bare {pulseId, boardId} synthetic event; the edge
// function re-fetches the card and runs the NORMAL ingestion path — outcome
// counters, payroll daily_logs, sale→leads sync, block_cards snapshot — with
// production semantics, and self-dates Block outcomes to the card's BLOCK day
// (board-week Monday + weekday group) while the board week is this week or
// last week. Idempotent: re-running is a stream of no-ops.
//
// Prereqs (the script verifies #1 and refuses to run until it holds):
//   1. system_settings.active_monday_board_sd/oc point at the 11/16 boards —
//      i.e. the rotation has succeeded after the Vercel secret was fixed
//      (13:30 UTC daily check, or hit /api/internal/rotate-boards with the
//      CRON_SECRET). Without it the edge fn can't resolve the office and the
//      block_cards snapshot is skipped.
//   2. Run before Mon 11/23 06:00 PT so the boards still self-date.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=<key> MONDAY_WEBHOOK_SECRET=<secret> \
//     node scripts/replay-week-20261116.mjs [--dry-run]

const PROJECT_URL = "https://xogitpqeuwalerxygvjw.supabase.co";
const EDGE_URL =
  `${PROJECT_URL}/functions/v1/monday-live-dispatch` +
  "?apikey=sb_publishable_ivjX0mrVvSLM1DHfDTDVuw_qHUtGeS2";

const SWEEP_BOARDS = [
  { board: "18439987115", office: "sd", label: "SD Block 11/16/26-11/22/26" },
  { board: "18439987351", office: "oc", label: "OC Block 11/16/26 - 11/22/26" },
];

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required");
  process.exit(1);
}
const DRY_RUN = process.argv.includes("--dry-run");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(path) {
  const resp = await fetch(`${PROJECT_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!resp.ok) throw new Error(`REST ${path} → ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function assertSettingsRepointed() {
  const [settings] = await rest(
    "system_settings?select=active_monday_board_sd,active_monday_board_oc,monday_api_token&limit=1",
  );
  for (const { board, office, label } of SWEEP_BOARDS) {
    const active = String(settings?.[`active_monday_board_${office}`] ?? "");
    if (active !== board) {
      throw new Error(
        `system_settings.active_monday_board_${office} is "${active}", not ${board} (${label}) — ` +
          "rotation hasn't adopted the 11/16 boards yet. Fix the Vercel secret, run the " +
          "rotation (13:30 UTC check or the cron route), then re-run this script.",
      );
    }
  }
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
const token = await assertSettingsRepointed();
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

if (failures > 0) {
  console.error(
    "\nFailures above did not write counters — safe to re-run this script; " +
      "already-processed events no-op.",
  );
  process.exit(1);
}
