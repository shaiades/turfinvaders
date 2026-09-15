/**
 * Compose a caller's AbortSignal with a hard client-side deadline.
 *
 * The map's external fetches (Overpass, TIGERweb ZCTAs) had no client
 * timeout: a stalled endpoint held its layer hostage until the next pan
 * aborted it, which read as "the map never loads". Server-side hints like
 * Overpass's `[timeout:8]` don't cover a hung TCP connection.
 *
 * The deadline aborts with a TimeoutError (never AbortError), so callers
 * that treat AbortError as "the viewport moved on" still fail over /
 * retry on a timeout instead of going silent.
 */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout: AbortSignal | undefined = AbortSignal.timeout?.(ms);
  if (!timeout) return signal ?? new AbortController().signal; // very old engines: no deadline
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  // Safari < 17.4: manual composition, forwarding each source's reason so
  // a timeout still surfaces as TimeoutError and a user abort as AbortError.
  const ctrl = new AbortController();
  const forward = (src: AbortSignal) => () => {
    if (!ctrl.signal.aborted) ctrl.abort(src.reason);
  };
  if (signal.aborted) ctrl.abort(signal.reason);
  else signal.addEventListener("abort", forward(signal), { once: true });
  timeout.addEventListener("abort", forward(timeout), { once: true });
  return ctrl.signal;
}
