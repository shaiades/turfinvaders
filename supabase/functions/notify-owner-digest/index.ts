// Web Push delivery for the God Mode morning digest (owner directive
// 2026-10-01). ONE caller: the webhook_logs God_Digest_Sent trigger
// (migration 20261001200000), which fires when the Vercel cron route
// claims the day — the same pg_net + vault doctrine as every other
// notify-* function. Audience: OWNER role push subscriptions only.
// Deployed with --no-verify-jwt; the shared NOTIFY_SECRET gates the path
// (never compare against this runtime's injected service key: its value
// does not match the Vercel side's copy on this project, which 401'd
// every direct delivery attempt).
// Secrets: VAPID_KEYS_JSON + NOTIFY_SECRET (same as the other notify fns).

import { createClient } from "jsr:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

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
  if (req.headers.get("x-notify-secret") !== Deno.env.get("NOTIFY_SECRET")) {
    return json({ error: "Unauthorized" }, 401);
  }

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
