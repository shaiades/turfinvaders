import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Every cache a punch can change, invalidated as prefixes in one place.
 * Punch state gates more than the clock UI: ["time-clock-open"] drives the
 * HUD's off-the-clock alarm AND CrewBeacon's GPS broadcast, and the dispatch
 * Day roster reads ["fleet_dispatch","clock"]. A bulk crew punch, a timesheet
 * save, and a self punch must all sweep the same set — call this instead of
 * hand-rolling invalidation lists so a new consumer can't be missed.
 */
const PUNCH_CACHE_PREFIXES: QueryKey[] = [
  ["time-clock-open"],
  ["time-clock-today"],
  ["time-clock-meals"],
  ["time-clock-flagged"],
  ["time-review-queue"],
  ["timesheets"],
  ["payroll-ledger"],
  ["fleet_dispatch", "clock"],
  ["van-clock"],
  ["my_clocked_hours"],
  ["earnings"],
  ["takehome_volume_bonus"],
];

export function invalidatePunchCaches(qc: QueryClient): void {
  for (const queryKey of PUNCH_CACHE_PREFIXES) qc.invalidateQueries({ queryKey });
}
