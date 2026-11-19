/** Deploy-skew recovery for all-shift PWA sessions (incident 2026-11-10:
 *  canvassers resumed phones running the pre-9:28 shell after a mid-day
 *  deploy and dead-ended on a blank screen).
 *
 *  The vite:preloadError reload in __root only heals a LAZY import that
 *  fails mid-session — it lives inside the old bundle, so a shell that
 *  resumes too broken to run any JS never reaches it. This check is the
 *  proactive layer: when the app comes back to the foreground after a real
 *  absence, ask the server which commit is live and trade the stale shell
 *  for a fresh document before the rep walks into a dead screen.
 *
 *  Reloads only fire after ≥15 min hidden: an app-switch (camera, Maps)
 *  must never eat a half-typed note, and a shell that fresh self-heals via
 *  the chunk-error path anyway. One reload per new commit, so a misbehaving
 *  endpoint can never loop a device. */

const MIN_HIDDEN_MS = 15 * 60_000;
const RELOADED_FOR_KEY = "ti_skew_reloaded_for";

export function initDeploySkewReload(): void {
  if (typeof window === "undefined") return;
  if (!import.meta.env.PROD) return;
  const mine = __BUILD_COMMIT__;
  if (!mine || mine === "dev") return;

  let hiddenAt: number | null = null;

  const check = async () => {
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) return;
      const { commit } = (await res.json()) as { commit: string | null };
      if (!commit || commit === mine) return;
      try {
        if (sessionStorage.getItem(RELOADED_FOR_KEY) === commit) return;
        sessionStorage.setItem(RELOADED_FOR_KEY, commit);
      } catch {
        /* blocked storage: the commit guard above still prevents loops once
           the fresh shell (whose commit matches) is running */
      }
      window.location.reload();
    } catch {
      /* offline at the door — the next long resume checks again */
    }
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    const gone = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (gone >= MIN_HIDDEN_MS) void check();
  });
}
