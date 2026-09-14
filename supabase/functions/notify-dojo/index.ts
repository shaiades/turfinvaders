// Web Push for the Objection Dojo (owner request 2026-09-13) — both directions
// of the review loop through one function, discriminated by payload kind:
//   · "submission": a player filed an attempt (INSERT at pending) — fan out to
//     the review audience, exactly who the RLS lets approve: owners + Managers
//     (never the submitter, so a Manager practicing doesn't self-notify).
//   · "outcome": a reviewer approved/denied (pending → approved|denied) — push
//     only the submitter's own devices, carrying the coach's deny note.
//
// Called only by the objection_attempts trigger (via pg_net) with
// x-notify-secret; payload carries ids and we resolve names/titles here.
// Deployed with --no-verify-jwt (the trigger can't sign a user JWT); the
// shared NOTIFY_SECRET gates the path. Secrets: VAPID_KEYS_JSON +
// NOTIFY_SECRET, same pair as the other notify-* functions.

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

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (req.headers.get("x-notify-secret") !== Deno.env.get("NOTIFY_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body) return new Response("bad request", { status: 400 });

  const { kind, attempt_id, objection_id, canvasser_id, status, deny_reason } = body as {
    kind: "submission" | "outcome";
    attempt_id: string;
    objection_id: string;
    canvasser_id: string;
    status: "pending" | "approved" | "denied";
    deny_reason: string | null;
  };
  if (kind !== "submission" && kind !== "outcome") {
    return new Response("bad request", { status: 400 });
  }

  // Seeded objection titles carry their own quotes ('"I''m Not Interested"'),
  // so bodies read naturally without adding more.
  const [{ data: objection }, { data: player }] = await Promise.all([
    admin.from("objections").select("title").eq("id", objection_id).maybeSingle(),
    admin.from("profiles").select("display_name").eq("id", canvasser_id).maybeSingle(),
  ]);
  const title = objection?.title ?? "an objection";
  const name = player?.display_name ?? "A player";

  if (kind === "submission") {
    const { data: roleRows } = await admin
      .from("user_roles")
      .select("user_id")
      .in("role", ["owner", "office_staff"]);
    const targets = [...new Set((roleRows ?? []).map((r: { user_id: string }) => r.user_id))]
      .filter((id) => id !== canvasser_id);
    if (targets.length === 0) return json({ sent: 0, pruned: 0, failed: 0, matched: 0 });

    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .in("user_id", targets);
    const result = await sendToSubs(subs ?? [], {
      title: "🥋 Dojo submission — review needed",
      body: `${name} took on ${title}`,
      url: "/confirmation-desk",
      tag: `dojo-sub-${attempt_id}`, // one attempt collapses to one notification
    });
    return json({ ...result, matched: targets.length });
  }

  // Outcome → only the submitter's own devices.
  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_id", canvasser_id);
  const reason = (deny_reason ?? "").trim();
  const result = await sendToSubs(
    subs ?? [],
    status === "approved"
      ? {
          title: "🥋 Dojo attempt APPROVED",
          body: `Your ${title} answer is live in the library. Go watch it!`,
          url: "/learn",
          tag: `dojo-outcome-${attempt_id}`,
        }
      : {
          title: "🥋 Dojo attempt — coach feedback",
          // Push bodies stay short; the full note lives in the Learn tab.
          body:
            reason === ""
              ? `Your ${title} attempt needs another take — check the Learn tab.`
              : reason.length > 140
                ? `${reason.slice(0, 139)}…`
                : reason,
          url: "/learn",
          tag: `dojo-outcome-${attempt_id}`,
        },
  );
  return json({ ...result, matched: 1 });
});
