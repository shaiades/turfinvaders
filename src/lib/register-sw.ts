/** Boot-time registration of /sw.js (Esri tile cache + Web Push).
 *
 * Historically the worker was registered only by the "Enable alerts" flow
 * (src/lib/push.ts), so most canvassers never had one and every basemap
 * tile re-downloaded over field cellular each visit. Registering at boot
 * turns the tile cache on for everyone; push.ts needs no change —
 * register() is idempotent and its getRegistration("/sw.js") finds this
 * registration.
 *
 * PROD-only: in dev a controlling worker blinds the Network panel to real
 * tile traffic. Delayed past `load` so registration never competes with
 * hydration for a weak connection's bandwidth.
 */
export function registerServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (!import.meta.env.PROD) return;
  const go = () => {
    window.setTimeout(() => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Best-effort: without a worker, tiles just fall back to plain HTTP.
      });
    }, 1500);
  };
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
}
