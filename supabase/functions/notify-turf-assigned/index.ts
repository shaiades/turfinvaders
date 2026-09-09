// Web Push for turf assignments (2026-09-09).
//
// Two callers:
//   1) The turfs trigger (via pg_net) with x-notify-secret — pushes ONLY the
//      assigned user's own devices; nobody else hears about someone's turf.
//   2) A signed-in user with {test: true} — pings only their own devices so
//      the "Send test" button can prove the pipe end to end.
//
// Deployed with --no-verify-jwt (the trigger can't sign a user JWT); both
// paths above enforce their own auth. Secrets: VAPID_KEYS_JSON (JWK pair,
// same keypair as the client's public applicationServerKey), NOTIFY_SECRET —
// shared with notify-flagged-punch.

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
      // A dead endpoint (uninstalled PWA, cleared site data) answers 404/410:
      // prune it so we stop pushing at a ghost.
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

// Browser calls (the "Send test" button) need CORS; the pg_net trigger path
// doesn't care but is unharmed by it.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-notify-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: CORS });
  }
  const body = await req.json().catch(() => null);
  if (!body) return new Response("bad request", { status: 400 });

  // ── Test path: prove the pipe to the caller's own devices ─────────────────
  if (body.test === true) {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: userData, error } = await admin.auth.getUser(jwt);
    if (error || !userData?.user) return new Response("unauthorized", { status: 401 });
    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("user_id", userData.user.id);
    const result = await sendToSubs(subs ?? [], {
      title: "Turf Invaders · test alert",
      body: "Push notifications are working on this device.",
      url: "/field",
      tag: "push-test",
    });
    return json(result);
  }

  // ── Trigger path: push the assigned user's own devices ────────────────────
  if (req.headers.get("x-notify-secret") !== Deno.env.get("NOTIFY_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const { turf_id, turf_name, assigned_user_id } = body as {
    turf_id: string;
    turf_name: string | null;
    assigned_user_id: string | null;
  };
  if (!assigned_user_id) return json({ sent: 0, pruned: 0, failed: 0 });

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_id", assigned_user_id);

  const result = await sendToSubs(subs ?? [], {
    title: "🗺️ New turf assigned",
    body: turf_name
      ? `${turf_name} is yours — open your run.`
      : "Fresh turf is yours — open your run.",
    url: "/field",
    tag: `turf-${turf_id}`, // same turf collapses to one notification
  });
  return json(result);
});
