/** Shared map-status vocabulary (leaflet-free, SSR-safe).
 *
 * The canvasser map has three independent health axes — basemap tiles,
 * screen data (turfs), and house circles — and the field failure mode is a
 * silent black rectangle (owner video 2026-09-21). These types are the
 * contract between the layers that *measure* (tile telemetry in NeonMap,
 * HouseBubbles fetches, screen queries) and the single status pill that
 * *speaks*.
 */

/** Basemap tile health, derived from Leaflet tile events on the imagery
 *  layer. "unknown" = no tile activity observed yet this epoch;
 *  "degraded" = tiles are erroring/stalling (weak signal or Esri down). */
export type TileHealth = "unknown" | "loading" | "ok" | "degraded";
