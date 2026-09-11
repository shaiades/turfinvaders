// Suspension-box recency gate (owner, 2026-08-03): a rep with no
// Monday-credited day in over 7 calendar days is presumed off the team and
// stays out of the suspension displays until the nightly auto_archive_agents
// job (14 days) archives them for real. Activity = daily_metrics row
// PRESENCE, matching the archive job — a 0-lead row is still a worked day;
// only absence means gone. New hires with no rows yet get the same
// created_at grace the archive job uses.

import { addDaysISO } from "./dates";

export const SUSPENSION_RECENCY_DAYS = 7;

/** canvasser_id → most recent metric_date, from row presence. */
export function lastActiveMap(
  rows: Array<{ canvasser_id: string; metric_date: string }>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    const prev = m.get(r.canvasser_id);
    if (!prev || r.metric_date > prev) m.set(r.canvasser_id, r.metric_date);
  }
  return m;
}

/** True when ANY of the (de-duped) ids was active within the last
 *  SUSPENSION_RECENCY_DAYS calendar days (inclusive), or the profile is
 *  newer than the window. createdISO is YYYY-MM-DD. */
export function isRecentlyActive(
  todayISO: string,
  ids: string[],
  lastActive: Map<string, string>,
  createdISO: string,
): boolean {
  const cutoff = addDaysISO(todayISO, -SUSPENSION_RECENCY_DAYS);
  if (createdISO >= cutoff) return true;
  return ids.some((id) => (lastActive.get(id) ?? "") >= cutoff);
}

/** The donut check over completed worked days, clock-in aware (owner,
 *  2026-09-11: a day with no clock-in never counts against anyone).
 *
 *  A day "qualifies" only when the profile existed, the rep was CLOCKED IN,
 *  and their lead activity was zero. Flagged iff the two most recent worked
 *  days both qualify; the streak counts consecutive qualifying days from the
 *  newest backward, so a day off (no punch) resets it the same way a
 *  produced day does — only company-wide off days (Sundays, already absent
 *  from workedDays) are skipped without resetting. Returns null when not
 *  flagged; `capped` means the streak ran the whole window ("N+"). */
export function donutEval(opts: {
  /** Completed worked days, NEWEST FIRST, Sundays excluded. */
  workedDays: string[];
  /** YYYY-MM-DD the profile was created — earlier days can't count. */
  oldestCreated: string;
  /** Lead activity credited to that day (generated + submitted + confirmed). */
  genOn: (day: string) => number;
  /** Whether the rep has a (non-voided) time entry on that day. */
  clockedOn: (day: string) => boolean;
}): { streak: number; capped: boolean } | null {
  const { workedDays, oldestCreated, genOn, clockedOn } = opts;
  if (workedDays.length < 2) return null;
  const qualifies = (day: string) => day >= oldestCreated && clockedOn(day) && genOn(day) === 0;
  if (!qualifies(workedDays[0]) || !qualifies(workedDays[1])) return null;
  let streak = 0;
  let capped = true;
  for (const day of workedDays) {
    if (!qualifies(day)) {
      capped = false;
      break;
    }
    streak++;
  }
  return { streak, capped };
}
