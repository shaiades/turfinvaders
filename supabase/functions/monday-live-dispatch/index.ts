// Supabase Edge Function: monday-live-dispatch
// Monday.com webhook receiver. Handles challenge handshake, then resolves
// the canvasser name via a GraphQL callback (Monday payloads only contain
// pulseId + status, not the agent name) and upserts daily_metrics.
//
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
  const ev = parsed?.event ?? {};
  const pulseId =
    typeof ev.pulseId === "number"
      ? ev.pulseId
      : typeof ev.pulseId === "string"
        ? Number(ev.pulseId)
        : undefined;
  const status =
    ev?.value?.label?.text ??
    ev?.value?.label ??
    ev?.value?.text ??
    (typeof parsed?.status === "string" ? parsed.status : undefined);
  return { pulseId, status };
}

async function fetchCanvasserNameFromMonday(
  pulseId: number,
  token: string,
  admin: any,
): Promise<{ name: string | null; raw: unknown; ok: boolean; status: number }> {
  const query = `query { items (ids: [${pulseId}]) { column_values { column { title } text } } }`;
  let res: Response;
  let raw: any = {};
  try {
    res = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
        "API-Version": "2024-01",
      },
      body: JSON.stringify({ query }),
    });
    raw = await res.json().catch(() => ({}));
  } catch (err) {
    await admin.from("webhook_logs").insert({
      source: "monday-live-dispatch:monday_fetch_exception",
      raw_payload: { pulseId, error: String(err) } as never,
    });
    throw err;
  }

  // Verbose log of every Monday API response (success or failure).
  await admin.from("webhook_logs").insert({
    source: res.ok && !raw?.errors
      ? "monday-live-dispatch:monday_response"
      : "monday-live-dispatch:monday_error",
    raw_payload: {
      pulseId,
      http_status: res.status,
      ok: res.ok,
      response: raw,
    } as never,
  });

  const cols = raw?.data?.items?.[0]?.column_values ?? [];
  // Strict: column title must contain 'agent' (case-insensitive).
  const hit = cols.find((c: any) => {
    const t = (c?.column?.title ?? "").toLowerCase();
    return t.includes("agent");
  });
  const name = typeof hit?.text === "string" && hit.text.trim() ? hit.text.trim() : null;
  return { name, raw, ok: res.ok && !raw?.errors, status: res.status };
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

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // X-RAY log
  await admin.from("webhook_logs").insert({
    source: "monday-live-dispatch",
    raw_payload: parsed as never,
  });

  const secret = Deno.env.get("MONDAY_WEBHOOK_SECRET");
  const url = new URL(req.url);
  const headerSecret = req.headers.get("x-monday-secret");
  const querySecret = url.searchParams.get("secret");
  if (secret && headerSecret !== secret && querySecret !== secret) {
    return json({ error: "Unauthorized" }, 401);
  }

  // ---- Resolve canvasser_name + status ----
  // Support: (1) legacy body { canvasser_name, status } and
  // (2) Monday event body { event: { pulseId, value: { label: { text } } } }
  const obj = parsed as Record<string, any>;
  let canvasser_name: string | null =
    typeof obj.canvasser_name === "string" && obj.canvasser_name.trim()
      ? obj.canvasser_name.trim()
      : null;
  const { pulseId, status: evStatus } = extractEvent(obj);
  const status =
    typeof obj.status === "string" && obj.status.trim()
      ? obj.status.trim()
      : evStatus ?? "";

  if (!canvasser_name && pulseId) {
    // Fetch token from system_settings, then call Monday GraphQL.
    const { data: settings } = await admin
      .from("system_settings")
      .select("monday_api_token")
      .eq("id", true)
      .maybeSingle();
    const token = settings?.monday_api_token as string | undefined;

    if (!token) {
      await admin.from("webhook_logs").insert({
        source: "monday-live-dispatch:no_token",
        raw_payload: {
          error: "missing_monday_api_token",
          pulseId,
          status,
        } as never,
      });
      return json(
        { error: "Monday API token not configured in system_settings" },
        500,
      );
    }

    try {
      const { name, raw } = await fetchCanvasserNameFromMonday(pulseId, token);
      canvasser_name = name;
      await admin.from("webhook_logs").insert({
        source: "monday-live-dispatch:graphql",
        raw_payload: { pulseId, resolved_name: name, monday_response: raw } as never,
      });
    } catch (err) {
      await admin.from("webhook_logs").insert({
        source: "monday-live-dispatch:graphql_error",
        raw_payload: { pulseId, error: String(err) } as never,
      });
      return json({ error: "Monday GraphQL fetch failed", details: String(err) }, 502);
    }
  }

  if (!canvasser_name || !status) {
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
  const { data: profiles, error: profErr } = await admin
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

  if (!match) {
    await admin.from("webhook_logs").insert({
      source: "monday-live-dispatch:unmatched",
      raw_payload: {
        error: "no_canvasser_match",
        canvasser_name,
        normalized: wanted,
        status,
        pulseId,
        original_payload: parsed,
      } as never,
    });
    return json(
      { error: `No canvasser matched: ${canvasser_name}`, normalized: wanted },
      404,
    );
  }

  const metric_date = todayLA();
  const office_location = match.office_location ?? "San Diego";

  const { data: existing } = await admin
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

  const { error: upErr } = await admin.from("daily_metrics").upsert(
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
});
