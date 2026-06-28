import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

/**
 * Monday.com → Lovable Cloud sync webhook.
 *
 * Security: caller must present `x-monday-secret: <MONDAY_WEBHOOK_SECRET>` OR
 * pass `?secret=<MONDAY_WEBHOOK_SECRET>`.
 *
 * Monday handshake on first save: POST `{ challenge }` → echo back.
 *
 * Translation Dictionary (Outcome_Status → Daily Log + Points):
 *   BO   (Blow Out)    → no_demo +1                                   (0 pts)
 *   OL   (One Leg)     → one_legs +1                                  (0 pts)
 *   RS   (Reset)       → future_leads +1                              (0 pts)
 *   PM   (Pitch Miss)  → demos_sits +1                                (+1 pt)
 *   Sale               → demos_sits +1, sales +1, insert confirmed
 *                        lead with sale_amount = Sale_Price           (+2 pts)
 *
 * Commission is computed downstream by the Paycheck Engine from
 * leads.sale_amount and the canvasser's weekly point tier (1% / 2%).
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

type Outcome = "BO" | "OL" | "RS" | "PM" | "SALE";

/** Normalize free-text status into the canonical acronym. */
function normalizeOutcome(raw: string | null | undefined): Outcome | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!k) return null;
  if (["bo", "blowout"].includes(k) || k.includes("blowout")) return "BO";
  if (["ol", "1leg", "oneleg", "onelegs"].includes(k) || k.includes("oneleg") || k.includes("1leg")) return "OL";
  if (["rs", "reset", "resets", "futurelead", "futureleads"].includes(k) || k.includes("reset")) return "RS";
  if (["pm", "pitchmiss", "demo", "sit", "demosit", "demositting"].includes(k) || k.includes("pitchmiss") || k.includes("demo") || k.includes("sit")) return "PM";
  if (["sale", "sold", "closed", "win", "sales"].includes(k) || k.includes("sale") || k.includes("sold")) return "SALE";
  return null;
}

/** Points per outcome. */
const POINTS: Record<Outcome, number> = { BO: 0, OL: 0, RS: 0, PM: 1, SALE: 2 };

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
    sale_price: z.union([z.string(), z.number()]).optional(),
    sale_amount: z.union([z.string(), z.number()]).optional(),
    price: z.union([z.string(), z.number()]).optional(),
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
    sale_price: find("saleprice", "price", "amount", "dealvalue", "contractvalue"),
  };
}

function parseDate(s: string | undefined): string {
  if (!s) return new Date().toISOString().slice(0, 10);
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function parseMoney(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
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

        // Monday handshake — echo challenge.
        if (body.challenge) return json({ challenge: body.challenge });

        if (presented !== expected) return json({ error: "Unauthorized" }, 401);

        const fromEvent = pickFromMondayEvent(body.event);
        const canvasserName =
          body.canvasser_name ?? body.agent ?? fromEvent.canvasser_name ?? "";
        const leadName = body.lead_name ?? fromEvent.lead_name ?? null;
        const outcomeRaw =
          body.outcome_status ?? body.outcome ?? body.status ?? fromEvent.outcome_status;
        const logDate = parseDate(body.date_of_action ?? body.date ?? fromEvent.date_of_action);
        const salePrice = parseMoney(
          body.sale_price ?? body.sale_amount ?? body.price ?? fromEvent.sale_price,
        );

        if (!canvasserName.trim()) return json({ error: "Missing canvasser name" }, 422);
        const outcome = normalizeOutcome(outcomeRaw ?? null);
        if (!outcome) return json({ error: `Unrecognized outcome: ${outcomeRaw}` }, 422);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Find canvasser (case-insensitive display_name).
        const { data: profile, error: pErr } = await supabaseAdmin
          .from("profiles")
          .select("id, team_id, display_name")
          .ilike("display_name", canvasserName.trim())
          .maybeSingle();
        if (pErr) return json({ error: pErr.message }, 500);
        if (!profile) return json({ error: `Canvasser not found: ${canvasserName}` }, 404);

        // Ensure today's daily_log row exists.
        const { error: upErr } = await supabaseAdmin
          .from("daily_logs")
          .upsert(
            { canvasser_id: profile.id, team_id: profile.team_id, log_date: logDate },
            { onConflict: "canvasser_id,log_date", ignoreDuplicates: true },
          );
        if (upErr) return json({ error: upErr.message }, 500);

        // Build per-outcome increment map.
        const inc: Partial<Record<
          "no_demo" | "one_legs" | "future_leads" | "demos_sits" | "sales",
          number
        >> = {};
        switch (outcome) {
          case "BO": inc.no_demo = 1; break;
          case "OL": inc.one_legs = 1; break;
          case "RS": inc.future_leads = 1; break;
          case "PM": inc.demos_sits = 1; break;
          case "SALE": inc.demos_sits = 1; inc.sales = 1; break;
        }

        // Read current values, apply increments, write back.
        const fields = Object.keys(inc) as (keyof typeof inc)[];
        const selectCols = ["id", ...fields].join(", ");
        const { data: row, error: rErr } = await supabaseAdmin
          .from("daily_logs")
          .select(selectCols)
          .eq("canvasser_id", profile.id)
          .eq("log_date", logDate)
          .maybeSingle();
        if (rErr || !row) return json({ error: rErr?.message ?? "Log row missing" }, 500);

        const update: Record<string, number> = {};
        for (const f of fields) {
          const curr = Number((row as Record<string, unknown>)[f as string] ?? 0);
          update[f as string] = curr + (inc[f] ?? 0);
        }
        const { error: wErr } = await supabaseAdmin
          .from("daily_logs")
          .update(update as never)
          .eq("id", (row as { id: string }).id);
        if (wErr) return json({ error: wErr.message }, 500);

        // For Sale: create a confirmed lead with sale_amount → feeds Paycheck
        // Engine (revenue/commission) and fires the live lead counter trigger.
        let leadId: string | null = null;
        if (outcome === "SALE") {
          const { data: lead, error: lErr } = await supabaseAdmin
            .from("leads")
            .insert({
              canvasser_id: profile.id,
              team_id: profile.team_id,
              status: "confirmed",
              customer_name: leadName,
              sale_amount: salePrice ?? null,
              is_sale: true,
              reviewed_at: new Date().toISOString(),
            })
            .select("id")
            .maybeSingle();
          if (lErr) return json({ error: lErr.message }, 500);
          leadId = lead?.id ?? null;
        }

        return json({
          ok: true,
          canvasser: profile.display_name,
          lead: leadName,
          outcome,
          points_awarded: POINTS[outcome],
          sale_price: outcome === "SALE" ? salePrice : null,
          lead_id: leadId,
          log_date: logDate,
          updated: update,
        });
      },
    },
  },
});
