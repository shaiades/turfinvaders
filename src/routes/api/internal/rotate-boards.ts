import { createFileRoute } from "@tanstack/react-router";

/**
 * Monday.com board rotation + webhook self-heal (Vercel Cron).
 *
 * Default mode — weekly rotation (Mondays 13:00 UTC = 6am PT):
 * For each office (SD, OC), this week's Block board is found by name — or
 * created by duplicating the structure-only template board — then the
 * create_item + change_column_value webhooks are registered on it (skipped if
 * the registry already has them), system_settings.active_monday_board_* is
 * updated, and webhooks for prior weeks' boards are deregistered. Idempotent:
 * safe to re-run any number of times in a week.
 *
 * ?mode=check — daily webhook self-heal (13:30 UTC): webhooks created with a
 * personal API token can be toggled off by any board user in Monday's
 * Integrations Center, and Monday never turns them back on. This mode compares
 * the live webhooks(board_id:) list on both active boards against the expected
 * events, re-creates anything missing, syncs the monday_webhooks registry, and
 * audits retired Block boards to confirm rotation really removed their hooks.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` — Vercel Cron sends this
 * automatically when the CRON_SECRET env var is set on the project.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const MONDAY_API = process.env.MONDAY_API_URL || "https://api.monday.com/v2";
// The edge function enforces MONDAY_WEBHOOK_SECRET (same value on both sides);
// webhooks registered without it are rejected on delivery. Resolved lazily so a
// missing env var surfaces in the run summary instead of at module load.
function edgeUrl(): string {
  const secret = process.env.MONDAY_WEBHOOK_SECRET;
  const base =
    "https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/monday-live-dispatch?apikey=sb_publishable_ivjX0mrVvSLM1DHfDTDVuw_qHUtGeS2";
  return secret ? `${base}&secret=${secret}` : base;
}
const WEBHOOK_EVENTS = ["create_item", "change_column_value"] as const;
// Schedule of the daily check cron — keep in sync with vercel.json. Used as a
// fallback to route the request when the query string is absent.
const CHECK_SCHEDULE = "30 13 * * *";

type RegistryEntry = {
  board_id: string;
  webhook_id: string;
  event: string;
  registered_at: string;
};

function laToday(): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return new Date(`${fmt.format(new Date())}T00:00:00Z`);
}

/** Monday-of-this-week .. Saturday, formatted like the manual boards: M/DD/YY */
function weekRange(): { start: string; end: string } {
  const d = laToday();
  const dow = d.getUTCDay(); // 0=Sun
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  const saturday = new Date(monday);
  saturday.setUTCDate(monday.getUTCDate() + 5);
  const fmt = (x: Date) =>
    `${x.getUTCMonth() + 1}/${String(x.getUTCDate()).padStart(2, "0")}/${String(x.getUTCFullYear()).slice(2)}`;
  return { start: fmt(monday), end: fmt(saturday) };
}

