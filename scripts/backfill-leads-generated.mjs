#!/usr/bin/env node
/**
 * Backfill daily_metrics.leads_generated from the Monday "Incoming Leads"
 * board (created_at of each item = when the lead was generated).
 *
 * READ-ONLY against Monday; emits SQL on stdout for the owner to paste in the
 * Supabase SQL editor. Name→profile matching happens in SQL at paste time
 * (normalized exact match); a trailing SELECT lists unmatched agent names.
 *
 * Emits ABSOLUTE sets (DO UPDATE SET leads_generated = EXCLUDED.leads_generated)
 * so re-pastes are idempotent — run it only for LA-dates STRICTLY BEFORE the
 * webhook activation date, or live credits would be overwritten.
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

let cursor = null;
const counts = new Map(); // `${agentNorm}\t${laDate}` -> n
let scanned = 0, skippedCopies = 0, skippedNonInbound = 0, blankAgents = 0, inWindow = 0;

for (;;) {
  const q = cursor
    ? `query ($c: String!) { next_items_page(cursor: $c, limit: 500) { cursor items { id name created_at group { id title } column_values(ids: ["text5"]) { text } } } }`
    : `query ($b: [ID!]) { boards(ids: $b) { items_page(limit: 500) { cursor items { id name created_at group { id title } column_values(ids: ["text5"]) { text } } } } }`;
  const data = await gql(q, cursor ? { c: cursor } : { b: [BOARD] });
  const page = cursor ? data.next_items_page : data.boards?.[0]?.items_page;
  const items = page?.items ?? [];
  for (const it of items) {
    scanned++;
    if (/\(copy(\s+\d+)?\)\s*$/i.test(String(it.name ?? ""))) { skippedCopies++; continue; }
    // Only cards born in Inbound are canvasser production; other groups are
    // confirmer recycling (Futures / Never Confirmed / Reschedules / ...).
    const gid = String(it.group?.id ?? "");
    const gtitle = String(it.group?.title ?? "").trim().toLowerCase();
    if (gid !== "topics" && gtitle !== "inbound") { skippedNonInbound++; continue; }
    const d = laDate(new Date(it.created_at));
    if (d < SINCE || d >= BEFORE) continue;
    const agent = normalize(it.column_values?.[0]?.text);
    if (!agent) { blankAgents++; continue; }
    inWindow++;
    const key = `${agent}\t${d}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  cursor = page?.cursor;
  if (!cursor || items.length === 0) break;
}

console.error(`scanned=${scanned} inWindow=${inWindow} skippedCopies=${skippedCopies} skippedNonInbound=${skippedNonInbound} blankAgents=${blankAgents} window=[${SINCE}, ${BEFORE})`);

if (counts.size === 0) {
  console.log(`-- No Incoming Leads items found in LA window [${SINCE}, ${BEFORE}) — nothing to backfill.`);
  process.exit(0);
}

const values = [...counts.entries()]
  .map(([k, n]) => {
    const [agent, d] = k.split("\t");
    return `  ('${agent.replace(/'/g, "''")}', '${d}'::date, ${n})`;
  })
  .join(",\n");

console.log(`-- Backfill leads_generated from Incoming Leads board ${BOARD}
-- Inbound-group cards only. LA-date window [${SINCE}, ${BEFORE}) — strictly
-- before webhook activation. Starts with a clean slate for the window, then
-- absolute sets: safe to re-paste; DO NOT run for dates on/after activation.
UPDATE public.daily_metrics SET leads_generated = 0
WHERE metric_date >= '${SINCE}' AND metric_date < '${BEFORE}';

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
