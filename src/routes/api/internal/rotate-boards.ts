import { createFileRoute } from "@tanstack/react-router";
import { laWeekStartISO } from "@/lib/dates";

/**
 * Monday.com board rotation + webhook self-heal (Vercel Cron).
 *
 * Default mode — weekly rotation (Mondays 13:00 UTC = 6am PT):
 * For each office (SD, OC), this week's Block board is found by PARSED
 * week-start date (the crews hand-name boards — "8/3/26", "8/03/26", double
 * spaces — so raw-string matching is never trusted; the 8/3/26 zero-padding
 * mismatch sent a whole week of webhooks to an empty duplicate board) — or
 * created by duplicating the structure-only template board — then the
 * create_item + change_column_value webhooks are registered on it (skipped if
 * the registry already has them), system_settings.active_monday_board_* is
 * updated, and webhooks for prior weeks' boards are deregistered. Idempotent:
 * safe to re-run any number of times in a week.
 *
 * ?mode=check — daily webhook self-heal (13:30 UTC): first it re-runs board
 * discovery for the current week — if the best board for either office is not
 * the one system_settings points at (the crews created their own board before
 * or after the rotation ran), the whole rotation re-runs and adopts it, moving
 * webhooks and settings. Then: webhooks created with a
 * personal API token can be toggled off by any board user in Monday's
 * Integrations Center, and Monday never turns them back on. This mode compares
 * the live webhooks(board_id:) list on both active boards against the expected
 * events, re-creates anything missing, syncs the monday_webhooks registry, and
 * audits retired Block boards to confirm rotation really removed their hooks.
 * Monday can also hand back a webhook id from create_webhook that the list
 * query returns but that NEVER delivers — no challenge POST, no events
 * (2026-07-21: 3 of 4 hooks in one registration batch were dead this way) —
 * so the check additionally cross-references each active board's recent
 * activity_logs against the edge function's 2_Payload_Parsed rows in
 * webhook_logs and replaces any hook whose event type shows board activity
 * but zero deliveries.
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
  const url = secret ? `${base}&secret=${secret}` : base;
  if (url.length > 255) {
    throw new Error(`webhook URL is ${url.length} chars — Monday caps webhook URLs at 255`);
  }
  return url;
}
const WEBHOOK_EVENTS = ["create_item", "change_column_value"] as const;
// The static Incoming Leads board also carries a column-scoped status hook:
// only the confirmation team's "Lead Status" column may fire (an unscoped
// change_column_value hook on the 5,000+-item CRM board would flood the edge
// function). The edge function drops any other column defensively too.
const LEAD_STATUS_EVENT = "change_status_column_value" as const;
const LEAD_STATUS_COLUMN_ID = "dup__of_sd_lead";
type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | typeof LEAD_STATUS_EVENT;
// Schedule of the daily check cron — keep in sync with vercel.json. Used as a
// fallback to route the request when the query string is absent.
const CHECK_SCHEDULE = "30 13 * * *";

// Delivery-based liveness (check() only). Activity is judged over at most
// LIVENESS_WINDOW_MS, never earlier than the board's newest webhook
// registration (a fresh hook can't have delivered older events), and never
// later than LIVENESS_LAG_MS ago (deliveries trail activity by a few
// seconds). Boards whose judgeable window comes out shorter than
// LIVENESS_MIN_WINDOW_MS wait for the next daily run.
const LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1000;
const LIVENESS_LAG_MS = 5 * 60 * 1000;
const LIVENESS_MIN_WINDOW_MS = 60 * 60 * 1000;
// Per webhook event: the activity_logs event it should mirror, and the
// data->>isCreateEvent value its 2_Payload_Parsed rows carry.
const LIVENESS_MAP: Record<
  (typeof WEBHOOK_EVENTS)[number],
  { activityEvent: string; isCreate: "true" | "false" }
> = {
  create_item: { activityEvent: "create_pulse", isCreate: "true" },
  change_column_value: { activityEvent: "update_column_value", isCreate: "false" },
};

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

// Retry policy (keep in sync with the edge fn's monday.ts — the Deno
// function cannot import from src/): HTTP 429/5xx, network failures, and
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

/** This week's Block board for an office: any "<office> Block …" board whose
 *  name PARSES to the given week's Monday (parseBoardWeekStart normalizes any
 *  M/D/YY spelling — "8/3/26", "8/03/26" — to its Monday, exactly like the
 *  Close Kombat sync). When several boards name the same week (a rotation
 *  duplicate racing the crews' hand-made board), the one with the most items
 *  wins — the board actually being worked is the board — and ties go to the
 *  newest (`boards` arrives newest-first). */
