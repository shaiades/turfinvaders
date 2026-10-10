// ═══════════════════════════════════════════════════════════════════════════
// WRITE LOCK (rule L — owner mandate 2026-10-10). A tiny, short-lived advisory
// lock every people6 / status writer takes BEFORE its read-modify-write and
// clears after, so two concurrent edge invocations can't both issue the same
// pair onto two different leads (the 10/9 double-issue). Backed by the
// public.monday_write_locks table + try_acquire_write_lock / release_write_lock
// SQL functions (migration 20261020120000_write_locks.sql).
//
// Keys:
//   · `item:<itemId>` — serializes two writers on the SAME block item;
//   · `rep:<userId>`  — serializes issuing the SAME rep across DIFFERENT items.
//
// Fail-OPEN by doctrine: a lock-service hiccup must never wedge a legitimate
// write. The additive union write + the Rule 3 / H5 re-read guards still protect
// a manager even with the lock disabled, so losing the lock degrades to the
// prior (pre-rule-L) behavior rather than dropping a rep.
// ═══════════════════════════════════════════════════════════════════════════
import type { Supa } from "./supa.ts";
import { fetchItemActivity } from "./monday.ts";
import { GUARDED_WRITE_COLS } from "./engine.ts";

export const LOCK_TTL_SEC = 45;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Take one lock. Returns true iff we now hold it. Fail-open on any error. */
export async function tryAcquire(
  supabase: Supa,
  key: string,
  holder: string,
  ttlSec = LOCK_TTL_SEC,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("try_acquire_write_lock", {
      p_key: key,
      p_holder: holder,
      p_ttl_sec: ttlSec,
    });
    if (error) return true; // fail-open
    return data === true;
  } catch {
    return true; // fail-open
  }
}

/** Release one lock we hold (best-effort; never frees another holder's lock). */
export async function releaseLock(supabase: Supa, key: string, holder: string): Promise<void> {
  try {
    await supabase.rpc("release_write_lock", { p_key: key, p_holder: holder });
  } catch {
    /* best-effort — the TTL reclaims the lock even if this never lands */
  }
}

/** Acquire ALL keys for `holder`, in a stable (sorted) order so two invocations
 *  grabbing overlapping keys can never deadlock. On the first key held fresh by
 *  someone else, release whatever we already took and report the blocking key. */
export async function acquireAll(
  supabase: Supa,
  keys: string[],
  holder: string,
  ttlSec = LOCK_TTL_SEC,
): Promise<{ ok: true } | { ok: false; blockedKey: string }> {
  const sorted = [...new Set(keys)].sort();
  const got: string[] = [];
  for (const k of sorted) {
    if (await tryAcquire(supabase, k, holder, ttlSec)) {
      got.push(k);
    } else {
      for (const g of got) await releaseLock(supabase, g, holder);
      return { ok: false, blockedKey: k };
    }
  }
  return { ok: true };
}

/** Release a set of keys we hold. */
export async function releaseAll(supabase: Supa, keys: string[], holder: string): Promise<void> {
  for (const k of [...new Set(keys)]) await releaseLock(supabase, k, holder);
}

/** Rule L (15s): did ANY actor (the dispatcher included — unlike the Rule 3
 *  guard, which excludes it) change people6 / status on this item within the
 *  last `withinSec` seconds? A mid-flight change by a second writer → the caller
 *  waits and re-reads before writing. Best-effort: a log-read failure returns
 *  false (don't block the write — the lock + union are the real protection). */
export async function recentlyTouched(
  token: string,
  boardId: string,
  itemId: string,
  withinSec: number,
  nowMs = Date.now(),
): Promise<boolean> {
  try {
    const logs = await fetchItemActivity(
      token,
      boardId,
      itemId,
      new Date(nowMs - withinSec * 1000).toISOString(),
      new Date(nowMs).toISOString(),
    );
    const cutoff = nowMs - withinSec * 1000;
    const guarded = GUARDED_WRITE_COLS as readonly string[];
    // A null createdAtMs (unparseable) is treated as "now" — the protective
    // default, same as fetchItemActivity: count it as a recent touch.
    return logs.some(
      (l) => l.columnId != null && guarded.includes(l.columnId) && (l.createdAtMs ?? nowMs) >= cutoff,
    );
  } catch {
    return false;
  }
}
