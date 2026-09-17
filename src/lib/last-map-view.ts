import type { LatLng } from "@/components/NeonMap";

// In-memory only (not persisted): Turf Tools and the canvass screen mount
// separate NeonMap/Leaflet instances, so switching between them used to
// reset pan/zoom/rotation (captain feedback 2026-09-17). Both screens report
// their view here on every move/zoom/rotate and read it back as the next
// mount's initial view, so a session of bouncing back and forth keeps its
// place. A fresh page load starts with no saved view — same as before.
export type MapView = { center: LatLng; zoom: number; bearing: number };

let last: MapView | null = null;

export function getLastMapView(): MapView | null {
  return last;
}

export function setLastMapView(v: MapView): void {
  last = v;
}
