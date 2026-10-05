// Reactive read of the global arcade sound/haptics preferences, so toggles and
// icons across the app stay in sync the instant the pref changes (any
// component can flip it; a window event fans the change out). SSR-safe.

import { useSyncExternalStore } from "react";
import { FX_PREF_EVENT, isHapticsOn, isSoundOn } from "@/lib/fx-prefs";

function subscribe(cb: () => void): () => void {
  window.addEventListener(FX_PREF_EVENT, cb);
  window.addEventListener("storage", cb); // other tabs
  return () => {
    window.removeEventListener(FX_PREF_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function useFxPrefs(): { sound: boolean; haptics: boolean } {
  const sound = useSyncExternalStore(subscribe, isSoundOn, () => false);
  const haptics = useSyncExternalStore(subscribe, isHapticsOn, () => true);
  return { sound, haptics };
}
