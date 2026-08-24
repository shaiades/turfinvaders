import { supabase } from "@/integrations/supabase/client";

/** VAPID public applicationServerKey — safe to commit (it is public by
 *  definition); the matching private JWK lives only in the edge function's
 *  secrets. Regenerating the pair invalidates every stored subscription. */
export const VAPID_PUBLIC_KEY =
  "BCEh0y5uZcutqLzpSU-1iewHbMHSFABWNAAmYQAH3R7BzjaDdyEq3cQ-Nd5LT7JXiZxEniJBXyxlP-800JIKNKo";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushStatus =
  | "unsupported" // no SW/Push API here (iOS Safari outside the installed PWA)
  | "blocked" // permission denied at the browser level
  | "off"
  | "on";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function getPushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub ? "on" : "off";
}

/** Register the worker, ask permission, subscribe, and store the device row.
 *  Returns the resulting status; "off" means the user dismissed the prompt. */
export async function enablePush(userId: string): Promise<PushStatus> {
  if (!pushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "blocked";
  if (permission !== "granted") return "off";

  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY).buffer as ArrayBuffer,
    }));

  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("Subscription came back incomplete — try again");
  }
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: userId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    },
    { onConflict: "endpoint" },
  );
  if (error) throw error;
  return "on";
}

/** Ping the caller's own devices through the edge function. */
export async function sendTestPush(): Promise<{ sent: number }> {
  const { data, error } = await supabase.functions.invoke("notify-flagged-punch", {
    body: { test: true },
  });
  if (error) throw error;
  return data as { sent: number };
}
