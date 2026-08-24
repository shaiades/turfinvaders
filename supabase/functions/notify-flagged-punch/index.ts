// Web Push for flagged time-clock punches (owner directive 2026-08-24).
//
// Two callers:
//   1) The time_entries trigger (via pg_net) with x-notify-secret — fans a
//      push out to the review audience: owners, Managers, and the worker's
//      own captain, never the worker themselves.
//   2) A signed-in user with {test: true} — pings only their own devices so
//      the "Send test" button can prove the pipe end to end.
//
// Deployed with --no-verify-jwt (the trigger can't sign a user JWT); both
// paths above enforce their own auth. Secrets: VAPID_KEYS_JSON (JWK pair,
// same keypair as the client's public applicationServerKey), NOTIFY_SECRET.

import { createClient } from "jsr:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const FLAG_LABEL: Record<string, string> = {
  early_clock_in: "early clock-in (before 7 AM)",
  sunday_shift: "Sunday shift",
  very_long_shift: "over 12h",
  missed_meal: "worked through lunch",
  unrecorded_lunch: "lunch times needed",
};

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

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
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
      url: "/dashboard?tab=timesheets",
      tag: "push-test",
    });
    return Response.json(result);
  }

  // ── Trigger path: fan out to the review audience ──────────────────────────
  if (req.headers.get("x-notify-secret") !== Deno.env.get("NOTIFY_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const { entry_id, user_id, log_date, flag_reasons, entry_source } = body as {
    entry_id: string;
    user_id: string;
    log_date: string;
    flag_reasons: string[] | null;
    entry_source: string | null;
  };

  const [{ data: worker }, { data: roleRows }] = await Promise.all([
    admin.from("profiles").select("display_name, team_id").eq("id", user_id).maybeSingle(),
    admin.from("user_roles").select("user_id, role").in("role", ["owner", "office_staff", "captain"]),
  ]);

  const captainIds = (roleRows ?? []).filter((r) => r.role === "captain").map((r) => r.user_id);
  let teamCaptains: string[] = [];
  if (captainIds.length > 0 && worker?.team_id) {
    const { data: capProfiles } = await admin
      .from("profiles")
      .select("id, team_id")
      .in("id", captainIds);
    teamCaptains = (capProfiles ?? [])
      .filter((p) => p.team_id === worker.team_id)
      .map((p) => p.id);
  }
  const targets = [
    ...new Set([
      ...(roleRows ?? []).filter((r) => r.role !== "captain").map((r) => r.user_id),
      ...teamCaptains,
    ]),
  ].filter((id) => id !== user_id); // never notify the worker about their own flag

  if (targets.length === 0) return Response.json({ sent: 0, pruned: 0, failed: 0 });

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .in("user_id", targets);

  const labels = (flag_reasons ?? []).map((f) => FLAG_LABEL[f] ?? f);
  if (entry_source === "auto_closed" && !labels.length) labels.push("auto-closed");
  const result = await sendToSubs(subs ?? [], {
    title: "Time clock · review needed",
    body: `${worker?.display_name ?? "A crew member"} · ${labels.join(", ") || "flagged punch"} · ${log_date}`,
    url: "/dashboard?tab=timesheets",
    tag: `review-${entry_id}`, // same entry collapses to one notification
  });
  return Response.json(result);
});
