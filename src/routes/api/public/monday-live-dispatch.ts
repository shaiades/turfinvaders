import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

/**
 * Monday.com → Live Dispatch intraday webhook.
 *
 * Accepts: { canvasser_name: string, status: "Submitted" | "Confirmed" }
 * Action:  matches canvasser_name → profile.id, then upserts today's row in
 *          public.daily_metrics, incrementing leads_submitted or leads_confirmed.
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
  status: z
    .string()
    .min(1)
    .transform((s) => s.trim().toLowerCase()),
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

export const Route = createFileRoute("/api/public/monday-live-dispatch")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        const secret = process.env.MONDAY_WEBHOOK_SECRET;
        const url = new URL(request.url);
        const headerSecret = request.headers.get("x-monday-secret");
        const querySecret = url.searchParams.get("secret");

        const raw = await request.text();
        let parsed: unknown;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        // Monday handshake
        if (parsed && typeof parsed === "object" && "challenge" in (parsed as Record<string, unknown>)) {
          return json({ challenge: (parsed as Record<string, unknown>).challenge });
        }

        if (secret && headerSecret !== secret && querySecret !== secret) {
          return json({ error: "Unauthorized" }, 401);
        }

        const result = BodySchema.safeParse(parsed);
        if (!result.success) {
          return json({ error: "Invalid payload", details: result.error.flatten() }, 400);
        }

        const { canvasser_name, status } = result.data;
        let field: "leads_submitted" | "leads_confirmed";
        if (status === "submitted") field = "leads_submitted";
        else if (status === "confirmed") field = "leads_confirmed";
        else return json({ error: `Unknown status: ${status}` }, 400);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Match canvasser_name → profile id (case-insensitive exact match first,
        // then loose contains match as fallback).
        const wanted = normalizeName(canvasser_name);
        const { data: profiles, error: profErr } = await supabaseAdmin
          .from("profiles")
          .select("id, display_name, office_location");
        if (profErr) return json({ error: profErr.message }, 500);

        const candidates = (profiles ?? []).filter((p) => p.display_name);
        let match = candidates.find(
          (p) => normalizeName(p.display_name as string) === wanted,
        );
        if (!match) {
          match = candidates.find((p) =>
            normalizeName(p.display_name as string).includes(wanted),
          );
        }
        if (!match) {
          return json({ error: `No canvasser matched: ${canvasser_name}` }, 404);
        }

        const metric_date = todayLA();
        const office_location = match.office_location ?? "San Diego";

        // Read existing row to increment atomically (PostgREST has no
        // increment expression on upsert). Use RPC-free 2-step path with
        // unique constraint as the safety net.
        const { data: existing } = await supabaseAdmin
          .from("daily_metrics")
          .select("id, leads_submitted, leads_confirmed")
          .eq("canvasser_id", match.id)
          .eq("metric_date", metric_date)
          .maybeSingle();

        const nextSubmitted =
          (existing?.leads_submitted ?? 0) + (field === "leads_submitted" ? 1 : 0);
        const nextConfirmed =
          (existing?.leads_confirmed ?? 0) + (field === "leads_confirmed" ? 1 : 0);

        const { error: upErr } = await supabaseAdmin
          .from("daily_metrics")
          .upsert(
            {
              canvasser_id: match.id,
              metric_date,
              office_location,
              leads_submitted: nextSubmitted,
              leads_confirmed: nextConfirmed,
            },
            { onConflict: "canvasser_id,metric_date" },
          );
        if (upErr) return json({ error: upErr.message }, 500);

        return json({
          ok: true,
          canvasser_id: match.id,
          canvasser_name: match.display_name,
          metric_date,
          leads_submitted: nextSubmitted,
          leads_confirmed: nextConfirmed,
        });
      },
    },
  },
});
