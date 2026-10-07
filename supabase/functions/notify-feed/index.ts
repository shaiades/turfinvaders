// Web Push for Street Feed big moments (§7). Called by the feed_push trigger
// via pg_net with x-notify-secret once the owner flips arcade_flags.feed_push
// on. The SQL side owns the ≤5/day cap and the push-worthy-kind gate; this
// function just fans a {title, body, url} payload out to field + leadership
// devices. Deployed --no-verify-jwt (the trigger can't sign a user JWT); the
// shared NOTIFY_SECRET gates the path. Secrets: VAPID_KEYS_JSON + NOTIFY_SECRET,
// the same pair as the other notify-* functions.

import { createClient } from "jsr:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

let appServerPromise: Promise<webpush.ApplicationServer> | null = null;
function getAppServer(): Promise<webpush.ApplicationServer> {
  appServerPromise ??= (async () => {
    const vapidKeys = await webpush.importVapidKeys(JSON.parse(Deno.env.get("VAPID_KEYS_JSON")!), {
      extractable: false,
    });
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
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (req.headers.get("x-notify-secret") !== Deno.env.get("NOTIFY_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as {
    title?: string;
    body?: string;
    url?: string;
    tag?: string;
  } | null;
  if (!body?.title || !body?.body) return new Response("bad request", { status: 400 });

  // Audience = the field tier + the leadership who watch the feed (sales reps
  // live in Close Kombat, out). Multi-role users dedupe via the Set.
  const { data: roleRows } = await admin
    .from("user_roles")
    .select("user_id")
    .in("role", ["canvasser", "confirmer", "captain", "owner", "office_staff"]);
  const targets = [...new Set((roleRows ?? []).map((r: { user_id: string }) => r.user_id))];
  if (targets.length === 0) return json({ sent: 0, pruned: 0, failed: 0, matched: 0 });

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .in("user_id", targets);
  const result = await sendToSubs(subs ?? [], {
    title: body.title,
    body: body.body,
    url: body.url ?? "/leaderboard",
    tag: body.tag,
  });
  return json({ ...result, matched: targets.length });
});
