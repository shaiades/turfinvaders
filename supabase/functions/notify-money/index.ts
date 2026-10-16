// Web Push for the Phase 4 §7 money moments — lead confirmed, your lead sold,
// passed on Today, one sit from the next tier, $10K from the next $1,500.
// Called by public.money_push() via pg_net with x-notify-secret; the SQL side
// owns the gating (arcade_flags.feed_push), the per-person daily cap, and the
// exactly-once dedupe (money_push_log) — this function just delivers one
// {title, body, url} to ONE user's devices. Deployed --no-verify-jwt (a
// trigger can't sign a user JWT); the shared NOTIFY_SECRET gates the path.
// Secrets: VAPID_KEYS_JSON + NOTIFY_SECRET, same pair as every notify-*.

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
    user_id?: string;
    title?: string;
    body?: string;
    url?: string;
    tag?: string;
  } | null;
  if (!body?.user_id || !body?.title || !body?.body) {
    return new Response("bad request", { status: 400 });
  }

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_id", body.user_id);
  const result = await sendToSubs(subs ?? [], {
    title: body.title,
    body: body.body,
    url: body.url ?? "/dashboard?tab=dispatch",
    tag: body.tag,
  });
  return json({ ...result, matched: 1 });
});
