// Best-effort iMessage via the Inkbox HTTP API from the dispatcher identity
// (@tidaldispatcher) — the SALE alert, Rule 6 (no-show at the door) and the
// Rule 7 late-report alert.
//
// Real Inkbox contract (confirmed 2026-10-05):
//   POST {INKBOX_API_URL}/imessage/messages?agent_identity_id=<id>
//   Header: X-API-Key: <INKBOX_API_KEY>        (NOT Bearer)
//   Body:   {"to": "+1XXXXXXXXXX", "text": "..."}
// There is no dedicated line, so a group send isn't possible — we send ONE
// request per recipient (1:1 iMessage to each of Shai / Tyler / Jorge).
//
// Fully best-effort: never throws, and is a silent no-op until INKBOX_API_KEY +
// INKBOX_DISPATCH_RECIPIENTS are set, so a missing/misconfigured Inkbox never
// blocks the disposition write. The caller logs any send failure to the queue.
//
// Secrets (set with: supabase secrets set ...):
//   INKBOX_API_KEY            — the Inkbox API key (sent as X-API-Key)
//   INKBOX_API_URL            — base URL (default https://inkbox.ai/api/v1)
//   INKBOX_AGENT_IDENTITY_ID  — sending identity id (default the dispatcher's)
//   INKBOX_DISPATCH_RECIPIENTS— comma-separated numbers for Shai, Tyler, Jorge
const denoEnv = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno
  ?.env;

const DEFAULT_API_URL = "https://inkbox.ai/api/v1";
const DEFAULT_AGENT_IDENTITY_ID = "2d0dbf34-9276-4f6a-b413-2ef1c5a71cfa"; // @tidaldispatcher

export type InkboxResult = {
  sent: boolean; // at least one recipient delivered
  attempted: number;
  delivered: number;
  skipped?: string; // set when not configured (feature off) — not a failure
  errors?: string[]; // per-recipient failures, for the caller to log
};

export type InkboxConfig = {
  apiKey: string | null;
  recipients: string[];
  baseUrl: string;
  agentIdentityId: string;
};

// A minimal fetch shape so the sender can be unit-tested with a mock.
export type InkboxFetchResponse = { ok: boolean; status: number; text: () => Promise<string> };
export type InkboxFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<InkboxFetchResponse>;

const defaultFetch: InkboxFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<InkboxFetchResponse>;

/**
 * Send `text` to EACH recipient 1:1 via the Inkbox iMessage API. Pure w.r.t. the
 * environment (takes its config + a fetch impl) so it's unit-testable with a
 * mocked fetch. Never throws: a per-recipient failure is captured in `errors`
 * and the others are still attempted.
 */
export async function sendImessageToRecipients(
  cfg: InkboxConfig,
  text: string,
  fetchImpl: InkboxFetch = defaultFetch,
): Promise<InkboxResult> {
  if (!cfg.apiKey)
    return { sent: false, attempted: 0, delivered: 0, skipped: "INKBOX_API_KEY not set" };
  if (cfg.recipients.length === 0)
    return {
      sent: false,
      attempted: 0,
      delivered: 0,
      skipped: "INKBOX_DISPATCH_RECIPIENTS not set",
    };

  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/imessage/messages?agent_identity_id=${encodeURIComponent(
    cfg.agentIdentityId,
  )}`;
  const errors: string[] = [];
  let delivered = 0;
  for (const to of cfg.recipients) {
    try {
      const resp = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": cfg.apiKey },
        body: JSON.stringify({ to, text }),
      });
      if (resp.ok) delivered += 1;
      else errors.push(`${to}: HTTP ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
    } catch (e) {
      errors.push(`${to}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    sent: delivered > 0,
    attempted: cfg.recipients.length,
    delivered,
    ...(errors.length ? { errors } : {}),
  };
}

/** Read Inkbox config from the environment and send to the dispatch recipients. */
export async function sendDispatcherIMessage(text: string): Promise<InkboxResult> {
  const cfg: InkboxConfig = {
    apiKey: denoEnv?.get("INKBOX_API_KEY") ?? null,
    recipients: (denoEnv?.get("INKBOX_DISPATCH_RECIPIENTS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    baseUrl: denoEnv?.get("INKBOX_API_URL") ?? DEFAULT_API_URL,
    agentIdentityId: denoEnv?.get("INKBOX_AGENT_IDENTITY_ID") ?? DEFAULT_AGENT_IDENTITY_ID,
  };
  return sendImessageToRecipients(cfg, text);
}