/** ISO-8601 week label (e.g. "2026W30") for idempotency keys. */
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}W${String(week).padStart(2, "0")}`;
}

// Retry policy (keep in sync with the edge fn's monday.ts and
// scripts/migration/07-monday.mjs): HTTP 429/5xx, network failures, and
// GraphQL rate-limit/complexity/concurrency errors are retried up to
// MAX_ATTEMPTS, waiting the API's own hint (retry_in_seconds, Retry-After, or
// the RateLimit header's t=<reset-seconds>), exponential fallback, waits
// clamped to MAX_WAIT_S. Anything else throws immediately and the run's
// catch-all logs it. Mutations pass a STABLE Idempotency-Key (board
// duplication, webhook registration/removal): Monday replays the first
// response for a repeated key for 30 minutes, so a mid-run retry — or a
// whole cron re-run inside that window — recovers the already-created
// board/webhook id instead of creating a second one.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE_GQL = /complexity|rate.?limit|concurrency|minute limit|call limit/i;
const MAX_ATTEMPTS = 3;
const MAX_WAIT_S = 30;

function headerWaitSeconds(resp: Response): number | null {
  const ra = (resp.headers.get("retry-after") ?? "").trim();
  if (/^\d+$/.test(ra)) return Number(ra);
  const m = (resp.headers.get("ratelimit") ?? "").match(/(?:^|[;,\s])t=(\d+)/);
  return m ? Number(m[1]) : null;
}

type GqlErrorPayload = {
  errors?: Array<{ message?: string; extensions?: { code?: string; retry_in_seconds?: number } }>;
  error_code?: string;
  error_message?: string;
};

/** GraphQL error payload (current errors[].extensions shape or legacy
 *  top-level error_code/error_message): is it retryable, and how long does
 *  Monday ask us to wait? */
function gqlRetryInfo(json: GqlErrorPayload | null): {
  retryable: boolean;
  waitSeconds: number | null;
} {
  const errs = Array.isArray(json?.errors) ? [...json.errors] : [];
  if (json?.error_code || json?.error_message) {
    errs.push({ message: json.error_message, extensions: { code: json.error_code } });
  }
  let retryable = false;
  let waitSeconds: number | null = null;
  for (const e of errs) {
    const code = String(e?.extensions?.code ?? "");
    const msg = String(e?.message ?? "");
    if (!RETRYABLE_GQL.test(code) && !RETRYABLE_GQL.test(msg)) continue;
    retryable = true;
    const hint = Number(e?.extensions?.retry_in_seconds ?? NaN);
    const parsed = Number.isFinite(hint) ? hint : Number((msg.match(/reset in (\d+)/i) ?? [])[1]);
    if (Number.isFinite(parsed)) waitSeconds = Math.max(waitSeconds ?? 0, parsed);
  }
  return { retryable, waitSeconds };
}

async function monday(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
  opts?: { idempotencyKey?: string },
) {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp: Response | null = null;
    let bodyText = "";
    let waitS = 2 ** attempt;
    try {
      resp = await fetch(MONDAY_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
          "API-Version": "2026-07",
          ...(opts?.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
        },
        body: JSON.stringify(variables ? { query, variables } : { query }),
      });
      bodyText = await resp.text();
    } catch (e) {
      lastError = `Monday API network error: ${e instanceof Error ? e.message : String(e)}`;
      resp = null;
    }
    if (resp) {
      let json: (GqlErrorPayload & { data?: unknown }) | null = null;
      try {
        json = JSON.parse(bodyText) as GqlErrorPayload & { data?: unknown };
      } catch {
        /* non-JSON error body */
      }
      // 409 with an Idempotency-Key = the first send of this key is still
      // being processed; Retry-After says when its response will be ready.
      if (
        resp.status === 429 ||
        resp.status >= 500 ||
        (resp.status === 409 && opts?.idempotencyKey)
      ) {
        lastError = `Monday API: HTTP ${resp.status}: ${bodyText.slice(0, 200)}`;
        waitS = headerWaitSeconds(resp) ?? gqlRetryInfo(json).waitSeconds ?? 2 ** attempt;
      } else if (json && (json.errors || json.error_code || json.error_message)) {
        const { retryable, waitSeconds } = gqlRetryInfo(json);
        lastError = `Monday API: ${JSON.stringify(json.errors ?? json.error_message).slice(0, 400)}`;
        if (!retryable) throw new Error(lastError);
        waitS = waitSeconds ?? 2 ** attempt;
      } else if (json) {
        return json.data as Record<string, unknown>;
      } else {
        throw new Error(
          `Monday API: HTTP ${resp.status} non-JSON response: ${bodyText.slice(0, 200)}`,
        );
      }
    }
    if (attempt === MAX_ATTEMPTS) break;
    await sleep(Math.min(waitS, MAX_WAIT_S) * 1000);
  }
  throw new Error(`${lastError} (after ${MAX_ATTEMPTS} attempts)`);
}

export const Route = createFileRoute("/api/internal/rotate-boards")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});

async function handle(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: "CRON_SECRET not configured" }, 500);
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  // Vercel identifies which cron fired via x-vercel-cron-schedule; the header
  // fallback keeps the daily check working even if the ?mode=check query
  // string is ever stripped from the cron path.
  const mode = new URL(request.url).searchParams.get("mode");
  const schedule = request.headers.get("x-vercel-cron-schedule");
  if (mode === "check" || (!mode && schedule === CHECK_SCHEDULE)) return check();
  return rotate();
}

async function rotate(): Promise<Response> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const log = async (data: Record<string, unknown>) => {
    await supabaseAdmin
      .from("webhook_logs")
      .insert({ step: "Board_Rotation", data: data as never });
  };

  try {
    const { data: settings } = await supabaseAdmin
      .from("system_settings")
      .select(
        "monday_api_token, monday_template_board_id, monday_webhooks, active_monday_board_sd, active_monday_board_oc",
      )
      .maybeSingle();
    const token = settings?.monday_api_token as string | undefined;
    const templateId = settings?.monday_template_board_id as string | undefined;
    if (!token) return json({ error: "no monday_api_token" }, 500);
    if (!templateId) return json({ error: "no monday_template_board_id" }, 500);
    const registry: RegistryEntry[] = Array.isArray(settings?.monday_webhooks)
      ? (settings!.monday_webhooks as RegistryEntry[])
      : [];

    const { start, end } = weekRange();
    const summary: Record<string, unknown> = { week: `${start} - ${end}` };
    if (!process.env.MONDAY_WEBHOOK_SECRET)
      summary.webhook_secret_warning =
        "MONDAY_WEBHOOK_SECRET not set — new webhooks will be rejected by the edge function";

    // Existing boards, newest first.
    const boardsData = await monday(
      token,
      "query { boards(limit: 50, order_by: created_at) { id name } }",
    );
    const boards = (boardsData.boards as Array<{ id: string; name: string }>) ?? [];

    const newIds: Record<string, string> = {};
    for (const office of ["SD", "OC"] as const) {
      const existing = boards.find(
        (b) => new RegExp(`^${office}\\s+Block`, "i").test(b.name) && b.name.includes(start),
      );
      let boardId = existing?.id;
      if (!boardId) {
        const name = `${office} Block ${start} - ${end}`;
        // Office is part of the key: both offices duplicate the same template
        // in one run, and a shared key would replay SD's board for OC.
        const dup = await monday(
          token,
          `mutation ($b: ID!, $n: String!) { duplicate_board(board_id: $b, duplicate_type: duplicate_board_with_structure, board_name: $n) { board { id } } }`,
          { b: templateId, n: name },
          { idempotencyKey: `dup-${templateId}-${office}-${isoWeek(laToday())}` },
        );
        boardId = (dup.duplicate_board as { board: { id: string } }).board.id;
        summary[`${office}_created`] = { boardId, name };
      } else {
        summary[`${office}_existing`] = { boardId, name: existing!.name };
      }
      newIds[office] = String(boardId);

      for (const event of WEBHOOK_EVENTS) {
        const already = registry.some((r) => r.board_id === String(boardId) && r.event === event);
        if (already) continue;
        const created = await monday(
          token,
          `mutation ($b: ID!, $u: String!, $e: WebhookEventType!) { create_webhook(board_id: $b, url: $u, event: $e) { id } }`,
          { b: String(boardId), u: edgeUrl(), e: event },
          { idempotencyKey: `wh-${boardId}-${event}` },
        );
        registry.push({
          board_id: String(boardId),
          webhook_id: String((created.create_webhook as { id: string }).id),
          event,
          registered_at: new Date().toISOString(),
        });
      }
    }

    // Deregister webhooks for boards that are no longer active.
    const keep: RegistryEntry[] = [];
    const removed: string[] = [];
    for (const entry of registry) {
      if (entry.board_id === newIds.SD || entry.board_id === newIds.OC) {
        keep.push(entry);
        continue;
      }
      try {
        await monday(
          token,
          `mutation { delete_webhook(id: ${entry.webhook_id}) { id } }`,
          undefined,
          {
            idempotencyKey: `unwh-${entry.webhook_id}`,
          },
        );
        removed.push(entry.webhook_id);
      } catch {
        // Webhook may already be gone (board deleted/archived) — drop it either way.
        removed.push(`${entry.webhook_id} (delete failed; pruned from registry)`);
      }
    }
    summary.deregistered = removed;

    await supabaseAdmin
      .from("system_settings")
      .update({
        active_monday_board_sd: newIds.SD,
        active_monday_board_oc: newIds.OC,
        monday_webhooks: keep as never,
      })
      .not("id", "is", null);

    await log(summary);
    return json({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log({ error: message });
    return json({ ok: false, error: message }, 500);
  }
}

/** Daily self-heal: re-create dropped webhooks, purge strays on retired boards. */
async function check(): Promise<Response> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const log = async (data: Record<string, unknown>) => {
    await supabaseAdmin.from("webhook_logs").insert({ step: "Webhook_Check", data: data as never });
  };

  try {
    const { data: settings } = await supabaseAdmin
      .from("system_settings")
      .select("monday_api_token, monday_webhooks, active_monday_board_sd, active_monday_board_oc")
      .maybeSingle();
    const token = settings?.monday_api_token as string | undefined;
    if (!token) return json({ error: "no monday_api_token" }, 500);
    const active: Array<[string, string]> = [];
    if (settings?.active_monday_board_sd)
      active.push(["SD", String(settings.active_monday_board_sd)]);
    if (settings?.active_monday_board_oc)
      active.push(["OC", String(settings.active_monday_board_oc)]);
    if (!active.length) return json({ error: "no active_monday_board_* in system_settings" }, 500);
    const activeIds = new Set(active.map(([, id]) => id));

    let registry: RegistryEntry[] = Array.isArray(settings?.monday_webhooks)
      ? [...(settings!.monday_webhooks as RegistryEntry[])]
      : [];
    const registryBefore = JSON.stringify(registry);
    // Idempotency nonce for heal mutations: stable across one call's retry
    // attempts, fresh per run. A stable wh-<board>-<event> key would be wrong
    // here — a heal within 30 min of the rotation creating (or a user
    // deleting) the same board+event hook would replay the cached response
    // and adopt a dead webhook id instead of creating a live one.
    const runNonce = Date.now().toString(36);
    const issues: Record<string, unknown> = {};
    if (!process.env.MONDAY_WEBHOOK_SECRET)
      issues.webhook_secret_warning =
        "MONDAY_WEBHOOK_SECRET not set — re-created webhooks would be rejected by the edge function";

    const liveWebhooks = async (boardId: string) => {
      const data = await monday(token, `query ($b: ID!) { webhooks(board_id: $b) { id event } }`, {
        b: boardId,
      });
      return ((data.webhooks as Array<{ id: string; event: string }>) ?? []).map((w) => ({
        id: String(w.id),
        event: String(w.event),
      }));
    };

    // Every active board must have a live webhook per expected event. A hook
    // toggled off in the Integrations Center disappears from this list, so
    // "missing" covers both deleted and disabled.
    for (const [office, boardId] of active) {
      const live = await liveWebhooks(boardId);
      for (const event of WEBHOOK_EVENTS) {
        const found = live.find((w) => w.event === event);
        let entry: RegistryEntry;
        if (found) {
          if (registry.some((r) => r.board_id === boardId && r.webhook_id === found.id)) continue;
          // Live but unknown to the registry (id drifted) — adopt it.
          entry = {
            board_id: boardId,
            webhook_id: found.id,
            event,
            registered_at: new Date().toISOString(),
          };
          issues[`${office}_${event}`] = `adopted live webhook ${found.id}`;
        } else {
          const created = await monday(
            token,
            `mutation ($b: ID!, $u: String!, $e: WebhookEventType!) { create_webhook(board_id: $b, url: $u, event: $e) { id } }`,
            { b: boardId, u: edgeUrl(), e: event },
            { idempotencyKey: `heal-${boardId}-${event}-${runNonce}` },
          );
          entry = {
            board_id: boardId,
            webhook_id: String((created.create_webhook as { id: string }).id),
            event,
            registered_at: new Date().toISOString(),
          };
          issues[`${office}_${event}`] = `re-created as webhook ${entry.webhook_id}`;
        }
        registry = registry.filter((r) => !(r.board_id === boardId && r.event === event));
        registry.push(entry);
      }
    }

    // Retired Block boards must have no webhooks left — a failed rotation can
    // leave strays that keep firing into the edge function.
    const boardsData = await monday(
      token,
      "query { boards(limit: 50, order_by: created_at) { id name } }",
    );
    const boards = (boardsData.boards as Array<{ id: string; name: string }>) ?? [];
    const purged: string[] = [];
    for (const b of boards) {
      const boardId = String(b.id);
      if (activeIds.has(boardId) || !/^(SD|OC)\s+Block/i.test(b.name)) continue;
      let live: Array<{ id: string; event: string }>;
      try {
        live = await liveWebhooks(boardId);
      } catch {
        continue; // board gone or inaccessible — nothing left to purge
      }
      for (const w of live) {
        if (!(WEBHOOK_EVENTS as readonly string[]).includes(w.event)) continue;
        try {
          await monday(token, `mutation { delete_webhook(id: ${w.id}) { id } }`, undefined, {
            idempotencyKey: `unwh-${w.id}`,
          });
          purged.push(`${w.id} (${w.event} on "${b.name}")`);
        } catch {
          purged.push(`${w.id} (${w.event} on "${b.name}"; delete failed)`);
        }
      }
    }
    if (purged.length) issues.retired_purged = purged;
    registry = registry.filter((r) => activeIds.has(r.board_id));

    if (JSON.stringify(registry) !== registryBefore) {
      await supabaseAdmin
        .from("system_settings")
        .update({ monday_webhooks: registry as never })
        .not("id", "is", null);
    }

    const healthy = Object.keys(issues).length === 0;
    const summary = { healthy, checked: Object.fromEntries(active), ...issues };
    await log(summary);
    return json({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log({ error: message });
    return json({ ok: false, error: message }, 500);
  }
}
