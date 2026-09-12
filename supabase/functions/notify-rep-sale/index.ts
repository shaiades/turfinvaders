// Web Push for rep sales — KA-CHING on the phone (rep audit R-11, 2026-09-12).
//
// Called only by the block_cards trigger (via pg_net) with x-notify-secret:
// a card just TRANSITIONED to a kept sale, and the payload carries the
// card's rep name strings. We resolve those to auth users conservatively —
// EXACT normalized display-name match against profiles holding the
// sales_rep role, no fuzzy tiers server-side (a wrong push is worse than no
// push) — and push each matched rep's own devices.
//
// Deployed with --no-verify-jwt (the trigger can't sign a user JWT); the
// shared NOTIFY_SECRET gates the path. Secrets: VAPID_KEYS_JSON +
// NOTIFY_SECRET, same pair as notify-flagged-punch / notify-turf-assigned.

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

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (req.headers.get("x-notify-secret") !== Deno.env.get("NOTIFY_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body) return new Response("bad request", { status: 400 });

  const { monday_item_id, lead_name, sale_price, reps } = body as {
    monday_item_id: string;
    lead_name: string | null;
    sale_price: number | null;
    reps: string[] | null;
  };
  const repNames = new Set((reps ?? []).map(normalizeName).filter((n) => n !== ""));
  if (repNames.size === 0) {
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }

  // Resolve board names → auth users: sales_rep role holders whose profile
  // display_name normalizes to a card rep name. Exact tier only.
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

  const price = Number(sale_price ?? 0);
  const result = await sendToSubs(subs ?? [], {
    title: "💰 KA-CHING — sale confirmed",
    body: `${lead_name ?? "Your deal"} just hit the board${price > 0 ? ` · ${fmtMoney(price)}` : ""}. CLOSED!`,
    url: "/close-kombat",
    tag: `sale-${monday_item_id}`, // one card collapses to one notification
  });
  return new Response(JSON.stringify({ ...result, matched: targets.length }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
