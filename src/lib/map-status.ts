/** Shared map-status vocabulary + resolver (leaflet-free, SSR-safe).
 *
 * The canvasser map has three independent health axes — basemap tiles,
 * screen data (turfs), and house circles — and the field failure mode was a
 * silent black rectangle (owner video 2026-09-21). These types are the
 * contract between the layers that *measure* (tile telemetry in NeonMap,
 * HouseBubbles fetches, screen queries) and the single status pill that
 * *speaks*. One pill at a time: a stack of banners is chrome, one honest
 * sentence is status.
 */

/** Basemap tile health, derived from Leaflet tile events on the imagery
 *  layer. "unknown" = no tile activity observed yet this epoch;
 *  "degraded" = tiles are erroring/stalling (weak signal or Esri down). */
export type TileHealth = "unknown" | "loading" | "ok" | "degraded";

/** What the owning screen knows about its map data (turfs/areas). */
export type MapDataStatus = {
  state: "loading" | "error" | "ok";
  /** Fills the copy: "Loading {what}…" — "your turf" | "turfs" | "areas". */
  what: string;
  onRetry?: () => void;
};

export type MapStatus =
  | { kind: "offline" }
  | { kind: "data-error"; what: string; onRetry?: () => void }
  | { kind: "data-loading"; what: string }
  | { kind: "weak-signal" }
  | { kind: "tiles-loading" }
  | { kind: "circles-unavailable" }
  | { kind: "zoom-hint" }
  | null;

/** Highest-priority status wins. Offline outranks data-error because the
 *  connection IS the root cause; data states outrank tile states because
 *  "your turf" is what the canvasser is waiting on; the circles/zoom
 *  affordances are hints, not health, and rank last. Callers pre-gate the
 *  inputs (e.g. circlesUnavailable only at bubble zoom on bubble screens). */
export function resolveMapStatus(s: {
  online: boolean;
  data?: MapDataStatus;
  tileHealth: TileHealth;
  circlesUnavailable: boolean;
  zoomHint: boolean;
}): MapStatus {
  if (!s.online) return { kind: "offline" };
  if (s.data?.state === "error")
    return { kind: "data-error", what: s.data.what, onRetry: s.data.onRetry };
  if (s.data?.state === "loading") return { kind: "data-loading", what: s.data.what };
  if (s.tileHealth === "degraded") return { kind: "weak-signal" };
  if (s.tileHealth === "loading") return { kind: "tiles-loading" };
  if (s.circlesUnavailable) return { kind: "circles-unavailable" };
  if (s.zoomHint) return { kind: "zoom-hint" };
  return null;
}
