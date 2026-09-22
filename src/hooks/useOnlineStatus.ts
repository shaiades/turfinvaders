import { useSyncExternalStore } from "react";

const subscribe = (cb: () => void) => {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
};

/** navigator.onLine as reactive state. false is trustworthy ("definitely
 *  offline" — airplane mode, no radio); true only means "maybe" — weak-signal
 *  detection stays with the tile telemetry, not here. SSR snapshots true. */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}
