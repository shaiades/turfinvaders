import L from "leaflet";

/**
 * Rotation-safe viewport bounds. With leaflet-rotate active, map.getBounds()
 * can collapse to a point (observed 2026-09-11: west==east==center), which
 * starves every viewport-driven fetch. containerPointToLatLng IS patched
 * correctly by the plugin, so the four container corners unproject exactly —
 * their latLngBounds is the true (axis-aligned) box of the possibly-rotated
 * view. Falls back to getBounds() for a degenerate container (hidden map).
 */
export function viewBounds(map: L.Map): L.LatLngBounds {
  const size = map.getSize();
  if (size.x > 0 && size.y > 0) {
    const b = L.latLngBounds([
      map.containerPointToLatLng([0, 0]),
      map.containerPointToLatLng([size.x, 0]),
      map.containerPointToLatLng([0, size.y]),
      map.containerPointToLatLng([size.x, size.y]),
    ]);
    if (b.isValid() && b.getNorth() > b.getSouth() && b.getEast() > b.getWest()) return b;
  }
  return map.getBounds();
}
