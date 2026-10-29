/**
 * Month-old areas ("tagged" turfs from past runs) buried the captain maps —
 * owner ask 2026-10-29: "clear up the old areas so we can draw new ones and
 * see where our sales are at." Old areas HIDE by default (NeonMap's rail
 * toggle brings them back) instead of being deleted: turf_assignment_history
 * cascades on turf delete, so deleting would erase who-worked-where.
 */
export const OLD_AREA_DAYS = 30;

const OLD_AREA_MS = OLD_AREA_DAYS * 24 * 60 * 60 * 1000;

/**
 * An area is old when its last touch — assignment if any, else creation —
 * is more than OLD_AREA_DAYS ago. Unparseable/missing dates count as fresh:
 * a bad timestamp must never vanish a live turf.
 */
export function isOldArea(t: { assigned_at?: string | null; created_at?: string | null }): boolean {
  const assigned = t.assigned_at ? Date.parse(t.assigned_at) : NaN;
  const created = t.created_at ? Date.parse(t.created_at) : NaN;
  const latest = Math.max(
    Number.isNaN(assigned) ? -Infinity : assigned,
    Number.isNaN(created) ? -Infinity : created,
  );
  if (latest === -Infinity) return false;
  return Date.now() - latest > OLD_AREA_MS;
}
