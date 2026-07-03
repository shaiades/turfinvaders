import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

/**
 * Monday.com → Live Dispatch intraday webhook.
 *
 * Accepts: { canvasser_name: string, status: <Monday label> }
 *
 * Status mapping (case-insensitive):
 *   "Confirmed" | "Future Reconf"                  → leads_confirmed++
 *   "N/A" | "N/A x2" | "N/A x3" | "N/A x4"          → no_answers++
 *   "Blowout" | "Disconnected"                      → killed++
 *   "Unconfirmed" | "Future" | "Room Lead"          → pending++
 *   "Submitted"                                     → (only) leads_submitted++
 *
 * Every webhook also increments leads_submitted by 1 (net-new lead),
 * UNLESS the status itself is the legacy "Submitted" trigger (which is
 * already a net-new lead and would otherwise double-count).
 *
 * Security: caller must send `x-monday-secret: <MONDAY_WEBHOOK_SECRET>` OR
 *           pass `?secret=<MONDAY_WEBHOOK_SECRET>`. Also handles Monday's
 *           `{ challenge }` handshake on first save.
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

const BodySchema = z.object({
  canvasser_name: z.string().min(1),
  status: z.string().min(1),
});

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function todayLA(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

type Bucket = "leads_confirmed" | "no_answers" | "killed" | "pending" | null;

function mapStatus(raw: string): Bucket {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (s === "confirmed" || s === "future reconf") return "leads_confirmed";
  if (s === "n/a" || s === "n/a x2" || s === "n/a x3" || s === "n/a x4") return "no_answers";
  if (s === "blowout" || s === "disconnected") return "killed";
  if (s === "unconfirmed" || s === "future" || s === "room lead") return "pending";
  if (s === "submitted") return null; // submitted-only trigger
  return "pending"; // unknown labels → safest bucket so nothing is dropped
}

export const Route = createFileRoute("/api/public/monday-live-dispatch")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 200, headers: CORS }),
      GET: async () =>
        json({ ok: true, endpoint: "monday-live-dispatch", method: "GET" }),
      POST: async ({ request }) => {
        let parsed: unknown;
        try {
          parsed = await request.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        // Monday handshake — return a naked JSON Response immediately.
        // No helpers, auth, logging, imports, or DB/RLS work may run first.
        if (
          parsed &&
          typeof parsed === "object" &&
          "challenge" in (parsed as Record<string, unknown>)
        ) {
          const challenge = (parsed as Record<string, unknown>).challenge;
          return new Response(JSON.stringify({ challenge }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        const secret = process.env.MONDAY_WEBHOOK_SECRET;
        const url = new URL(request.url);
        const headerSecret = request.headers.get("x-monday-secret");
        const querySecret = url.searchParams.get("secret");

        // X-RAY: log every incoming payload (after handshake, before auth/match)
        // so we can see exactly what Monday is sending.
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        await supabaseAdmin.from("webhook_logs").insert({
          source: "monday-live-dispatch",
          raw_payload: parsed as never,
        });

        if (secret && headerSecret !== secret && querySecret !== secret) {
          return json({ error: "Unauthorized" }, 401);
        }


        const result = BodySchema.safeParse(parsed);
        if (!result.success) {
          return json({ error: "Invalid payload", details: result.error.flatten() }, 400);
        }

        const { canvasser_name, status } = result.data;
        const bucket = mapStatus(status);
        const isSubmittedOnly = status.trim().toLowerCase() === "submitted";

        // supabaseAdmin already imported above for X-Ray logging.


        // Smart Canvasser Lookup — normalize + fuzzy partial matching.
        const wanted = normalizeName(canvasser_name);
        const { data: profiles, error: profErr } = await supabaseAdmin
          .from("profiles")
          .select("id, display_name, office_location");
        if (profErr) return json({ error: profErr.message }, 500);

        const candidates = (profiles ?? [])
          .filter((p) => p.display_name)
          .map((p) => ({ ...p, _norm: normalizeName(p.display_name as string) }));

        // 1) exact normalized match
        let match = candidates.find((p) => p._norm === wanted);
        // 2) db name includes webhook name (e.g. "ernie ruiz".includes("ernie"))
        if (!match) match = candidates.find((p) => p._norm.includes(wanted));
        // 3) webhook name includes db name (e.g. "ernie r" includes "ernie")
        if (!match) match = candidates.find((p) => wanted.includes(p._norm));
        // 4) first-token match as a last resort ("ernie" ↔ "ernie ruiz")
        if (!match) {
          const firstToken = wanted.split(" ")[0];
          if (firstToken) {
            match = candidates.find((p) => p._norm.split(" ")[0] === firstToken);
          }
        }

        if (!match) {
          // The Bouncer: auto-provision a Free Agent placeholder so no lead is dropped.
          const newId = crypto.randomUUID();
          const officeGuess = "San Diego";
          const { data: created, error: createErr } = await supabaseAdmin
            .from("profiles")
            .insert({
              id: newId,
              display_name: canvasser_name,
              office_location: officeGuess,
              is_placeholder: true,
              team_id: null,
            })
            .select("id, display_name, office_location")
            .single();
          if (createErr || !created) {
            await supabaseAdmin.from("webhook_logs").insert({
              source: "monday-live-dispatch:auto-create-failed",
              raw_payload: {
                canvasser_name,
                normalized: wanted,
                error: createErr?.message,
              } as never,
            });
            return json(
              { error: `Auto-create failed for: ${canvasser_name}` },
              500,
            );
          }
          await supabaseAdmin
            .from("user_roles")
            .insert({ user_id: newId, role: "canvasser" });
          match = { ...created, _norm: wanted };
          await supabaseAdmin.from("webhook_logs").insert({
            source: "monday-live-dispatch:auto-created",
            raw_payload: { canvasser_name, newId, office: officeGuess } as never,
          });
        }
        if (!match) return json({ error: "match unavailable" }, 500);

        const metric_date = todayLA();
        const office_location = match.office_location ?? "San Diego";

        const { data: existing } = await supabaseAdmin
          .from("daily_metrics")
          .select("id, leads_submitted, leads_confirmed, no_answers, killed, pending")
          .eq("canvasser_id", match.id)
          .eq("metric_date", metric_date)
          .maybeSingle();

        // Every incoming webhook represents one net-new lead, so submitted
        // increments by 1 (the legacy "Submitted" trigger is also +1, never +2).
        const nextSubmitted = (existing?.leads_submitted ?? 0) + 1;
        const nextConfirmed =
          (existing?.leads_confirmed ?? 0) + (bucket === "leads_confirmed" ? 1 : 0);
        const nextNoAnswers =
          (existing?.no_answers ?? 0) + (bucket === "no_answers" ? 1 : 0);
        const nextKilled = (existing?.killed ?? 0) + (bucket === "killed" ? 1 : 0);
        const nextPending =
          (existing?.pending ?? 0) + (bucket === "pending" && !isSubmittedOnly ? 1 : 0);

        const { error: upErr } = await supabaseAdmin
          .from("daily_metrics")
          .upsert(
            {
              canvasser_id: match.id,
              metric_date,
              office_location,
              leads_submitted: nextSubmitted,
              leads_confirmed: nextConfirmed,
              no_answers: nextNoAnswers,
              killed: nextKilled,
              pending: nextPending,
            },
            { onConflict: "canvasser_id,metric_date" },
          );
        if (upErr) return json({ error: upErr.message }, 500);

        return json({
          ok: true,
          canvasser_id: match.id,
          canvasser_name: match.display_name,
          metric_date,
          status_received: status,
          bucket: bucket ?? "submitted_only",
          leads_submitted: nextSubmitted,
          leads_confirmed: nextConfirmed,
          no_answers: nextNoAnswers,
          killed: nextKilled,
          pending: nextPending,
        });
      },
    },
  },
});
