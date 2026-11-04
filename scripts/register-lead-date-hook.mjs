// Register the Incoming Leads board's Lead Date webhook (plain
// change_column_value, unscoped — Monday rejects config on this event; the
// edge function filters to date8__1/dup__of_sd_lead server-side anyway).
// Companion to rotate-webhook-secret.mjs for the one hook it cannot carry.
//   MONDAY_WEBHOOK_SECRET=<current> SUPABASE_SERVICE_ROLE_KEY=<key> \
//     node scripts/register-lead-date-hook.mjs

const PROJECT_URL = "https://xogitpqeuwalerxygvjw.supabase.co";
const EDGE_BASE =
  `${PROJECT_URL}/functions/v1/monday-live-dispatch` +
  "?apikey=sb_publishable_ivjX0mrVvSLM1DHfDTDVuw_qHUtGeS2";
const LEADS_BOARD = "4155518549";

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.MONDAY_WEBHOOK_SECRET;
if (!SERVICE_KEY || !SECRET) {
  console.error("SUPABASE_SERVICE_ROLE_KEY and MONDAY_WEBHOOK_SECRET are required");
  process.exit(1);
}
const url = `${EDGE_BASE}&secret=${encodeURIComponent(SECRET)}`;

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

const [settings] = await rest("system_settings?select=id,monday_api_token,monday_webhooks&limit=1");
const token = settings?.monday_api_token;
if (!token) throw new Error("no monday token");
const registry = settings?.monday_webhooks ?? [];

const existing = await monday(token, `query ($b: ID!) { webhooks(board_id: $b) { id event } }`, {
  b: LEADS_BOARD,
});
if ((existing.webhooks ?? []).some((w) => w.event === "change_column_value")) {
  console.log("change_column_value hook already exists on the leads board — nothing to do");
  process.exit(0);
}

const data = await monday(
  token,
  `mutation ($b: ID!, $u: String!) { create_webhook(board_id: $b, url: $u, event: change_column_value) { id } }`,
  { b: LEADS_BOARD, u: url },
);
const id = String(data.create_webhook.id);
registry.push({
  board_id: LEADS_BOARD,
  webhook_id: id,
  event: "change_column_value",
  registered_at: new Date().toISOString(),
});
await rest(`system_settings?id=eq.${settings.id}`, {
  method: "PATCH",
  headers: { Prefer: "return=minimal" },
  body: JSON.stringify({ monday_webhooks: registry }),
});
console.log(`Lead Date hook registered: ${id} (registry updated)`);
