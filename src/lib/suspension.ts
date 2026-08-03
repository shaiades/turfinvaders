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
