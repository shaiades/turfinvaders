/**
 * Monday GraphQL client for the live-dispatch webhook: bounded retries on
 * rate limits plus cross-request batching of item fetches. Retry semantics
 * are kept in sync with scripts/migration/07-monday.mjs and
 * src/routes/api/internal/rotate-boards.ts (one helper per runtime).
 *
 * Retry policy — HTTP 429/5xx, network failures, and GraphQL rate-limit /
 * complexity / concurrency errors are retried up to MAX_ATTEMPTS, waiting the
 * API's own hint (retry_in_seconds in the error, Retry-After, or the
 * RateLimit header's t=<reset-seconds> field; exponential fallback). A hint
 * beyond MAX_WAIT_MS fails fast instead of waiting: the caller answers 502
 * and Monday's own once-a-minute redelivery loop (30 minutes) becomes the
 * outer retry — the Event_Processed marker is only written after success, so
 * redeliveries are never swallowed. Failed calls cost only 0.1 daily API
 * calls, so short in-process retries are cheap.
 *
 * Batching — a Monday bulk edit fires one webhook per item, which naively
 * means one items() query per event (an ~800-item board ≈ 800 calls) and can
 * blow the 1,000-calls/day cap on lower tiers. fetchItemBatched() coalesces
 * item fetches across concurrent invocations of this isolate for
 * BATCH_WINDOW_MS and issues a single items(ids: [...]) query per flush
 * (items(ids:) accepts at most 100 ids). Batching also keeps us under the
 * 40-call concurrency cap during bulk edits.
 */

// Pin the Current API version deliberately. Monday silently reroutes retired
// versions to its rolling Maintenance version (2024-01 has been rerouted for
// years), so an outdated pin means unpinned. Bump quarterly with the release
// notes; never pin the RC.
export const MONDAY_API_VERSION = "2026-07";

// Deno-agnostic env read so this module is unit-testable under Node.
const MONDAY_API_URL =
  (
    globalThis as unknown as { Deno?: { env: { get(k: string): string | undefined } } }
  ).Deno?.env.get("MONDAY_API_URL") ?? "https://api.monday.com/v2";

const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 8_000; // a webhook reply must beat Monday's delivery timeout
const BATCH_WINDOW_MS = 250;
const BATCH_MAX_IDS = 100; // items(ids: [...]) accepts at most 100 ids

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RETRYABLE_GQL = /complexity|rate.?limit|concurrency|minute limit|call limit/i;

/** Wait hint from response headers: Retry-After (seconds) or the RateLimit
 *  header's t=<seconds-until-reset> field. */
