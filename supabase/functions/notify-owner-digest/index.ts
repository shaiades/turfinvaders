// Web Push delivery for the God Mode morning digest (owner directive
// 2026-10-01). ONE caller: the Vercel cron route /api/internal/god-digest,
// which composes the text and authenticates with the project's service-role
// key (both sides already hold it — no new secret). Audience: OWNER role
// push subscriptions only. Deployed with --no-verify-jwt; this handler
// enforces its own auth. Secrets: VAPID_KEYS_JSON (same keypair as the
// other notify-* functions).

import { createClient } from "jsr:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_KEY);

let appServerPromise: Promise<webpush.ApplicationServer> | null = null;
function getAppServer(): Promise<webpush.ApplicationServer> {
  appServerPromise ??= (async () => {
    const vapidKeys = await webpush.importVapidKeys(
      JSON.parse(Deno.env.get("VAPID_KEYS_JSON")!),
      { extractable: false },
    );
    return await webpush.ApplicationServer.new({
      contactInformation: "mailto:shaiades@gmail.com",
      vapidKeys,
    });
  })();
  return appServerPromise;
}

type SubRow = { endpoint: string; p256dh: string; auth: string };

async function sendToSubs(
  subs: SubRow[],
  payload: { title: string; body: string; url: string; tag?: string },
): Promise<{ sent: number; pruned: number; failed: number }> {
  const server = await getAppServer();
  let sent = 0,
    pruned = 0,
    failed = 0;
  for (const s of subs) {
    try {
      const subscriber = server.subscribe({
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      });
      await subscriber.pushTextMessage(JSON.stringify(payload), {});
      sent++;
    } catch (e) {
      if (e instanceof webpush.PushMessageError && e.isGone()) {
        await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        pruned++;
      } else {
        failed++;
        console.error("push send failed", e instanceof Error ? e.message : e);
      }
    }
  }
  return { sent, pruned, failed };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  // Server-to-server only: the caller must present the service-role key.
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${SERVICE_KEY}`) return json({ error: "Unauthorized" }, 401);

  let payload: { title?: string; body?: string; url?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!payload.title || !payload.body) return json({ error: "title and body required" }, 400);

  const { data: owners, error: ownersErr } = await admin
    .from("user_roles")
    .select("user_id")
    .eq("role", "owner");
  if (ownersErr) return json({ error: ownersErr.message }, 500);
  const ownerIds = (owners ?? []).map((r) => r.user_id);
  if (ownerIds.length === 0) return json({ sent: 0, reason: "no owners" });

  const { data: subs, error: subsErr } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .in("user_id", ownerIds);
  if (subsErr) return json({ error: subsErr.message }, 500);

  const result = await sendToSubs((subs ?? []) as SubRow[], {
    title: payload.title,
    body: payload.body,
    url: payload.url ?? "/god-mode",
    tag: "god-digest",
  });
  return json(result);
});
