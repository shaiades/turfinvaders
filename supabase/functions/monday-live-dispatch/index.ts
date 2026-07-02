// Supabase Edge Function: monday-live-dispatch
// Monday.com webhook receiver. ALWAYS returns HTTP 200 so Monday never
// disables the automation. Errors are logged to webhook_logs.
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

const ok = (body: unknown = { ok: true }) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type":
        typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
      ...CORS,
    },
  });

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function todayLA(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

type Bucket = "leads_confirmed" | "no_answers" | "killed" | "pending" | null;

function mapStatus(raw: string): Bucket {
  const s = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
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
    return ok({ ok: true, endpoint: "monday-live-dispatch" });
  }

  // Parse JSON up-front so we can check challenge before anything else.
  let parsed: any = null;
  try {
    parsed = await req.json();
  } catch {
    // Even on bad JSON, return 200 to keep Monday happy.
    return ok({ ok: false, note: "invalid_json_ignored" });
  }

  // Monday handshake — naked JSON, no auth, no DB.
  if (parsed && typeof parsed === "object" && "challenge" in parsed) {
    return new Response(JSON.stringify({ challenge: parsed.challenge }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  let supabaseAdmin: any = null;
  const initAdmin = () => {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SERVICE_KEY) return null;
    return createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  };

  try {
    supabaseAdmin = initAdmin();
    if (!supabaseAdmin) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

    await supabaseAdmin.from("webhook_logs").insert({
      source: "monday-live-dispatch",
      raw_payload: { step: "1_Received", data: parsed } as never,
    });

    // Optional secret gate — still returns 200 if it fails.
    const secret = Deno.env.get("MONDAY_WEBHOOK_SECRET");
    const url = new URL(req.url);
    const headerSecret = req.headers.get("x-monday-secret");
    const querySecret = url.searchParams.get("secret");
    if (secret && headerSecret !== secret && querySecret !== secret) {
      await supabaseAdmin.from("webhook_logs").insert({
        source: "monday-live-dispatch",
        raw_payload: { step: "Auth_Skip", message: "secret mismatch, acknowledged" } as never,
      });
      return ok("Acknowledged");
    }

    // Resolve inputs
    let canvasser_name: string | null =
      typeof parsed?.canvasser_name === "string" && parsed.canvasser_name.trim()
        ? parsed.canvasser_name.trim()
        : null;
    const { pulseId, status: evStatus } = extractEvent(parsed);
    const status =
      typeof parsed?.status === "string" && parsed.status.trim()
        ? parsed.status.trim()
        : (evStatus ?? "");

    if (!canvasser_name && pulseId) {
      const { data: settings } = await supabaseAdmin
        .from("system_settings")
        .select("monday_api_token")
        .limit(1)
        .maybeSingle();

      const mondayApiToken = settings?.monday_api_token as string | undefined;
      if (!mondayApiToken) {
        await supabaseAdmin.from("webhook_logs").insert({
          source: "monday-live-dispatch",
          raw_payload: { step: "2_Error", message: "Monday API token missing", pulseId } as never,
        });
        return ok("Acknowledged (no token)");
      }

      const query = `query { items (ids: [${pulseId}]) { column_values { column { title } text } } }`;
      let responseJson: any = {};
      let mondayStatus = 0;
      try {
        const mondayResponse = await fetch("https://api.monday.com/v2", {
          method: "POST",
          headers: {
            Authorization: mondayApiToken,
            "Content-Type": "application/json",
            "API-Version": "2024-01",
          },
          body: JSON.stringify({ query }),
        });
        mondayStatus = mondayResponse.status;
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
        return ok("Acknowledged (monday fetch failed)");
      }

      await supabaseAdmin.from("webhook_logs").insert({
        source: "monday-live-dispatch",
        raw_payload: {
          step: "3_MondayResponse",
          http_status: mondayStatus,
          data: responseJson,
          pulseId,
        } as never,
      });

      const cols = responseJson?.data?.items?.[0]?.column_values ?? [];
      const hit = cols.find((c: any) =>
        (c?.column?.title ?? "").toLowerCase().includes("agent"),
      );
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
      return ok("Acknowledged (unresolved)");
    }

    const bucket = mapStatus(status);
    const isSubmittedOnly = status.trim().toLowerCase() === "submitted";

    const wanted = normalizeName(canvasser_name);
    const { data: profiles } = await supabaseAdmin
      .from("profiles")
      .select("id, display_name, office_location");

    const candidates = (profiles ?? [])
      .filter((p: any) => p.display_name)
      .map((p: any) => ({ ...p, _norm: normalizeName(p.display_name) }));

    let match = candidates.find((p: any) => p._norm === wanted);
    if (!match) match = candidates.find((p: any) => p._norm.includes(wanted));
    if (!match) match = candidates.find((p: any) => wanted.includes(p._norm));
    if (!match) {
      const firstToken = wanted.split(" ")[0];
      if (firstToken) match = candidates.find((p: any) => p._norm.split(" ")[0] === firstToken);
    }

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

    if (!match) return ok("Acknowledged (no canvasser match)");

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
    const nextNoAnswers = (existing?.no_answers ?? 0) + (bucket === "no_answers" ? 1 : 0);
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
      return ok("Acknowledged (upsert failed)");
    }

    return ok("Success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    try {
      if (!supabaseAdmin) supabaseAdmin = initAdmin();
      if (supabaseAdmin) {
        await supabaseAdmin.from("webhook_logs").insert({
          source: "monday-live-dispatch",
          raw_payload: { step: "Fatal_Crash", message, stack: stack ?? null } as never,
        });
      }
    } catch (logError) {
      console.error("Failed to write Fatal_Crash webhook log", logError);
    }
    // ALWAYS 200 — Monday disables webhooks that return non-2xx.
    return ok("Caught error but acknowledging receipt");
  }
});
