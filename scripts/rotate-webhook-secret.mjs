// Rotate the monday-live-dispatch webhook secret: re-register every hook in
// system_settings.monday_webhooks with a URL carrying the NEW secret.
//
// Why: the secret embedded in registered webhook URLs must match the edge
// function's MONDAY_WEBHOOK_SECRET, or every delivery fails the gate (found
// Nov 3: the Vercel and edge copies had drifted apart since July, masked by a
// pre-gate function build). Vercel's copy is write-only, so a rotation sets a
// fresh value on all three: edge secret, Vercel env, and the live hooks.
//
// This script does the hooks. Run it with the new value in env — the caller
// sets the edge secret and Vercel separately:
//   MONDAY_WEBHOOK_SECRET=<new> SUPABASE_SERVICE_ROLE_KEY=<key> \
//     node scripts/rotate-webhook-secret.mjs
//
// Safe while MONDAY_WEBHOOK_ENFORCE_SECRET=false (the gate logs mismatches
// but allows them), so rotate first, then flip enforcement on.

const PROJECT_URL = "https://xogitpqeuwalerxygvjw.supabase.co";
const EDGE_BASE =
  `${PROJECT_URL}/functions/v1/monday-live-dispatch` +
  "?apikey=sb_publishable_ivjX0mrVvSLM1DHfDTDVuw_qHUtGeS2";

const LEADS_BOARD = "4155518549";
const LEAD_STATUS_COL = "dup__of_sd_lead";
const LEAD_DATE_COL = "date8__1";

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NEW_SECRET = process.env.MONDAY_WEBHOOK_SECRET;
if (!SERVICE_KEY || !NEW_SECRET) {
  console.error("SUPABASE_SERVICE_ROLE_KEY and MONDAY_WEBHOOK_SECRET are required");
  process.exit(1);
}
const newUrl = `${EDGE_BASE}&secret=${encodeURIComponent(NEW_SECRET)}`;
if (newUrl.length > 255) {
  console.error(`webhook URL is ${newUrl.length} chars — Monday caps at 255`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(path, init = {}) {
  const resp = await fetch(`${PROJECT_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!resp.ok) throw new Error(`REST ${path} → ${resp.status} ${await resp.text()}`);
  return resp.status === 204 ? null : resp.json();
}

async function monday(token, query, variables) {
  const resp = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2024-10" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await resp.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 300));
  return json.data;
}

// Column-scoped hooks keep their scope (an unscoped change_column_value on
// the 6,700-item leads board would flood the function).
function configFor(boardId, event) {
  if (boardId !== LEADS_BOARD) return undefined;
  if (event === "change_status_column_value")
    return JSON.stringify({ columnId: LEAD_STATUS_COL, columnValue: { $any$: true } });
  if (event === "change_column_value")
    return JSON.stringify({ columnId: LEAD_DATE_COL, columnValue: { $any$: true } });
  return undefined;
}

const [settings] = await rest(
  "system_settings?select=id,monday_api_token,monday_webhooks&limit=1",
);
const token = settings?.monday_api_token;
const registry = settings?.monday_webhooks ?? [];
if (!token) throw new Error("system_settings.monday_api_token is empty");
if (!registry.length) throw new Error("monday_webhooks registry is empty — nothing to rotate");

const updated = [];
for (const entry of registry) {
  const { board_id, webhook_id, event } = entry;
  try {
    await monday(token, `mutation ($id: ID!) { delete_webhook(id: $id) { id } }`, {
      id: String(webhook_id),
    }).catch(() => {}); // already gone on Monday's side is fine
    const config = configFor(String(board_id), event);
    const query = config
      ? `mutation ($b: ID!, $u: String!, $e: WebhookEventType!, $c: JSON!) { create_webhook(board_id: $b, url: $u, event: $e, config: $c) { id } }`
      : `mutation ($b: ID!, $u: String!, $e: WebhookEventType!) { create_webhook(board_id: $b, url: $u, event: $e) { id } }`;
    const vars = { b: String(board_id), u: newUrl, e: event };
    if (config) vars.c = config;
    const data = await monday(token, query, vars);
    const newId = String(data.create_webhook.id);
    updated.push({ board_id, webhook_id: newId, event, registered_at: new Date().toISOString() });
    console.log(`rotated ${event} on ${board_id}: ${webhook_id} → ${newId}${config ? " (scoped)" : ""}`);
  } catch (err) {
    // Keep the old entry so a re-run can retry it; the old hook may already
    // be deleted, in which case the re-run recreates it.
    updated.push(entry);
    console.error(`FAIL ${event} on ${board_id}: ${err.message}`);
    process.exitCode = 1;
  }
  await sleep(300);
}

await rest(`system_settings?id=eq.${settings.id}`, {
  method: "PATCH",
  headers: { Prefer: "return=minimal" },
  body: JSON.stringify({ monday_webhooks: updated }),
});
console.log(`\nregistry updated: ${updated.length} hooks`);
if (process.exitCode) {
  console.error("Some hooks failed — safe to re-run this script with the same secret.");
}
