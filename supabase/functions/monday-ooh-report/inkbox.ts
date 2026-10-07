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
  // Harden the key: secrets set via copy/paste pick up trailing newlines or
  // mojibake (the pbcopy trap), and fetch() rejects any header value that
  // isn't a ByteString — which killed EVERY send on shadow night 10/6 with
  // "'headers' of 'RequestInit' is not a valid ByteString". Trim fixes the
  // newline case; anything still non-printable-ASCII is a corrupt secret and
  // gets a loud, actionable error instead of the cryptic constructor throw.
  let apiKey = (cfg.apiKey ?? "").trim();
  if (!apiKey)
    return { sent: false, attempted: 0, delivered: 0, skipped: "INKBOX_API_KEY not set" };
  // Inkbox keys read "ApiKey_<secret>" and the console shows the full string
  // only once — a hand-selected copy easily drops the prefix (it did on
  // 2026-10-07: 53 chars, 401 on every send). Re-attach it; a wrong guess
  // still just 401s, so this can't make anything worse.
  if (!apiKey.startsWith("ApiKey_")) apiKey = `ApiKey_${apiKey}`;
  if (!/^[\x20-\x7e]+$/.test(apiKey)) {
    return {
      sent: false,
      attempted: 0,
      delivered: 0,
      errors: [
        "INKBOX_API_KEY contains non-ASCII/control characters (pbcopy mojibake?) — re-set the secret and redeploy",
      ],
    };
  }
  const recipients = cfg.recipients.map((r) => r.trim()).filter(Boolean);
  if (recipients.length === 0)
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
  for (const to of recipients) {
    try {
      const resp = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
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
    attempted: recipients.length,
    delivered,
    ...(errors.length ? { errors } : {}),
  };
}

/** Shape-only diagnostics for the configured key (ops test endpoint): Inkbox
 *  keys read "ApiKey_…", so a missing prefix or odd length means a bad copy.
 *  Never exposes the key itself. */
export function dispatcherKeyDiagnostics(): {
  present: boolean;
  length: number;
  hasApiKeyPrefix: boolean;
} {
  const raw =
    [denoEnv?.get("INKBOX_API_KEY"), denoEnv?.get("INBOX_API_KEY")].find(
      (v) => v && v.trim() && v.trim() !== "PASTE_THE_REAL_KEY_HERE",
    ) ?? "";
  const key = raw.trim();
  return { present: key.length > 0, length: key.length, hasApiKeyPrefix: key.startsWith("ApiKey_") };
}

/** Read Inkbox config from the environment and send to the dispatch recipients. */
export async function sendDispatcherIMessage(text: string): Promise<InkboxResult> {
  const cfg: InkboxConfig = {
    // The working key was saved in the dashboard as INBOX_API_KEY (typo,
    // 2026-10-07) and Supabase secret values can't be read back to re-file
    // under the right name — so accept both. INKBOX_API_KEY wins if ever set
    // correctly; the placeholder value it held was replaced by preferring a
    // real-looking value (see guard below for corrupt keys either way).
    apiKey:
      [denoEnv?.get("INKBOX_API_KEY"), denoEnv?.get("INBOX_API_KEY")].find(
        (v) => v && v.trim() && v.trim() !== "PASTE_THE_REAL_KEY_HERE",
      ) ?? null,
    recipients: (denoEnv?.get("INKBOX_DISPATCH_RECIPIENTS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    baseUrl: denoEnv?.get("INKBOX_API_URL") ?? DEFAULT_API_URL,
    agentIdentityId: denoEnv?.get("INKBOX_AGENT_IDENTITY_ID") ?? DEFAULT_AGENT_IDENTITY_ID,
  };
  return sendImessageToRecipients(cfg, text);
}
