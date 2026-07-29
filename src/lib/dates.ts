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
    new Intl.DateTimeFormat("en-US", { timeZone: LA_TZ, hour12: false, hour: "2-digit" }).format(
      guess,
    ),
  );
  return new Date(guess.getTime() - laHour * 3_600_000).toISOString(); // 01:00 during PDT → back 1h
}

/** First of the month (YYYY-MM-01) containing a YYYY-MM-DD calendar date. */
export function monthStartISO(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** First of the current LA month, YYYY-MM-01. */
export function laMonthStartISO(): string {
  return monthStartISO(laTodayISO());
}

/** First of the month after the one containing `iso` (Dec → Jan 1 next year). */
export function nextMonthStartISO(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/** "Jul 6 – 12, 2026" | "Jul 28 – Aug 2, 2026" | "Dec 28, 2026 – Jan 2, 2027".
 *  Viewer-locale month names, matching the existing week-selector labels. */
export function formatWeekRange(start: Date, end: Date): string {
  const sameMonth = start.getMonth() === end.getMonth();
  const sameYear = start.getFullYear() === end.getFullYear();
  const monthFmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });
  const sM = monthFmt(start);
  const eM = monthFmt(end);
  const sD = start.getDate();
  const eD = end.getDate();
  if (sameMonth && sameYear) return `${sM} ${sD} – ${eD}, ${end.getFullYear()}`;
  if (sameYear) return `${sM} ${sD} – ${eM} ${eD}, ${end.getFullYear()}`;
  return `${sM} ${sD}, ${start.getFullYear()} – ${eM} ${eD}, ${end.getFullYear()}`;
}

// --- Report-date clock (7 PM PT lock) ---

const LA_DATE_HOUR_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: LA_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
});

/**
 * The report-date is the PT calendar date whose 7:00 PM boundary is the "lock".
 * Before 7 PM PT → report-date = current PT date (live preview of today's totals).
 * At/after 7 PM PT → report-date rolls forward: today's totals seed the NEXT PT date.
 * `wkStart` is the LA Monday of the report-date's week.
 */
export function reportDates(): { today: string; yday: string; wkStart: string; locked: boolean } {
  const parts = Object.fromEntries(
    LA_DATE_HOUR_PARTS.formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour === "24" ? "0" : parts.hour);
  const currentPT = `${parts.year}-${parts.month}-${parts.day}`;
  const locked = hour >= 19;
  const today = locked ? addDaysISO(currentPT, 1) : currentPT;
  return { today, yday: addDaysISO(today, -1), wkStart: weekStartOfISO(today), locked };
}

/** The last `n` completed worked days (Mon–Sat; Sundays never count),
 *  walking back from — and excluding — the given report date. Newest first.
 *  On a Tuesday this yields [Mon, Sat, Fri, …]: Saturday and Monday are
 *  consecutive worked days for the suspension rule. */
export function lastWorkedDaysBefore(todayISO: string, n: number): string[] {
  const out: string[] = [];
  let d = todayISO;
  while (out.length < n) {
    d = addDaysISO(d, -1);
    if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) out.push(d);
  }
  return out;
}

/** Remaining Mon–Sat workdays in the LA month containing `todayISO`,
 *  today inclusive (Sundays never count — matches the pay week). */
export function remainingWorkdaysInMonth(todayISO: string): number {
  const monthPrefix = todayISO.slice(0, 7);
  let n = 0;
  for (let d = todayISO; d.startsWith(monthPrefix); d = addDaysISO(d, 1)) {
    const [y, m, dd] = d.split("-").map(Number);
    if (new Date(Date.UTC(y, m - 1, dd, 12)).getUTCDay() !== 0) n++;
  }
  return n;
}

/** Remaining Mon–Sat workdays in `todayISO`'s week, today inclusive.
 *  0 on a Sunday (its Mon–Sat week is over) — callers keep their
 *  `days > 0 ? x / days : x` guard. */
export function remainingWorkdaysInWeek(todayISO: string): number {
  const weekEnd = addDaysISO(weekStartOfISO(todayISO), 5); // Saturday
  let n = 0;
  for (let d = todayISO; d <= weekEnd; d = addDaysISO(d, 1)) {
    const [y, m, dd] = d.split("-").map(Number);
    if (new Date(Date.UTC(y, m - 1, dd, 12)).getUTCDay() !== 0) n++;
  }
  return n;
}

/** "Mon 7/28" for a chip label. */
export function fmtWorkedDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`)
    .toLocaleDateString("en-US", {
      weekday: "short",
      month: "numeric",
      day: "numeric",
      timeZone: "UTC",
    })
    .replace(",", "");
}
