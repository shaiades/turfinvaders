// Best-effort iMessage via Inkbox from the dispatcher identity (@tidaldispatcher)
// — Rule 6 (no-show at the door) and the Rule 7 late-report alert.
//
// Fully best-effort: never throws, and is a silent no-op until the secrets are
// set, so a missing/misconfigured Inkbox never blocks the disposition write.
//
// Secrets (set with: supabase secrets set ... — see the PR "turn it on" steps):
//   INKBOX_API_KEY            — the Inkbox API key
//   INKBOX_API_URL            — base URL (default https://api.inkbox.ai)
//   INKBOX_IDENTITY           — sending identity handle (default @tidaldispatcher)
//   INKBOX_DISPATCH_RECIPIENTS— comma-separated handles/numbers for Shai, Tyler, Jorge
//
// The exact Inkbox send contract is listed under "Decisions for Shai"; adjust
// `buildRequest` to match once confirmed. Until then this stays off by default.
const denoEnv = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno
  ?.env;

export type InkboxResult = { sent: boolean; skipped?: string; error?: string };

export async function sendDispatcherIMessage(text: string): Promise<InkboxResult> {
  const apiKey = denoEnv?.get("INKBOX_API_KEY");
  const recipients = (denoEnv?.get("INKBOX_DISPATCH_RECIPIENTS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!apiKey) return { sent: false, skipped: "INKBOX_API_KEY not set" };
  if (recipients.length === 0)
    return { sent: false, skipped: "INKBOX_DISPATCH_RECIPIENTS not set" };

  const baseUrl = (denoEnv?.get("INKBOX_API_URL") ?? "https://api.inkbox.ai").replace(/\/+$/, "");
  const identity = denoEnv?.get("INKBOX_IDENTITY") ?? "@tidaldispatcher";

  try {
    const resp = await fetch(`${baseUrl}/v1/imessage/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ identity, to: recipients, text }),
    });
    if (!resp.ok) {
      return {
        sent: false,
        error: `Inkbox HTTP ${resp.status}: ${(await resp.text()).slice(0, 160)}`,
      };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) };
  }
}
