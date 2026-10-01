// Web Push: lunch warning to the van captain (owner ask 2026-10-01 —
// "nobody works through lunch"). The send_lunch_warnings cron calls this
// (via pg_net, x-notify-secret) when a crew member passes 4¼ hours on the
// clock with no real lunch punched — while a compliant 30-minute meal can
// still START before the end of their 5th hour.
//
// Audience: captains on the worker's own van. Deployed with
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

  const { time_entry_id, user_id, worked_minutes } = body as {
    time_entry_id: string;
    user_id: string;
    worked_minutes: number;
  };

  const { data: worker } = await admin
    .from("profiles")
    .select("display_name, team_id")
    .eq("id", user_id)
    .maybeSingle();
  if (!worker?.team_id) return json({ sent: 0, pruned: 0, failed: 0 });

  // Captains on the worker's van.
  const { data: captainRoles } = await admin
    .from("user_roles")
    .select("user_id")
    .eq("role", "captain");
  const captainIds = (captainRoles ?? []).map((r) => r.user_id);
  if (captainIds.length === 0) return json({ sent: 0, pruned: 0, failed: 0 });
  const { data: capProfiles } = await admin
    .from("profiles")
    .select("id, team_id")
    .in("id", captainIds);
  const targets = (capProfiles ?? [])
    .filter((p) => p.team_id === worker.team_id && p.id !== user_id)
    .map((p) => p.id);
  if (targets.length === 0) return json({ sent: 0, pruned: 0, failed: 0 });

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .in("user_id", targets);

  const h = Math.floor(worked_minutes / 60);
  const m = worked_minutes % 60;
  const result = await sendToSubs(subs ?? [], {
    title: "Lunch warning",
    body: `${worker.display_name ?? "A crew member"} is at ${h}h${String(m).padStart(2, "0")} with no lunch — start their 30 min before hour 5.`,
    url: "/dashboard",
    tag: `lunch-${time_entry_id}`,
  });
  return json(result);
});
