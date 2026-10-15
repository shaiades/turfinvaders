// Web Push: paid rest-break reminder to the WORKER (CA compliance phase 1,
// owner ask 2026-10-14). The send_rest_reminders cron calls this (via
// pg_net, x-notify-secret) twice per shift: stage 1 around 2 hours on the
// clock, stage 2 around 6 hours — the territory of the first and second
// 10-minute rest breaks (one per 4 hours worked or major fraction).
//
// Audience: the worker themselves — rest breaks are theirs to take, on the
// clock and paid, so the nudge goes to their pocket. Deployed with
// --no-verify-jwt; the shared-secret header is the auth. Secrets:
// VAPID_KEYS_JSON, NOTIFY_SECRET (same pair as the other notify fns).

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
  let sent = 0, pruned = 0, failed = 0;
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
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (req.headers.get("x-notify-secret") !== Deno.env.get("NOTIFY_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body) return new Response("bad request", { status: 400 });

  const { time_entry_id, user_id, stage, worked_minutes } = body as {
    time_entry_id: string;
    user_id: string;
    stage: number;
    worked_minutes: number;
  };

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_id", user_id);

  const h = Math.floor(worked_minutes / 60);
  const result = await sendToSubs(subs ?? [], {
    title: stage === 2 ? "Second rest break" : "Rest break time",
    body:
      stage === 2
        ? `You're past ${h} hours — take your second paid 10-minute break.`
        : "Take your paid 10-minute rest break — you've earned it (and it's the law).",
    url: "/dashboard",
    tag: `rest-${time_entry_id}-${stage}`,
  });
  return json(result);
});
