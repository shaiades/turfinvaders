// Web Push for leads issued to a rep — KA-CHING on the phone the moment a
// fresh lead lands on their plate (owner, 2026-10-06).
//
// Called only by the block_cards trigger (via pg_net) with x-notify-secret:
// a card just gained one or more NEW reps (people6 / "Reps" column) while it
// was still an open, un-sold lead — i.e. the office (or live dispatch) just
// handed the lead over. The payload carries ONLY the newly-added rep names
// (the trigger dedupes per card+rep, so a rep is pinged once per lead, ever).
// We resolve those strings to auth users conservatively — EXACT normalized
// display-name match against profiles holding the sales_rep role, no fuzzy
// tiers server-side (a wrong push is worse than no push) — and push each
// matched rep's own devices.
//
// Deployed with --no-verify-jwt (the trigger can't sign a user JWT); the
// shared NOTIFY_SECRET gates the path. Secrets: VAPID_KEYS_JSON + NOTIFY_SECRET,
// the same pair as notify-rep-sale / notify-turf-assigned — one device
// subscription feeds every notify-* function, so a rep who enabled "Sale
// alerts" already receives these.

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

/** Client-side normalizeName's twin: trim → lowercase → collapse spaces. */
const normalizeName = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

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

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (req.headers.get("x-notify-secret") !== Deno.env.get("NOTIFY_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body) return new Response("bad request", { status: 400 });

  const { monday_item_id, lead_name, reps } = body as {
    monday_item_id: string;
    lead_name: string | null;
    reps: string[] | null;
  };
  const repNames = new Set((reps ?? []).map(normalizeName).filter((n) => n !== ""));
  if (repNames.size === 0) {
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }

  // Resolve board names → auth users: sales_rep role holders whose profile
  // display_name normalizes to a freshly-issued rep name. Exact tier only.
  const [{ data: roleRows }, { data: profiles }] = await Promise.all([
    admin.from("user_roles").select("user_id").eq("role", "sales_rep"),
    admin.from("profiles").select("id, display_name"),
  ]);
  const repUserIds = new Set((roleRows ?? []).map((r: { user_id: string }) => r.user_id));
  const targets = (profiles ?? [])
    .filter(
      (p: { id: string; display_name: string | null }) =>
        repUserIds.has(p.id) && repNames.has(normalizeName(p.display_name)),
    )
    .map((p: { id: string }) => p.id);
  if (targets.length === 0) {
    return new Response(JSON.stringify({ sent: 0, matched: 0 }), { status: 200 });
  }

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .in("user_id", targets);

  const result = await sendToSubs(subs ?? [], {
    title: "💰 KA-CHING — new lead!",
    body: `${lead_name ?? "A fresh lead"} just landed on your plate — go close it! 🥊`,
    url: "/close-kombat",
    tag: `lead-issued-${monday_item_id}`, // one card collapses to one notification
  });
  return new Response(JSON.stringify({ ...result, matched: targets.length }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
