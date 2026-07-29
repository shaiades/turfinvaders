/**
 * Monday GraphQL client for Node server code (Close Kombat sync).
 *
 * KEEP IN SYNC: retry semantics are duplicated per runtime — this file,
 * src/routes/api/internal/rotate-boards.ts (its inline monday() helper),
 * and supabase/functions/monday-live-dispatch/monday.ts (Deno). The edge
 * function cannot import from src/ and vice versa.
 *
 * Retry policy: HTTP 429/5xx, network failures, and GraphQL rate-limit/
 * complexity/concurrency errors are retried up to MAX_ATTEMPTS, waiting the
 * API's own hint (retry_in_seconds, Retry-After, or the RateLimit header's
 * t=<reset-seconds>), exponential fallback, waits clamped to MAX_WAIT_S.
 * Anything else throws immediately. Mutations may pass a STABLE
 * Idempotency-Key — Monday replays the first response for a repeated key
 * for 30 minutes.
 */

const MONDAY_API = process.env.MONDAY_API_URL || "https://api.monday.com/v2";

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

export async function monday(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
  opts?: { idempotencyKey?: string },
): Promise<Record<string, unknown>> {
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
