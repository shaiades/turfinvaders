import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";

function readStoredTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(THEME_STORAGE_KEY);
  return v === "light" || v === "dark" ? v : null;
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

// Module-level singleton, mirroring the sharedGetUser pattern in useAuth: the
// header toggle and the root's sonner Toaster both need the same value, so a
// flip in one place updates every mounted consumer immediately.
let currentTheme: Theme = readStoredTheme() ?? "dark";
const listeners = new Set<(theme: Theme) => void>();

function setTheme(theme: Theme) {
  currentTheme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private-mode/blocked storage — theme just won't persist across reloads.
  }
  applyTheme(theme);
  listeners.forEach((l) => l(theme));
}

/** Server-rendered markup always assumes "dark" (matching __root's inline
 *  <html class="dark"> + flash-prevention script); syncing to the real
 *  stored value in an effect avoids a hydration mismatch. */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    setThemeState(currentTheme);
    listeners.add(setThemeState);
    return () => {
      listeners.delete(setThemeState);
    };
  }, []);

  return {
    theme,
    setTheme,
    toggleTheme: () => setTheme(currentTheme === "dark" ? "light" : "dark"),
  };
}
