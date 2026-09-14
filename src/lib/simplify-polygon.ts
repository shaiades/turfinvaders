import type { LatLng } from "@/components/NeonMap";

/**
 * Ramer–Douglas–Peucker simplification for a lat/lng ring, in degree space.
 * Good enough for drawing faint historical coverage outlines where exact
 * boundaries don't matter — cuts ~100-vertex RepCard areas to a handful so the
 * map can carry thousands of them without choking.
 *
 * `epsilonDeg` ~0.00012 ≈ 12–13 m at SoCal latitudes.
 */
export function simplifyRing(points: LatLng[], epsilonDeg = 0.00012): LatLng[] {
  if (points.length <= 4) return points;

  const perpDist = (p: LatLng, a: LatLng, b: LatLng): number => {
    const dx = b.lng - a.lng;
    const dy = b.lat - a.lat;
    const len = Math.hypot(dx, dy);
    if (len === 0) return Math.hypot(p.lng - a.lng, p.lat - a.lat);
    // |cross product| / |ab|
    return Math.abs((p.lng - a.lng) * dy - (p.lat - a.lat) * dx) / len;
  };

  const rdp = (pts: LatLng[]): LatLng[] => {
    if (pts.length < 3) return pts;
    let maxD = 0;
    let idx = 0;
    const first = pts[0];
    const last = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) {
      const d = perpDist(pts[i], first, last);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > epsilonDeg) {
      const left = rdp(pts.slice(0, idx + 1));
      const right = rdp(pts.slice(idx));
      return left.slice(0, -1).concat(right);
    }
    return [first, last];
  };

  const out = rdp(points);
  return out.length >= 3 ? out : points;
}
