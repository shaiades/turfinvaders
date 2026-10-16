/** Assertions for the offline pin queue in src/lib/pin-queue.ts — run with
 *  `npm run verify:pin-queue`.
 *
 *  Pins the Phase 3 §4 contracts (field_pins feeds daily_logs via the bump
 *  trigger, so a replay bug is a stats bug):
 *   · a replayed row that already landed (23505 unique violation on the
 *     client-generated id) counts as DELIVERED — never double-inserted,
 *   · a server rejection (RLS, bad column) is DISCARDED — never retried
 *     forever,
 *   · a still-offline failure keeps the row AND everything after it, in
 *     order,
 *   · queued rows replay verbatim — knock-time log_date and the frozen
 *     remote-drop verdict included,
 *   · network-ish detection: offline flag or transit errors, never server
 *     messages. */

// localStorage shim — the lib try/catches around it, but the flush test
// needs a real (in-memory) store.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

import {
  enqueuePin,
  flushPinQueue,
  isNetworkishError,
  readPinQueue,
  settleAttempt,
  UNIQUE_VIOLATION,
  type QueuedPin,
} from "../src/lib/pin-queue";

let failures = 0;
function expectEq(label: string, got: unknown, want: unknown) {
  const ok =
    typeof got === "number" && typeof want === "number"
      ? Math.abs(got - want) < 1e-9
      : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`✗ ${label}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

const pin = (id: string, over: Partial<QueuedPin> = {}): QueuedPin => ({
  id,
  canvasser_id: "u1",
  pin_type: "not_home",
  lat: 32.7,
  lng: -117.2,
  device_lat: 32.7,
  device_lng: -117.2,
  distance_m: 4,
  is_remote_drop: false,
  log_date: "2026-10-15",
  objection: null,
  ...over,
});

// ── network-ish detection ────────────────────────────────────────────────────
expectEq("offline flag always queues", isNetworkishError("anything", false), true);
expectEq("transit error queues", isNetworkishError("TypeError: Failed to fetch", true), true);
expectEq(
  "server rejection never queues",
  isNetworkishError('new row violates row-level security policy for table "field_pins"', true),
  false,
);

// ── settleAttempt ────────────────────────────────────────────────────────────
expectEq("success → delivered", settleAttempt(pin("a"), { ok: true, online: true }), "delivered");
expectEq(
  "duplicate id (already landed) → delivered",
  settleAttempt(pin("a"), { ok: false, code: UNIQUE_VIOLATION, online: true }),
  "delivered",
);
expectEq(
  "still offline → keep",
  settleAttempt(pin("a"), { ok: false, message: "Failed to fetch", online: false }),
  "keep",
);
expectEq(
  "server rejection → discard",
  settleAttempt(pin("a"), { ok: false, message: "violates row-level security", online: true }),
  "discard",
);

// ── enqueue + flush ──────────────────────────────────────────────────────────
enqueuePin(pin("p1", { log_date: "2026-10-14", is_remote_drop: true, distance_m: 90 }));
enqueuePin(pin("p2"));
enqueuePin(pin("p2")); // duplicate enqueue is a no-op
enqueuePin(pin("p3", { objection: "Not now" }));
expectEq("queue holds 3 (dupes dropped)", readPinQueue().length, 3);
expectEq(
  "knock-time fields frozen in the queue",
  readPinQueue()[0],
  pin("p1", { log_date: "2026-10-14", is_remote_drop: true, distance_m: 90 }),
);

// Flush 1: p1 lands, p2 already landed on an earlier try (23505), p3 hits a
// dead network — it stays queued.
const seen: QueuedPin[] = [];
const r1 = await flushPinQueue(
  async (p) => {
    seen.push(p);
    if (p.id === "p1") return { error: null };
    if (p.id === "p2") return { error: { code: UNIQUE_VIOLATION, message: "duplicate key" } };
    return { error: { code: null, message: "Failed to fetch" } };
  },
  () => false, // offline by the time p3 failed
);
expectEq(
  "flush replays in order",
  seen.map((p) => p.id),
  ["p1", "p2", "p3"],
);
expectEq("delivered + duplicate counted as sent", r1.sent, 2);
expectEq("offline row kept", r1.remaining, 1);
expectEq("replay payload is verbatim", seen[0].log_date, "2026-10-14");

// Flush 2: the server now REJECTS p3 — it must be discarded, not retried
// forever.
const r2 = await flushPinQueue(
  async () => ({ error: { code: "42501", message: "violates row-level security" } }),
  () => true,
);
expectEq("server rejection discarded", r2.discarded.length, 1);
expectEq("queue empty after discard", readPinQueue().length, 0);

const r3 = await flushPinQueue(async () => ({ error: null }));
expectEq("empty queue flush is a no-op", r3, { sent: 0, discarded: [], remaining: 0 });

console.log(failures === 0 ? "\n✅ 0 failure(s)" : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
