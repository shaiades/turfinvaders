#!/usr/bin/env node
/**
 * Backfill daily_metrics.leads_generated from the Monday "Incoming Leads"
 * board. A lead counts only if its card was BORN in the Inbound group
 * (group id "topics") — confirmers recycle old leads into other groups by
 * creating new cards, which must not credit.
 *
 * Cards get moved out of Inbound quickly, so the CURRENT group is useless
 * for history — this reads the board's activity log (create_pulse events
 * carry the birth group), then resolves each surviving card's Agent column.
 *
 * READ-ONLY against Monday; emits SQL on stdout for the owner to paste.
 * The SQL starts with a clean-slate reset for the window, then absolute
 * sets — safe to re-paste, and a re-run wholesale corrects prior numbers.
 * Run only for LA-dates STRICTLY BEFORE webhook activation.
 *
 * Usage:
 *   MONDAY_API_TOKEN=... node scripts/backfill-leads-generated.mjs \
 *     [--board 4155518549] [--days 7] [--before YYYY-MM-DD (LA, exclusive; default today-LA)]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1]] : null)).filter(Boolean),
);
const TOKEN = process.env.MONDAY_API_TOKEN || args.token;
if (!TOKEN) {
  console.error("MONDAY_API_TOKEN env (or --token) required");
  process.exit(1);
}
const BOARD = args.board || "4155518549";
const DAYS = Number(args.days || 7);
const INBOUND_GROUP = "topics";

const laDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);
const addDaysISO = (iso, n) => {
  const [y, m, dd] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dd, 12));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};
const BEFORE = args.before || laDate(new Date()); // exclusive
const SINCE = addDaysISO(BEFORE, -DAYS); // inclusive

const gql = async (query, variables) => {
  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors?.length) throw new Error(JSON.stringify(j.errors));
  return j.data;
};

const normalize = (s) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// Monday activity_logs created_at is a 17-digit timestamp (unix * 1e7).
const activityMs = (raw) => {
  const n = Number(raw);
  return String(raw).length >= 16 ? n / 1e4 : n * 1000;
};

// ── 1) Activity log: create_pulse events with their birth group ─────────────
const fromIso = new Date(Date.parse(`${SINCE}T00:00:00-08:00`) - 24 * 3600_000).toISOString();
const toIso = new Date().toISOString();
const born = new Map(); // pulseId -> laDate of creation (Inbound-born, in window)
const agentFromActivity = new Map(); // pulseId -> agent text seen in activity
let activityRows = 0, createEvents = 0, nonInbound = 0;
for (let page = 1; page <= 500; page++) {
  const data = await gql(
    `query ($b: ID!, $from: ISO8601DateTime!, $to: ISO8601DateTime!, $p: Int!) {
       boards(ids: [$b]) { activity_logs(from: $from, to: $to, limit: 100, page: $p) { event data created_at } }
     }`,
    { b: BOARD, from: fromIso, to: toIso, p: page },
  );
  const logs = data.boards?.[0]?.activity_logs ?? [];
  if (logs.length === 0) break;
  activityRows += logs.length;
  for (const l of logs) {
    let d;
    try { d = JSON.parse(l.data); } catch { continue; }
    const pulseId = String(d.pulse_id ?? d.pulseId ?? "");
    if (!pulseId) continue;
    if (l.event === "update_column_value" && String(d.column_id ?? "") === "text5") {
      // Cards that later get moved/deleted lose their item record — remember
      // the Agent text from the activity stream so they still credit.
      const txt = String(d.value?.value ?? d.textual_value ?? "").trim();
      if (txt && !agentFromActivity.has(pulseId)) agentFromActivity.set(pulseId, txt);
      continue;
    }
    if (l.event !== "create_pulse") continue;
    createEvents++;
    const groupId = String(d.group_id ?? d.groupId ?? "");
    if (groupId !== INBOUND_GROUP) { nonInbound++; continue; }
    const day = laDate(new Date(activityMs(l.created_at)));
    if (day < SINCE || day >= BEFORE) continue;
    if (!born.has(pulseId)) born.set(pulseId, day);
  }
}

// ── 2) Resolve Agent for the surviving cards ────────────────────────────────
const counts = new Map(); // agentNorm + tab + laDate -> n
let credited = 0, deleted = 0, blankAgents = 0, skippedCopies = 0, recoveredFromActivity = 0;
const ids = [...born.keys()];
for (let i = 0; i < ids.length; i += 100) {
  const chunk = ids.slice(i, i + 100);
  const data = await gql(
    `query ($ids: [ID!]) { items(ids: $ids, exclude_nonactive: false) { id name column_values(ids: ["text5"]) { text } } }`,
    { ids: chunk },
  );
  const byId = new Map((data.items ?? []).map((it) => [String(it.id), it]));
  for (const id of chunk) {
    const it = byId.get(id);
    if (it && /\(copy(\s+\d+)?\)\s*$/i.test(String(it.name ?? ""))) { skippedCopies++; continue; }
    const agent = normalize(it?.column_values?.[0]?.text) || normalize(agentFromActivity.get(id));
    if (!it && !agent) { deleted++; continue; }
    if (!agent) { blankAgents++; continue; }
    if (!it) recoveredFromActivity++;
    credited++;
    const key = agent + "\t" + born.get(id);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
}

console.error(
  `activityRows=${activityRows} createEvents=${createEvents} nonInboundBirths=${nonInbound} ` +
  `inboundInWindow=${born.size} credited=${credited} deleted=${deleted} blankAgents=${blankAgents} ` +
  `skippedCopies=${skippedCopies} recoveredFromActivity=${recoveredFromActivity} window=[${SINCE}, ${BEFORE})`,
);

const reset = `UPDATE public.daily_metrics SET leads_generated = 0
WHERE metric_date >= '${SINCE}' AND metric_date < '${BEFORE}';`;

if (counts.size === 0) {
  console.log(`-- No Inbound-born leads found in LA window [${SINCE}, ${BEFORE}).
-- Clean-slate reset only:
${reset}`);
  process.exit(0);
}

const values = [...counts.entries()]
  .map(([k, n]) => {
    const [agent, d] = k.split("\t");
    return `  ('${agent.replace(/'/g, "''")}', '${d}'::date, ${n})`;
  })
  .join(",\n");

console.log(`-- Backfill leads_generated from Incoming Leads board ${BOARD}
-- Inbound-BORN cards only (from the board activity log). LA-date window
-- [${SINCE}, ${BEFORE}) — strictly before webhook activation. Starts with a
-- clean-slate reset, then absolute sets: safe to re-paste.
${reset}

WITH gen(agent_norm, d, n) AS (
  VALUES
${values}
),
matched AS (
  SELECT g.agent_norm, g.d, g.n, p.id AS canvasser_id
  FROM gen g
  CROSS JOIN LATERAL (
    SELECT id FROM public.profiles p
    WHERE lower(regexp_replace(trim(p.display_name), '\\s+', ' ', 'g')) = g.agent_norm
    ORDER BY p.created_at ASC
    LIMIT 1
  ) p
)
INSERT INTO public.daily_metrics (canvasser_id, metric_date, leads_generated)
SELECT canvasser_id, d, n FROM matched
ON CONFLICT (canvasser_id, metric_date)
DO UPDATE SET leads_generated = EXCLUDED.leads_generated;

-- Unmatched agent names (create/rename profiles, then re-run for these):
WITH gen(agent_norm, d, n) AS (
  VALUES
${values}
)
SELECT g.agent_norm, g.d, g.n
FROM gen g
WHERE NOT EXISTS (
  SELECT 1 FROM public.profiles p
  WHERE lower(regexp_replace(trim(p.display_name), '\\s+', ' ', 'g')) = g.agent_norm
)
ORDER BY g.agent_norm, g.d;`);
