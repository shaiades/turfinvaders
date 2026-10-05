// Global arcade A/V preferences — the one source of truth for "is sound on?"
// and "are haptics on?". Sound is OFF by default (owner spec: "sound is off by
// default, with a toggle"); haptics default ON where the device supports
// navigator.vibrate. localStorage-backed and synced across components via a
// window event. Leaf module (no imports) so makeBeeper can gate on it without a
// cycle. Every access is try-guarded for private mode / SSR.

export const SOUND_KEY = "ti_sound_on_v1";
export const HAPTICS_KEY = "ti_haptics_on_v1";
export const FX_PREF_EVENT = "ti-fx-pref";

/** Sound defaults OFF — nothing plays until the viewer opts in. */
export function isSoundOn(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === "1";
  } catch {
    return false;
  }
}

/** Haptics default ON (where supported) — a quiet, native feel, no audio. */
export function isHapticsOn(): boolean {
  try {
    const v = localStorage.getItem(HAPTICS_KEY);
    return v == null ? true : v === "1";
  } catch {
    return true;
  }
}

function emit(): void {
  try {
    window.dispatchEvent(new Event(FX_PREF_EVENT));
  } catch {
    /* SSR */
  }
}

export function setSoundOn(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? "1" : "0");
  } catch {
    /* private mode — the pref just won't persist */
  }
  emit();
}

export function setHapticsOn(on: boolean): void {
  try {
    localStorage.setItem(HAPTICS_KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
  emit();
}

/** True iff the device exposes the Vibration API (phones; not most desktops). */
export function hapticsSupported(): boolean {
  try {
    return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
  } catch {
    return false;
  }
}