function headerWaitSeconds(resp: Response): number | null {
  const ra = (resp.headers.get("retry-after") ?? "").trim();
  if (/^\d+$/.test(ra)) return Number(ra);
  const m = (resp.headers.get("ratelimit") ?? "").match(/(?:^|[;,\s])t=(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Inspect a GraphQL error payload — current shape (errors[].extensions.code
 *  + retry_in_seconds) or legacy top-level error_code/error_message — for
 *  rate/complexity errors and Monday's requested wait. */
function gqlRetryInfo(json: unknown): { retryable: boolean; waitSeconds: number | null } {
  const j = json as {
    errors?: Array<{ message?: string; extensions?: { code?: string; retry_in_seconds?: number } }>;
    error_code?: string;
    error_message?: string;
  };
  const errs = Array.isArray(j?.errors) ? [...j.errors] : [];
  if (j?.error_code || j?.error_message) {
    errs.push({ message: j.error_message, extensions: { code: j.error_code } });
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

export type MondayResult = { data: Record<string, unknown> | null; error: string | null };

/** POST one GraphQL document with the retry policy described above. Never
 *  throws — any terminal failure comes back as { data: null, error }. */
export async function mondayQuery(token: string, query: string): Promise<MondayResult> {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp: Response | null = null;
    let bodyText = "";
    let waitMs = 2 ** attempt * 1000;
    try {
      resp = await fetch(MONDAY_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
          "API-Version": MONDAY_API_VERSION,
        },
        body: JSON.stringify({ query }),
      });
      bodyText = await resp.text();
    } catch (e) {
      lastError = `network error: ${e instanceof Error ? e.message : String(e)}`;
      resp = null;
    }
    if (resp) {
      let json: { data?: Record<string, unknown>; errors?: unknown } | null = null;
      try {
        json = JSON.parse(bodyText);
      } catch {
        /* non-JSON error body */
      }
      if (resp.status === 429 || resp.status >= 500) {
        lastError = `HTTP ${resp.status}: ${bodyText.slice(0, 200)}`;
        waitMs = (headerWaitSeconds(resp) ?? gqlRetryInfo(json).waitSeconds ?? 2 ** attempt) * 1000;
      } else if (
        json &&
        (json.errors ||
          (json as { error_code?: string }).error_code ||
          (json as { error_message?: string }).error_message)
      ) {
        const { retryable, waitSeconds } = gqlRetryInfo(json);
        lastError = JSON.stringify(
          json.errors ?? (json as { error_message?: string }).error_message,
        ).slice(0, 300);
        if (!retryable) return { data: null, error: lastError };
        waitMs = (waitSeconds ?? 2 ** attempt) * 1000;
      } else if (json) {
        return { data: json.data ?? null, error: null };
      } else {
        lastError = `HTTP ${resp.status}: non-JSON response`;
      }
    }
    // Out of attempts, or Monday asked for a wait longer than a webhook
    // handler should hold: fail fast and let Monday's redelivery retry us.
    if (attempt === MAX_ATTEMPTS || waitMs > MAX_WAIT_MS) break;
    await sleep(waitMs);
  }
  return { data: null, error: lastError };
}

export type ItemFetchResult = { item: Record<string, unknown> | null; error: string | null };

const ITEM_FIELDS =
  "id name board { id } column_values { id text column { title id } ... on FormulaValue { display_value } }";

type Waiter = (r: ItemFetchResult) => void;
let batch: { token: string; waiters: Map<string, Waiter[]> } | null = null;
let batchTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Fetch one item's full column set, coalescing with other in-flight webhook
 * deliveries: the first caller opens a BATCH_WINDOW_MS window, later callers
 * join it, and the whole window resolves off a single items(ids: [...])
 * query. Every waiter is an open HTTP request, so the isolate stays alive for
 * the window. The batch runs on the first caller's token (all deliveries
 * read the same system_settings token). `pulseId` must be numeric-validated
 * by the caller — ids are interpolated into the GraphQL document.
 */
export function fetchItemBatched(token: string, pulseId: string): Promise<ItemFetchResult> {
  return new Promise((resolve) => {
    if (!batch) {
      batch = { token, waiters: new Map() };
      batchTimer = setTimeout(flushBatch, BATCH_WINDOW_MS);
    }
    const list = batch.waiters.get(pulseId) ?? [];
    list.push(resolve);
    batch.waiters.set(pulseId, list);
    if (batch.waiters.size >= BATCH_MAX_IDS) {
      clearTimeout(batchTimer);
      void flushBatch();
    }
  });
}

async function flushBatch(): Promise<void> {
  const current = batch;
  batch = null;
  if (!current) return;
  const ids = [...current.waiters.keys()];
  const { data, error } = await mondayQuery(
    current.token,
    `query { items(ids: [${ids.join(", ")}]) { ${ITEM_FIELDS} } }`,
  );
  const items = new Map<string, Record<string, unknown>>(
    ((data?.items as Array<Record<string, unknown>> | undefined) ?? []).map((it) => [
      String(it.id),
      it,
    ]),
  );
  for (const [id, waiters] of current.waiters) {
    const result: ItemFetchResult = { item: items.get(id) ?? null, error };
    for (const w of waiters) w(result);
  }
}
