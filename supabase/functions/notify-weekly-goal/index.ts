// Web Push for the Monday-morning goal ritual (owner ask 2026-09-22): at
// 7 AM PT every Monday, tell every sales rep the week is open — set your
// volume goal — deep-linking to /close-kombat?tab=goals. The in-app
// once-per-week auto-open of the Goals tab is the guaranteed channel; this
// push is the morning nudge, and only reaches devices that enabled alerts.
//
// Called by the pg_cron → send_weekly_goal_push() SQL function (via pg_net)
// with x-notify-secret; the SQL side owns the real guards (LA hour == 7,
// Monday only, one send per week via weekly_goal_push_log). This function
// stays nearly unconditional so a manual resend is a plain curl — the
// `goal-week-<monday>` tag collapses repeats on-device.
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

/** Monday (YYYY-MM-DD) of the week containing an ISO date — UTC-noon math so
 *  DST can't shift the calendar day (mirror of dates.ts weekStartOfISO). */
function weekStartOfISO(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  const day = noon.getUTCDay(); // 0=Sun..6=Sat
  noon.setUTCDate(noon.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return noon.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (req.headers.get("x-notify-secret") !== Deno.env.get("NOTIFY_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as {
    week_start?: string;
    force?: boolean;
  } | null;
  if (!body) return new Response("bad request", { status: 400 });

  const weekStart = body.week_start ?? weekStartOfISO(laTodayISO());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return new Response("bad request", { status: 400 });
  // Defense-in-depth: the SQL guard already pins Mondays; keep manual curls
  // honest too unless explicitly forced.
  if (weekStartOfISO(weekStart) !== weekStart && body.force !== true) {
    return json({ skipped: "not a monday" });
  }

  // Audience = every sales rep (the Goals tab is theirs alone); multi-role
  // holders dedupe via the Set.
  const { data: roleRows } = await admin
    .from("user_roles")
    .select("user_id")
    .eq("role", "sales_rep");
  const targets = [...new Set((roleRows ?? []).map((r: { user_id: string }) => r.user_id))];
  if (targets.length === 0) return json({ sent: 0, pruned: 0, failed: 0, matched: 0 });

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .in("user_id", targets);
  const result = await sendToSubs(subs ?? [], {
    title: "🥊 New week — set your goal",
    body: "Set your weekly volume goal and see exactly what it takes to hit it.",
    url: "/close-kombat?tab=goals",
    tag: `goal-week-${weekStart}`, // resends collapse to one notification per device
  });
  return json({ ...result, matched: targets.length, week_start: weekStart });
});
