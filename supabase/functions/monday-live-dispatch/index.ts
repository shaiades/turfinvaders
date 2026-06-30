// Supabase Edge Function: monday-live-dispatch
// Monday.com webhook receiver with extreme step-by-step debug logging.
// Endpoint: https://<project-ref>.supabase.co/functions/v1/monday-live-dispatch
// Auth: verify_jwt = false (see supabase/config.toml)

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type, x-monday-secret, Authorization, apikey",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
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
  if (s === "submitted") return null;
  return "pending";
}

function extractEvent(parsed: any): { pulseId?: number; status?: string } {
  const ev = parsed?.event;
  const pulseId =
    typeof ev?.pulseId === "number"
      ? ev.pulseId
      : typeof ev?.pulseId === "string"
        ? Number(ev.pulseId)
        : undefined;
  const status =
    ev?.value?.label?.text ??
    ev?.value?.label ??
    ev?.value?.text ??
    (typeof parsed?.status === "string" ? parsed.status : undefined);
  return { pulseId, status };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: CORS });
  }
  if (req.method === "GET") {
    return json({ ok: true, endpoint: "monday-live-dispatch", method: "GET" });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Monday handshake — naked JSON, no auth, no DB.
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

  let supabaseAdmin: any = null;

  try {
    // Service-role admin client — used for EVERY DB operation so RLS cannot block logs/lookups.
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SERVICE_KEY) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
    supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ───────────────────────────────────────────────────────────────
    // STEP 1 — Webhook Received
    // ───────────────────────────────────────────────────────────────
    await supabaseAdmin.from("webhook_logs").insert({
      source: "monday-live-dispatch",
      raw_payload: { step: "1_Received", data: parsed } as never,
    });

    // Optional shared-secret gate (no logging of the secret itself).
    const secret = Deno.env.get("MONDAY_WEBHOOK_SECRET");
    const url = new URL(req.url);
    const headerSecret = req.headers.get("x-monday-secret");
    const querySecret = url.searchParams.get("secret");
    if (secret && headerSecret !== secret && querySecret !== secret) {
      return json({ error: "Unauthorized" }, 401);
    }

    // Resolve canvasser_name + status from either legacy body or Monday event.
    const obj = parsed as Record<string, any>;
    let canvasser_name: string | null =
      typeof obj?.canvasser_name === "string" && obj.canvasser_name.trim()
        ? obj.canvasser_name.trim()
        : null;
    const { pulseId, status: evStatus } = extractEvent(obj);
    const status =
      typeof obj?.status === "string" && obj.status.trim()
        ? obj.status.trim()
        : evStatus ?? "";

    if (!canvasser_name && pulseId) {
      // ─────────────────────────────────────────────────────────────
      // STEP 2 — Token Check
      // ─────────────────────────────────────────────────────────────
      const { data: settings, error: settingsErr } = await supabaseAdmin
        .from("system_settings")
        .select("monday_api_token")
        .limit(1)
        .maybeSingle();

      if (settingsErr || !settings?.monday_api_token) {
        await supabaseAdmin.from("webhook_logs").insert({
          source: "monday-live-dispatch",
          raw_payload: {
            step: "2_Error",
            message: "Token not found in DB",
            db_error: settingsErr?.message ?? null,
            pulseId,
          } as never,
        });
        return json(
          { error: "Monday API token not found", details: settingsErr?.message ?? null },
          500,
        );
      }

      const mondayApiToken = settings.monday_api_token as string;

      // ─────────────────────────────────────────────────────────────
      // STEP 3 — Monday API Call
      // ─────────────────────────────────────────────────────────────
      const query = `query { items (ids: [${pulseId}]) { column_values { column { title } text } } }`;
      let responseJson: any = {};
      let mondayResponse: Response | null = null;
      try {
        mondayResponse = await fetch("https://api.monday.com/v2", {
          method: "POST",
          headers: {
            Authorization: mondayApiToken,
            "Content-Type": "application/json",
            "API-Version": "2024-01",
          },
          body: JSON.stringify({ query }),
        });
        responseJson = await mondayResponse.json().catch(() => ({}));
      } catch (err) {
        await supabaseAdmin.from("webhook_logs").insert({
          source: "monday-live-dispatch",
          raw_payload: {
            step: "3_Error",
            message: "Monday API fetch threw",
            error: String(err),
            pulseId,
          } as never,
        });
        return json({ error: "Monday GraphQL fetch failed", details: String(err) }, 502);
      }

      await supabaseAdmin.from("webhook_logs").insert({
        source: "monday-live-dispatch",
        raw_payload: {
          step: "3_MondayResponse",
          http_status: mondayResponse.status,
          ok: mondayResponse.ok,
          data: responseJson,
          pulseId,
        } as never,
      });

      if (!mondayResponse.ok || responseJson?.errors) {
        await supabaseAdmin.from("webhook_logs").insert({
          source: "monday-live-dispatch",
          raw_payload: {
            step: "3_Error",
            message: "Monday API call failed",
            http_status: mondayResponse.status,
            monday_response: responseJson,
            pulseId,
          } as never,
        });
        return json(
          {
            error: "Failed to fetch data from Monday.com",
            http_status: mondayResponse.status,
            monday_response: responseJson,
          },
          502,
        );
      }

      const cols = responseJson?.data?.items?.[0]?.column_values ?? [];
      const hit = cols.find((c: any) => {
        const t = (c?.column?.title ?? "").toLowerCase();
        return t.includes("agent");
      });
      canvasser_name =
        typeof hit?.text === "string" && hit.text.trim() ? hit.text.trim() : null;
    }

    if (!canvasser_name || !status) {
      await supabaseAdmin.from("webhook_logs").insert({
        source: "monday-live-dispatch",
        raw_payload: {
          step: "4_Error",
          message: "Could not resolve canvasser_name or status",
          canvasser_name,
          status,
          pulseId,
        } as never,
      });
      return json(
        {
          error: "Could not resolve canvasser_name or status",
          canvasser_name,
          status,
          pulseId,
        },
        400,
      );
    }

    const bucket = mapStatus(status);
    const isSubmittedOnly = status.trim().toLowerCase() === "submitted";

    // Smart fuzzy lookup
    const wanted = normalizeName(canvasser_name);
    const { data: profiles, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("id, display_name, office_location");
    if (profErr) return json({ error: profErr.message }, 500);

    const candidates = (profiles ?? [])
      .filter((p: any) => p.display_name)
      .map((p: any) => ({ ...p, _norm: normalizeName(p.display_name) }));

    let match = candidates.find((p: any) => p._norm === wanted);
    if (!match) match = candidates.find((p: any) => p._norm.includes(wanted));
    if (!match) match = candidates.find((p: any) => wanted.includes(p._norm));
    if (!match) {
      const firstToken = wanted.split(" ")[0];
      if (firstToken) {
        match = candidates.find((p: any) => p._norm.split(" ")[0] === firstToken);
      }
    }

    // ───────────────────────────────────────────────────────────────
    // STEP 4 — Match Check
    // ───────────────────────────────────────────────────────────────
    await supabaseAdmin.from("webhook_logs").insert({
      source: "monday-live-dispatch",
      raw_payload: {
        step: "4_MatchAttempt",
        agent_found_in_monday: canvasser_name,
        normalized: wanted,
        db_match_successful: !!match,
        matched_profile_id: match?.id ?? null,
        matched_display_name: match?.display_name ?? null,
        pulseId,
        status,
      } as never,
    });

    if (!match) {
      return json(
        { error: `No canvasser matched: ${canvasser_name}`, normalized: wanted },
        404,
      );
    }

    const metric_date = todayLA();
    const office_location = match.office_location ?? "San Diego";

    const { data: existing } = await supabaseAdmin
      .from("daily_metrics")
      .select("id, leads_submitted, leads_confirmed, no_answers, killed, pending")
      .eq("canvasser_id", match.id)
      .eq("metric_date", metric_date)
      .maybeSingle();

    const nextSubmitted = (existing?.leads_submitted ?? 0) + 1;
    const nextConfirmed =
      (existing?.leads_confirmed ?? 0) + (bucket === "leads_confirmed" ? 1 : 0);
    const nextNoAnswers =
      (existing?.no_answers ?? 0) + (bucket === "no_answers" ? 1 : 0);
    const nextKilled = (existing?.killed ?? 0) + (bucket === "killed" ? 1 : 0);
    const nextPending =
      (existing?.pending ?? 0) + (bucket === "pending" && !isSubmittedOnly ? 1 : 0);

    const { error: upErr } = await supabaseAdmin.from("daily_metrics").upsert(
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
    if (upErr) {
      await supabaseAdmin.from("webhook_logs").insert({
        source: "monday-live-dispatch",
        raw_payload: {
          step: "5_UpsertError",
          message: upErr.message,
          canvasser_id: match.id,
          metric_date,
        } as never,
      });
      return json({ error: upErr.message }, 500);
    }

    return json({
      ok: true,
      canvasser_id: match.id,
      canvasser_name: match.display_name,
      resolved_from: pulseId ? "monday_graphql" : "payload",
      pulseId,
      metric_date,
      status_received: status,
      bucket: bucket ?? "submitted_only",
      leads_submitted: nextSubmitted,
      leads_confirmed: nextConfirmed,
      no_answers: nextNoAnswers,
      killed: nextKilled,
      pending: nextPending,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    try {
      if (!supabaseAdmin) {
        const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
        const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (SUPABASE_URL && SERVICE_KEY) {
          supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false },
          });
        }
      }

      if (supabaseAdmin) {
        await supabaseAdmin.from("webhook_logs").insert({
          source: "monday-live-dispatch",
          raw_payload: {
            step: "Fatal_Crash",
            message,
            stack: stack ?? null,
          } as never,
        });
      }
    } catch (logError) {
      console.error("Failed to write Fatal_Crash webhook log", logError);
    }

    return json({ error: "Webhook processing failed", details: message }, 500);
  }
});
