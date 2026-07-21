// Shared Monday-anchored week helpers — ALL anchored to America/Los_Angeles.
//
// Owner directive (2026-07-20): every date/week bucket in the software
// reflects Pacific time, never UTC and never the viewer's device timezone.
// Weeks run Monday→Sunday with stats resetting at midnight PT Monday.
// The SQL side mirrors this via `AT TIME ZONE 'America/Los_Angeles'` casts
// (see supabase/migrations/20260721060000_pacific_time_bucketing.sql).

export const LA_TZ = "America/Los_Angeles";

/** LA calendar date (YYYY-MM-DD) of an instant — en-CA formats as ISO. */
export function laDateISO(instant: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: LA_TZ }).format(instant);
}

/** Today's LA calendar date, YYYY-MM-DD. */
export function laTodayISO(): string {
  return laDateISO(new Date());
}

/** Local-midnight Date for a YYYY-MM-DD calendar date (for UI state/labels). */
export function dateFromISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Calendar-date math in ISO space (DST-safe: computed at UTC noon). */
export function addDaysISO(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  noon.setUTCDate(noon.getUTCDate() + n);
  return noon.toISOString().slice(0, 10);
}

/** Monday (YYYY-MM-DD) of the week containing a calendar date — pure date math. */
export function weekStartOfISO(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0=Sun..6=Sat
  return addDaysISO(iso, day === 0 ? -6 : 1 - day);
}

/** LA Monday (YYYY-MM-DD) of the week containing `instant`. */
export function laWeekStartISO(instant: Date = new Date()): string {
  return weekStartOfISO(laDateISO(instant));
}

/** Local-midnight Date of the LA Monday of the week containing `d`. */
export function weekStartMonday(d: Date = new Date()): Date {
  return dateFromISO(laWeekStartISO(d));
}

/**
 * YYYY-MM-DD of a Date via LOCAL getters. Pairs with dateFromISO /
 * weekStartMonday, which hand back local-midnight Dates for LA calendar
 * dates — toISOString() here would shift the date for viewers east of UTC.
 */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** UTC instant (ISO string) of midnight in LA on a calendar date (PST/PDT-safe). */
export function laMidnightUtcISO(isoDate: string): string {
  const guess = new Date(`${isoDate}T08:00:00Z`); // 00:00 LA if PST (UTC-8)
  const laHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: LA_TZ, hour12: false, hour: "2-digit" }).format(guess),
  );
  return new Date(guess.getTime() - laHour * 3_600_000).toISOString(); // 01:00 during PDT → back 1h
}
