// Web Push for the day-off / absence system (owner ask 2026-10-01).
//
// Called by the day_off_requests trigger (via pg_net) with x-notify-secret.
// Three kinds:
//   · 'submission' — a worker requested a day off → push the reviewers
//     (owners, Managers, the worker's van captain), never the requester.
//   · 'record'     — a captain/Manager marked someone sick / no-show /
//     excused → push the worker so nothing is entered behind their back.
//   · 'outcome'    — a pending request was approved/denied → push the
//     worker (and the requester, if different), deny note included.
//
// Deployed with --no-verify-jwt (the trigger can't sign a user JWT); the
// shared-secret header is the auth. Secrets: VAPID_KEYS_JSON, NOTIFY_SECRET
// (same pair as notify-flagged-punch — nothing new to provision).

import { createClient } from "jsr:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const KIND_LABEL: Record<string, string> = {
  day_off: "day off",
  sick: "sick day",
  no_show: "no-show",
  excused: "excused absence",
  other: "absence",
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: CORS });
  }
  if (req.headers.get("x-notify-secret") !== Deno.env.get("NOTIFY_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body) return new Response("bad request", { status: 400 });

  const { kind, request_id, user_id, requested_by, absence_date, absence_kind, status, deny_reason } =
    body as {
      kind: "submission" | "record" | "outcome";
      request_id: string;
      user_id: string;
      requested_by: string | null;
      absence_date: string;
      absence_kind: string;
      status: string;
      deny_reason: string | null;
    };

  const { data: worker } = await admin
    .from("profiles")
    .select("display_name, team_id")
    .eq("id", user_id)
    .maybeSingle();
  const workerName = worker?.display_name ?? "A crew member";
  const label = KIND_LABEL[absence_kind] ?? "absence";

  let targets: string[] = [];
  let payload: { title: string; body: string; url: string; tag?: string };

  if (kind === "submission") {
    // Reviewers: owners + Managers + the worker's own captain.
    const { data: roleRows } = await admin
      .from("user_roles")
      .select("user_id, role")
      .in("role", ["owner", "office_staff", "captain"]);
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
    targets = [
      ...new Set([
        ...(roleRows ?? []).filter((r) => r.role !== "captain").map((r) => r.user_id),
        ...teamCaptains,
      ]),
    ].filter((id) => id !== user_id && id !== requested_by);
    payload = {
      title: "Day off · approval needed",
      body: `${workerName} requested a ${label} · ${absence_date}`,
      url: "/dashboard",
      tag: `day-off-${request_id}`,
    };
  } else if (kind === "record") {
    targets = [user_id].filter((id) => id !== requested_by);
    payload = {
      title: "Absence recorded",
      body: `You were marked ${label} for ${absence_date}. Wrong? Tell your captain or manager.`,
      url: "/dashboard",
      tag: `day-off-${request_id}`,
    };
  } else {
    targets = [...new Set([user_id, requested_by].filter(Boolean) as string[])];
    payload =
      status === "approved"
        ? {
            title: "Day off approved",
            body: `${absence_date} · ${label} — you're covered.`,
            url: "/dashboard",
            tag: `day-off-${request_id}`,
          }
        : {
            title: "Day off denied",
            body: `${absence_date} · ${deny_reason ?? "see your captain"}`,
            url: "/dashboard",
            tag: `day-off-${request_id}`,
          };
  }

  if (targets.length === 0) return json({ sent: 0, pruned: 0, failed: 0 });
  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .in("user_id", targets);
  const result = await sendToSubs(subs ?? [], payload);
  return json(result);
});
