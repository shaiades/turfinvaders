import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

/**
 * Monday.com → Lovable Cloud sync webhook.
 *
 * Security: caller must present `x-monday-secret: <MONDAY_WEBHOOK_SECRET>` OR
 * pass `?secret=<MONDAY_WEBHOOK_SECRET>` (Monday's automation builder does
 * not always allow custom headers — query param is the fallback).
 *
 * Monday performs a handshake on first save: POST with `{ "challenge": "..." }`.
 * We must echo `{ challenge }` back as JSON.
 *
 * Real payloads can come in two shapes:
 *   1. Native Monday "Send webhook" event:
 *      { event: { columnValues: {...}, pulseName: "...", ... } }
 *   2. Custom JSON we instructed the user to send from an automation:
 *      { canvasser_name, lead_name, outcome_status, date_of_action }
 *
 * We accept both.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-monday-secret, Authorization",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

/** Map free-text outcome → daily_logs numeric column. */
const OUTCOME_FIELDS = {
  sale: "sales",
  sold: "sales",
  closed: "sales",
  win: "sales",
  demo: "demos_sits",
  sit: "demos_sits",
  "pitch miss": "demos_sits",
  "demo/sit": "demos_sits",
  "one leg": "one_legs",
  "1 leg": "one_legs",
  "1-leg": "one_legs",
  "no show": "no_shows",
  noshow: "no_shows",
  reset: "no_shows",
  "no demo": "no_demo",
  "nodemo": "no_demo",
} as const;

type DailyField =
  | "sales" | "demos_sits" | "one_legs" | "no_shows" | "no_demo"
  | "confirmed_leads" | "next_days" | "future_leads";

const ALLOWED_FIELDS = new Set<DailyField>([
  "sales", "demos_sits", "one_legs", "no_shows", "no_demo",
  "confirmed_leads", "next_days", "future_leads",
]);

function mapOutcome(raw: string | undefined | null): DailyField | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (key in OUTCOME_FIELDS) return OUTCOME_FIELDS[key as keyof typeof OUTCOME_FIELDS];
  // fuzzy contains
  for (const [k, v] of Object.entries(OUTCOME_FIELDS)) {
    if (key.includes(k)) return v as DailyField;
  }
  return null;
}

const payloadSchema = z
  .object({
    canvasser_name: z.string().optional(),
    agent: z.string().optional(),
    lead_name: z.string().optional(),
    outcome_status: z.string().optional(),
    outcome: z.string().optional(),
    status: z.string().optional(),
    date_of_action: z.string().optional(),
    date: z.string().optional(),
    event: z.any().optional(),
    challenge: z.string().optional(),
  })
  .passthrough();

function pickFromMondayEvent(ev: any) {
  if (!ev || typeof ev !== "object") return {};
  const cv = ev.columnValues ?? ev.column_values ?? {};
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cv)) {
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      flat[k] = o.text ?? o.label ?? o.value ?? o.name ?? JSON.stringify(o);
    } else {
      flat[k] = v;
    }
  }
  const lower = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const find = (...needles: string[]) => {
    for (const [k, v] of Object.entries(flat)) {
      const lk = lower(k);
      if (needles.some((n) => lk.includes(n))) return String(v ?? "");
    }
    return undefined;
  };
  return {
    canvasser_name: find("canvasser", "agent", "rep"),
    lead_name: ev.pulseName ?? ev.itemName ?? find("lead", "customer", "name"),
    outcome_status: find("outcome", "status", "result"),
    date_of_action: find("date", "actiondate"),
  };
}

function parseDate(s: string | undefined): string {
  if (!s) return new Date().toISOString().slice(0, 10);
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

export const Route = createFileRoute("/api/public/monday-webhook")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        const expected = process.env.MONDAY_WEBHOOK_SECRET;
        if (!expected) return json({ error: "Webhook not configured" }, 500);

        const url = new URL(request.url);
        const presented =
          request.headers.get("x-monday-secret") ?? url.searchParams.get("secret");

        const bodyText = await request.text();
        let body: z.infer<typeof payloadSchema>;
        try {
          body = payloadSchema.parse(bodyText ? JSON.parse(bodyText) : {});
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        // Monday handshake — echo challenge. Allowed without secret so we can
        // register the URL before pasting the secret on Monday's side.
        if (body.challenge) {
          return json({ challenge: body.challenge });
        }

        if (presented !== expected) {
          return json({ error: "Unauthorized" }, 401);
        }

        const fromEvent = pickFromMondayEvent(body.event);
        const canvasserName =
          body.canvasser_name ?? body.agent ?? fromEvent.canvasser_name ?? "";
        const leadName = body.lead_name ?? fromEvent.lead_name ?? null;
        const outcomeRaw =
          body.outcome_status ?? body.outcome ?? body.status ?? fromEvent.outcome_status;
        const logDate = parseDate(body.date_of_action ?? body.date ?? fromEvent.date_of_action);

        if (!canvasserName.trim()) return json({ error: "Missing canvasser name" }, 422);
        const field = mapOutcome(outcomeRaw ?? null);
        if (!field || !ALLOWED_FIELDS.has(field)) {
          return json({ error: `Unrecognized outcome: ${outcomeRaw}` }, 422);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Find canvasser by display_name (case-insensitive).
        const { data: profile, error: pErr } = await supabaseAdmin
          .from("profiles")
          .select("id, team_id, display_name")
          .ilike("display_name", canvasserName.trim())
          .maybeSingle();
        if (pErr) return json({ error: pErr.message }, 500);
        if (!profile) return json({ error: `Canvasser not found: ${canvasserName}` }, 404);

        // Ensure today's daily_log row exists for this canvasser.
        const { error: upErr } = await supabaseAdmin
          .from("daily_logs")
          .upsert(
            { canvasser_id: profile.id, team_id: profile.team_id, log_date: logDate },
            { onConflict: "canvasser_id,log_date", ignoreDuplicates: true },
          );
        if (upErr) return json({ error: upErr.message }, 500);

        // Read current value, increment, write back. Whitelist-checked above.
        const { data: row, error: rErr } = await supabaseAdmin
          .from("daily_logs")
          .select(`id, ${field}`)
          .eq("canvasser_id", profile.id)
          .eq("log_date", logDate)
          .maybeSingle();
        if (rErr || !row) return json({ error: rErr?.message ?? "Log row missing" }, 500);

        const current = Number((row as Record<string, unknown>)[field] ?? 0);
        const { error: wErr } = await supabaseAdmin
          .from("daily_logs")
          .update({ [field]: current + 1 })
          .eq("id", (row as { id: string }).id);
        if (wErr) return json({ error: wErr.message }, 500);

        return json({
          ok: true,
          canvasser: profile.display_name,
          lead: leadName,
          field,
          log_date: logDate,
          new_value: current + 1,
        });
      },
    },
  },
});
