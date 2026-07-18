// Shared Monday-anchored week helpers.
//
// These replicate the exact semantics already used across the app
// (PayrollLedger.weekStartOf, ExecutiveDashboard.startOfWeekMon,
// FleetManager.startOfWeekMonday, CanvasserPersonalDashboard.startOfWeekISO):
// local-midnight Monday computed via getDay(), then serialized with
// toISOString().slice(0,10). Do NOT "fix" the local-vs-UTC quirk here —
// changing it would shift every query window that adopts these helpers.

/** Local-midnight Monday of the week containing `d` (defaults to now). */
export function weekStartMonday(d: Date = new Date()): Date {
  const monday = new Date(d);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

/** YYYY-MM-DD via toISOString — matches the app's existing serialization. */
export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}
