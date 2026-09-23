// My Purpose — local-first autosave. Framework-free on purpose: the class
// only knows "coalesce by key, debounce, flush, retry"; React listeners
// (blur / Continue / visibilitychange / pagehide) live in the workshop hook.
//
// Local-first means the localStorage mirror is written SYNCHRONOUSLY on every
// change — that's what makes the save-failure copy ("Your response is still
// on this device") honest even when the network dies mid-meeting.

import type { AnswerValue, SavePosition } from "./types";

export type SaveState = "idle" | "saving" | "saved" | "device_only";

type PendingEntry = { value: AnswerValue; position: SavePosition };

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

export class SaveQueue {
  private pending = new Map<string, PendingEntry>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private failedAttempts = 0;
  private disposed = false;
  /** The most recent save error — lets the shell distinguish "session
   *  expired" from a plain network failure (§23 has separate copy). */
  lastError: string | null = null;

  constructor(
    private readonly opts: {
      save: (key: string, value: AnswerValue, position: SavePosition) => Promise<{ error: string | null }>;
      onState: (s: SaveState) => void;
      debounceMs?: number;
    },
  ) {}

  /** Coalesce by key (last write wins) and debounce the flush. */
  enqueue(key: string, value: AnswerValue, position: SavePosition): void {
    if (this.disposed) return;
    this.pending.set(key, { value, position });
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flushAll(), this.opts.debounceMs ?? 800);
  }

  hasDirty(): boolean {
    return this.pending.size > 0;
  }

  dirtyKeys(): string[] {
    return [...this.pending.keys()];
  }

  /** Drain the queue now (Continue, blur, pagehide, manual retry). Safe to
   *  call while a flush is running — entries re-queued during a flush are
   *  picked up by the trailing pass. */
  async flushAll(): Promise<void> {
    if (this.disposed || this.inFlight) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pending.size === 0) return;
    this.inFlight = true;
    this.opts.onState("saving");
    let anyError = false;
    // Snapshot: writes that land while we're saving stay pending for the
    // next pass instead of being lost.
    const batch = [...this.pending.entries()];
    for (const [key, entry] of batch) {
      const { error } = await this.opts.save(key, entry.value, entry.position);
      if (this.disposed) return;
      if (error) {
        anyError = true;
        this.lastError = error;
        break; // keep this and later entries pending; retry with backoff
      }
      // Only clear if the entry wasn't superseded mid-flight.
      if (this.pending.get(key) === entry) this.pending.delete(key);
    }
    this.inFlight = false;
    if (anyError) {
      this.failedAttempts += 1;
      if (this.failedAttempts > RETRY_DELAYS_MS.length) {
        this.opts.onState("device_only");
      } else {
        this.opts.onState("saving");
        const delay = RETRY_DELAYS_MS[Math.min(this.failedAttempts - 1, RETRY_DELAYS_MS.length - 1)];
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => void this.flushAll(), delay);
      }
      return;
    }
    this.failedAttempts = 0;
    if (this.pending.size > 0) {
      // Entries arrived while saving — trailing pass.
      void this.flushAll();
    } else {
      this.opts.onState("saved");
    }
  }

  /** Manual "Try again" from the device-only banner. */
  retryNow(): void {
    this.failedAttempts = 0;
    void this.flushAll();
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }
}

// ---------------------------------------------------------------------------
// localStorage mirror — per-user draft of the whole AnswerMap. Every read and
// write is wrapped: private windows and cleared site data must degrade to
// "no draft", never to a crash.
// ---------------------------------------------------------------------------

const draftKey = (userId: string) => `purpose:draft:${userId}`;

export function readDraft(userId: string): Record<string, AnswerValue> | null {
  try {
    const raw = localStorage.getItem(draftKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, AnswerValue>) : null;
  } catch {
    return null;
  }
}

export function writeDraft(userId: string, map: Record<string, AnswerValue>): void {
  try {
    localStorage.setItem(draftKey(userId), JSON.stringify(map));
  } catch {
    // Best effort only — quota/private mode failures are acceptable here.
  }
}

export function clearDraft(userId: string): void {
  try {
    localStorage.removeItem(draftKey(userId));
  } catch {
    /* ignore */
  }
}

/** Merge server answers with the local mirror, newest per key. Mirror entries
 *  older than the server's copy are ignored (a stale device must not
 *  resurrect an old answer). Server rows carry updatedAt from the DB. */
export function mergeAnswers(
  server: Record<string, AnswerValue>,
  mirror: Record<string, AnswerValue> | null,
): { merged: Record<string, AnswerValue>; unsynced: string[] } {
  const merged: Record<string, AnswerValue> = { ...server };
  const unsynced: string[] = [];
  if (mirror) {
    for (const [key, local] of Object.entries(mirror)) {
      const remote = server[key];
      const localAt = Date.parse(local?.updatedAt ?? "") || 0;
      const remoteAt = Date.parse(remote?.updatedAt ?? "") || 0;
      if (!remote || localAt > remoteAt) {
        merged[key] = local;
        unsynced.push(key);
      }
    }
  }
  return { merged, unsynced };
}
