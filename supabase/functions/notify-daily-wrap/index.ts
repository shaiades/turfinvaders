// Web Push for the end-of-day results (owner ask 2026-09-22): at the 6 PM PT
// report lock, tell the field the day is in — "see who won the day (and who
// got the doughnut)" — linking to /daily-wrap. The in-app EodRecapFx cutscene
// is the guaranteed channel (it auto-plays on the next app open); this push
// is the same-evening nudge, and only reaches devices that enabled alerts.
//
// Called by the pg_cron → send_daily_wrap_push() SQL function (via pg_net)
// with x-notify-secret; the SQL side owns the real guards (LA hour == 18,
// not Sunday, somebody actually clocked in today, one send per day via
// eod_push_log). This function stays nearly unconditional so a manual resend
// is a plain curl — the `eod-<day>` tag collapses repeats on-device.
// Deployed with --no-verify-jwt (cron can't sign a user JWT); the shared
// NOTIFY_SECRET gates the path. Secrets: VAPID_KEYS_JSON + NOTIFY_SECRET,
// same pair as the other notify-* functions.

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
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const laTodayISO = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (req.headers.get("x-notify-secret") !== Deno.env.get("NOTIFY_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as {
    day_iso?: string;
    force?: boolean;
  } | null;
  if (!body) return new Response("bad request", { status: 400 });

  const day = body.day_iso ?? laTodayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return new Response("bad request", { status: 400 });
  // Defense-in-depth: the SQL guard already skips Sundays; keep manual curls
  // honest too unless explicitly forced.
  if (new Date(`${day}T00:00:00Z`).getUTCDay() === 0 && body.force !== true) {
    return json({ skipped: "sunday" });
  }

  // Audience = the field tier + the leadership who read the wrap. sales_rep
  // and confirmer single-role holders are deliberately out (the Daily Wrap is
  // a canvassing page); multi-role users dedupe via the Set.
  const { data: roleRows } = await admin
    .from("user_roles")
    .select("user_id")
    .in("role", ["canvasser", "captain", "owner", "office_staff"]);
  const targets = [...new Set((roleRows ?? []).map((r: { user_id: string }) => r.user_id))];
  if (targets.length === 0) return json({ sent: 0, pruned: 0, failed: 0, matched: 0 });

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .in("user_id", targets);
  const result = await sendToSubs(subs ?? [], {
    title: "🏆 Day results are in",
    body: "The day is locked — see who won the day (and who got the doughnut).",
    url: "/daily-wrap",
    tag: `eod-${day}`, // resends collapse to one notification per device
  });
  return json({ ...result, matched: targets.length, day });
});