async function findWeekBoard(
  token: string,
  boards: Array<{ id: string; name: string }>,
  office: "SD" | "OC",
  weekStartISO: string,
  parseWeek: (name: string) => string | null,
): Promise<{ id: string; name: string } | null> {
  const rx = new RegExp(`^${office}\\s+Block`, "i");
  const cands = boards.filter((b) => rx.test(b.name.trim()) && parseWeek(b.name) === weekStartISO);
  if (cands.length <= 1) return cands[0] ?? null;
  const counts = await monday(
    token,
    `query ($ids: [ID!]) { boards(ids: $ids) { id items_count } }`,
    { ids: cands.map((c) => c.id) },
  );
  const byId = new Map(
    ((counts.boards as Array<{ id: string; items_count: number | null }>) ?? []).map((b) => [
      String(b.id),
      b.items_count ?? 0,
    ]),
  );
  return cands.reduce((best, c) => ((byId.get(c.id) ?? 0) > (byId.get(best.id) ?? 0) ? c : best));
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
        "monday_api_token, monday_template_board_id, monday_webhooks, active_monday_board_sd, active_monday_board_oc, incoming_leads_board_id",
      )
      .maybeSingle();
    const token = settings?.monday_api_token as string | undefined;
    const templateId = settings?.monday_template_board_id as string | undefined;
    const incomingLeadsBoardId = String(settings?.incoming_leads_board_id ?? "");
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
    const boards = ((boardsData.boards as Array<{ id: string; name: string }>) ?? []).map((b) => ({
      id: String(b.id),
      name: b.name,
    }));
    const { parseBoardWeekStart } = await import("@/lib/block-cards.server");
    const weekStartISO = laWeekStartISO();

    const newIds: Record<string, string> = {};
    for (const office of ["SD", "OC"] as const) {
      const existing = await findWeekBoard(
        token,
        boards,
        office,
        weekStartISO,
        parseBoardWeekStart,
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

    // Deregister webhooks for boards that are no longer active. The static
    // Incoming Leads board never rotates — its hook must survive Mondays.
    const keep: RegistryEntry[] = [];
    const removed: string[] = [];
    for (const entry of registry) {
      if (
        entry.board_id === newIds.SD ||
        entry.board_id === newIds.OC ||
        (incomingLeadsBoardId && entry.board_id === incomingLeadsBoardId)
      ) {
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
      .select(
        "monday_api_token, monday_webhooks, active_monday_board_sd, active_monday_board_oc, incoming_leads_board_id",
      )
      .maybeSingle();
    const token = settings?.monday_api_token as string | undefined;
    if (!token) return json({ error: "no monday_api_token" }, 500);
    // [label, boardId, expected events]. The static Incoming Leads board gets
    // create_item plus the column-scoped Lead Status hook — never a blanket
    // change_column_value (it would flood the edge function on a 5,000+-item
    // CRM board, and the liveness healer must never "replace" one into
    // existence there).
    const active: Array<[string, string, ReadonlyArray<WebhookEvent>]> = [];
    if (settings?.active_monday_board_sd)
      active.push(["SD", String(settings.active_monday_board_sd), WEBHOOK_EVENTS]);
    if (settings?.active_monday_board_oc)
      active.push(["OC", String(settings.active_monday_board_oc), WEBHOOK_EVENTS]);
    if (!active.length) return json({ error: "no active_monday_board_* in system_settings" }, 500);
    if (settings?.incoming_leads_board_id)
      active.push(["Leads", String(settings.incoming_leads_board_id), ["create_item", LEAD_STATUS_EVENT]]);
    const activeIds = new Set(active.map(([, id]) => id));

    // ── Active-board drift ── the crews hand-create week boards, sometimes
    // before the Monday rotation runs, sometimes after. If the best board for
    // the CURRENT week (parsed-date match, most items wins) is not the one
    // system_settings points at, the webhooks are listening to the wrong
    // board — every outcome silently vanishes (week of 8/3/26). Re-run the
    // full rotation: it adopts the real board, moves the webhooks, updates
    // settings, and deregisters the orphan's hooks.
    {
      const { parseBoardWeekStart } = await import("@/lib/block-cards.server");
      const weekStartISO = laWeekStartISO();
      const boardsData = await monday(
        token,
        "query { boards(limit: 50, order_by: created_at) { id name } }",
      );
      const allBoards = ((boardsData.boards as Array<{ id: string; name: string }>) ?? []).map(
        (b) => ({ id: String(b.id), name: b.name }),
      );
      for (const office of ["SD", "OC"] as const) {
        const activeId = String(
          (office === "SD" ? settings?.active_monday_board_sd : settings?.active_monday_board_oc) ??
            "",
        );
        const best = await findWeekBoard(
          token,
          allBoards,
          office,
          weekStartISO,
          parseBoardWeekStart,
        );
        if (best && best.id !== activeId) {
          await log({
            drift: {
              office,
              week_start: weekStartISO,
              active_board: activeId || null,
              real_board: { id: best.id, name: best.name },
              action: "re-running rotation to adopt the board actually in use",
            },
          });
          return rotate();
        }
      }
    }

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

    // The Lead Status hook must be created column-scoped, or Monday would fire
    // it for every status column on the board (Office, Blowout Text, …).
    const createWebhook = async (boardId: string, event: WebhookEvent, idempotencyKey: string) => {
      const args: Record<string, unknown> = { b: boardId, u: edgeUrl(), e: event };
      let mutation = `mutation ($b: ID!, $u: String!, $e: WebhookEventType!) { create_webhook(board_id: $b, url: $u, event: $e) { id } }`;
      if (event === LEAD_STATUS_EVENT) {
        mutation = `mutation ($b: ID!, $u: String!, $e: WebhookEventType!, $c: JSON!) { create_webhook(board_id: $b, url: $u, event: $e, config: $c) { id } }`;
        args.c = JSON.stringify({ columnId: LEAD_STATUS_COLUMN_ID, columnValue: { "$any$": true } });
      }
      const created = await monday(token, mutation, args, { idempotencyKey });
      return String((created.create_webhook as { id: string }).id);
    };

    // Every active board must have a live webhook per expected event. A hook
    // toggled off in the Integrations Center disappears from this list, so
    // "missing" covers both deleted and disabled.
    const liveByBoard = new Map<string, Array<{ id: string; event: string }>>();
    for (const [office, boardId, events] of active) {
      const live = await liveWebhooks(boardId);
      liveByBoard.set(boardId, live);
      for (const event of events) {
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
          const createdId = await createWebhook(boardId, event, `heal-${boardId}-${event}-${runNonce}`);
          entry = {
            board_id: boardId,
            webhook_id: createdId,
            event,
            registered_at: new Date().toISOString(),
          };
          issues[`${office}_${event}`] = `re-created as webhook ${entry.webhook_id}`;
        }
        registry = registry.filter((r) => !(r.board_id === boardId && r.event === event));
        registry.push(entry);
      }
    }

    // Delivery-based liveness: the list comparison above cannot see a hook
    // that Monday lists but never fires (the 2026-07-21 failure mode), so
    // cross-check what actually happened on each board against what actually
    // arrived at the edge function. Relevant activity with zero deliveries
    // for that event type means the listed hook is dead — replace it. A board
    // healed by the loop above self-excludes here: its fresh registered_at
    // shrinks the judgeable window below the minimum until the next run.
    const liveness: Record<string, string> = {};
    const nowMs = Date.now();
    for (const [office, boardId, events] of active) {
      const newestReg = Math.max(
        0,
        ...registry
          .filter((r) => r.board_id === boardId)
          .map((r) => Date.parse(r.registered_at) || 0),
      );
      const since = Math.max(nowMs - LIVENESS_WINDOW_MS, newestReg);
      const judgeTo = nowMs - LIVENESS_LAG_MS;
      if (judgeTo - since < LIVENESS_MIN_WINDOW_MS) {
        liveness[office] = "skipped — webhooks registered too recently to judge deliveries";
        continue;
      }
      const sinceIso = new Date(since).toISOString();
      // One page of activity is enough — the check needs "did anything
      // relevant happen", not an exact total. activity_logs has no event
      // filter, so on a board busy enough to push all create/column events
      // past 100 rows this can under-count and defer detection to tomorrow.
      const actData = await monday(
        token,
        `query ($b: ID!, $from: ISO8601DateTime!, $to: ISO8601DateTime!) { boards(ids: [$b]) { activity_logs(from: $from, to: $to, limit: 100) { event data } } }`,
        { b: boardId, from: sinceIso, to: new Date(judgeTo).toISOString() },
      );
      const activity =
        ((actData.boards as Array<{ activity_logs: Array<{ event: string; data?: string | null }> | null }>) ?? [])[0]
          ?.activity_logs ?? [];
      for (const event of events) {
        let activityEvent: string;
        let isCreate: "true" | "false";
        let activityCount: number;
        if (event === LEAD_STATUS_EVENT) {
          // Column-scoped hook: only Lead Status column updates count as
          // expected activity (the activity entry's data JSON carries the
          // column id). Deliveries: on the leads board the status hook is
          // the ONLY non-create hook, so boardId + isCreateEvent=false rows
          // are exactly its deliveries. This is what catches a listed-but-
          // dead status hook (the 2026-07-28 zombie, id 603027905).
          activityEvent = "update_column_value";
          isCreate = "false";
          activityCount = activity.filter(
            (a) => a.event === "update_column_value" && (a.data ?? "").includes(LEAD_STATUS_COLUMN_ID),
          ).length;
        } else {
          const mapping = LIVENESS_MAP[event as (typeof WEBHOOK_EVENTS)[number]];
          activityEvent = mapping.activityEvent;
          isCreate = mapping.isCreate;
          activityCount = activity.filter((a) => a.event === activityEvent).length;
        }
        if (!activityCount) {
          liveness[`${office}_${event}`] = "no recent board activity to judge";
          continue;
        }
        const { count, error } = await supabaseAdmin
          .from("webhook_logs")
          .select("id", { count: "exact", head: true })
          .eq("step", "2_Payload_Parsed")
          .eq("data->>boardId", boardId)
          .eq("data->>isCreateEvent", isCreate)
          .gte("created_at", sinceIso);
        if (error) {
          liveness[`${office}_${event}`] = `delivery count failed: ${error.message}`;
          continue;
        }
        if ((count ?? 0) > 0) {
          liveness[`${office}_${event}`] = `ok — ${activityCount} events, ${count} deliveries`;
          continue;
        }
        // Listed but dead. delete_webhook may fail if the hook evaporated on
        // Monday's side — the replacement below is what matters either way.
        const stale = (liveByBoard.get(boardId) ?? []).filter((w) => w.event === event);
        for (const w of stale) {
          try {
            await monday(token, `mutation { delete_webhook(id: ${w.id}) { id } }`, undefined, {
              idempotencyKey: `unwh-${w.id}`,
            });
          } catch {
            /* already gone */
          }
        }
        const deadArgs: Record<string, unknown> = { b: boardId, u: edgeUrl(), e: event };
        let deadMutation = `mutation ($b: ID!, $u: String!, $e: WebhookEventType!) { create_webhook(board_id: $b, url: $u, event: $e) { id } }`;
        if (event === LEAD_STATUS_EVENT) {
          deadMutation = `mutation ($b: ID!, $u: String!, $e: WebhookEventType!, $c: JSON!) { create_webhook(board_id: $b, url: $u, event: $e, config: $c) { id } }`;
          deadArgs.c = JSON.stringify({ columnId: LEAD_STATUS_COLUMN_ID, columnValue: { "$any$": true } });
        }
        const created = await monday(token, deadMutation, deadArgs, {
          idempotencyKey: `heal-dead-${boardId}-${event}-${runNonce}`,
        });
        const newId = String((created.create_webhook as { id: string }).id);
        registry = registry.filter((r) => !(r.board_id === boardId && r.event === event));
        registry.push({
          board_id: boardId,
          webhook_id: newId,
          event,
          registered_at: new Date().toISOString(),
        });
        issues[`${office}_${event}_dead`] =
          `${activityCount} ${activityEvent} event(s) since ${sinceIso} but 0 deliveries — ` +
          `replaced webhook(s) [${stale.map((w) => w.id).join(", ") || "none listed"}] with ${newId}`;
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
    const summary = { healthy, checked: Object.fromEntries(active), liveness, ...issues };
    await log(summary);
    return json({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log({ error: message });
    return json({ ok: false, error: message }, 500);
  }
}
