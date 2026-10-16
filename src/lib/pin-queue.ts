// Offline pin queue (Phase 3 §4) — a knock logged in a dead spot must not
// vanish. When a field_pins insert fails on NETWORK (not on RLS/validation,
// which would never succeed), the full row is stashed here and replayed when
// the connection returns. Pure localStorage + pure helpers; useFieldPins owns
// the wiring. Unit-pinned by scripts/verify-pin-queue.ts.
//
// Correctness rules (the two bugs a naive retry ships):
//   · the row carries its OWN client-generated uuid `id` — field_pins' PK —
//     so a replay that actually landed the first time dies on 23505 and is
//     treated as delivered, never double-counted;
//   · `log_date`, coordinates and the remote-drop verdict are FROZEN at
//     knock time — a replay after midnight or from the next street must not
//     drift the stats day or re-measure the distance.

export const PIN_QUEUE_KEY = "ti_pin_queue_v1";
/** Postgres unique-violation — the row already landed on a previous try. */
export const UNIQUE_VIOLATION = "23505";
const MAX_QUEUE = 200;

export type QueuedPin = {
  id: string;
  canvasser_id: string;
  pin_type: string;
  lat: number;
  lng: number;
  device_lat: number | null;
  device_lng: number | null;
  distance_m: number;
  is_remote_drop: boolean;
  log_date: string;
  objection: string | null;
};

/** A failure worth queueing: the device is offline, or the request died in
 *  transit. Anything the SERVER said (RLS, constraint, bad column) replays
 *  identically and must not clog the queue. */
export function isNetworkishError(message: string | null | undefined, online: boolean): boolean {
  if (!online) return true;
  return /failed to fetch|network|fetch failed|load failed|timeout/i.test(message ?? "");
}

export function readPinQueue(): QueuedPin[] {
  try {
    const raw = localStorage.getItem(PIN_QUEUE_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? (arr as QueuedPin[]).filter((p) => p && p.id) : [];
  } catch {
    return [];
  }
}

function writePinQueue(q: QueuedPin[]): void {
  try {
    localStorage.setItem(PIN_QUEUE_KEY, JSON.stringify(q.slice(-MAX_QUEUE)));
  } catch {
    /* private mode — the knock is lost only if the tab also dies */
  }
}

export function enqueuePin(pin: QueuedPin): void {
  const q = readPinQueue();
  if (q.some((p) => p.id === pin.id)) return;
  writePinQueue([...q, pin]);
}

/** Pure planner for a flush round: which queued pins to drop (delivered or
 *  dead-on-server) and which to keep, given each attempt's outcome. */
export function settleAttempt(
  pin: QueuedPin,
  outcome: { ok: boolean; code?: string | null; message?: string | null; online: boolean },
): "delivered" | "keep" | "discard" {
  if (outcome.ok) return "delivered";
  if (outcome.code === UNIQUE_VIOLATION) return "delivered"; // landed on an earlier try
  if (isNetworkishError(outcome.message, outcome.online)) return "keep"; // still offline
  return "discard"; // server rejected it — retrying forever helps nobody
}

/**
 * Replay the queue through `insert`. Stops at the first still-offline
 * failure (the rest would fail the same way); server-rejected rows are
 * dropped with their messages reported so the caller can surface them.
 */
export async function flushPinQueue(
  insert: (
    pin: QueuedPin,
  ) => Promise<{ error: { code?: string | null; message?: string | null } | null }>,
  online: () => boolean = () => (typeof navigator === "undefined" ? true : navigator.onLine),
): Promise<{ sent: number; discarded: string[]; remaining: number }> {
  const queue = readPinQueue();
  if (queue.length === 0) return { sent: 0, discarded: [], remaining: 0 };
  let sent = 0;
  const discarded: string[] = [];
  const keep: QueuedPin[] = [];
  for (let i = 0; i < queue.length; i++) {
    const pin = queue[i];
    let outcome: Parameters<typeof settleAttempt>[1];
    try {
      const { error } = await insert(pin);
      outcome = { ok: !error, code: error?.code, message: error?.message, online: online() };
    } catch (e) {
      outcome = {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        online: online(),
      };
    }
    const verdict = settleAttempt(pin, outcome);
    if (verdict === "delivered") {
      sent++;
    } else if (verdict === "discard") {
      discarded.push(outcome.message ?? "rejected");
    } else {
      // Still offline — keep this one and everything after it untouched.
      keep.push(...queue.slice(i));
      break;
    }
  }
  writePinQueue(keep);
  return { sent, discarded, remaining: keep.length };
}
