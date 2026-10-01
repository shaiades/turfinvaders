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

/** True iff `value` (an ISO instant or bare YYYY-MM-DD) lands on today's LA
 *  calendar date. Unparseable/legacy values (e.g. an old once-ever "1" flag)
 *  are NOT today — the intro seen-flags use this so "seen" means "seen
 *  today". Bare dates compare as strings on purpose: Date.parse reads them
 *  as UTC midnight, which is 4-5pm the PREVIOUS LA day. */
export function isLaToday(value: string | null | undefined): boolean {
  if (!value) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value === laTodayISO();
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && laDateISO(new Date(ms)) === laTodayISO();
}

/** "05:30" / "05:30:00" (PT wall-clock time string, e.g. a PG `time`) → "5:30 AM". */
export function fmtWallTime(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
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

/** Monday (YYYY-MM-DD) of the Weekly Action Plan week: on an LA Sunday the
 *  plan shows the UPCOMING week (owner spec 2026-10-01), every other day the
 *  current Mon–Sun week. Takes `instant` so verify scripts can pin Sundays
 *  and DST boundaries. */
export function planWeekStartISO(instant: Date = new Date()): string {
  const d = laDateISO(instant);
  const ws = weekStartOfISO(d);
  return d === addDaysISO(ws, 6) ? addDaysISO(ws, 7) : ws;
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

/** LA wall time of an instant as a datetime-local value ("YYYY-MM-DDTHH:MM").
 *  Pairs with laWallToUtcISO so time editors read and write Pacific wall
 *  clock regardless of the viewer's device timezone. */
export function laWallFromISO(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: LA_TZ }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: LA_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
  return `${date}T${time}`;
}

/** "HH:MM" LA wall time of an instant — for time-only inputs. */
export function laTimeHM(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: LA_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

/** UTC instant (ISO) of an LA wall time ("YYYY-MM-DDTHH:MM[:SS]"). DST-safe
 *  via the same guess-and-correct technique as laMidnightUtcISO: start from
 *  PST (UTC-8), measure how the guess renders in LA, shift by the delta, and
 *  verify once more for the spring-forward edge. A nonexistent wall time
 *  (inside the skipped DST hour) resolves to a stable nearby instant. */
export function laWallToUtcISO(wall: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (!m) return null;
  const label = (s: string) => {
    const p = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
    if (!p) return NaN;
    return Date.UTC(+p[1], +p[2] - 1, +p[3], +p[4], +p[5]);
  };
  const target = label(wall);
  if (isNaN(target)) return null;
  let guess = target + 8 * 3_600_000; // 00:00 LA = 08:00 UTC during PST
  for (let i = 0; i < 2; i++) {
    const diff = target - label(laWallFromISO(new Date(guess).toISOString()));
    if (!diff) break;
    guess += diff;
  }
  return new Date(guess).toISOString();
}

/** "Aug 14, 2026 @ 04:26 PM" in Pacific time — turf provenance lines. */
export function laDateTimeLabel(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: LA_TZ,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: LA_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  return `${date} @ ${time}`;
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

// --- Report-date clock (6 PM PT lock) ---

const LA_DATE_HOUR_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: LA_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
});

/**
 * The report-date is the PT calendar date whose 6:00 PM boundary is the "lock"
 * (moved from 7 PM, owner ask 2026-09-22 — the shift's auto clock-out already
 * lands at 6 PM, and the end-of-day recap + push key off this same boundary).
 * Before 6 PM PT → report-date = current PT date (live preview of today's totals).
 * At/after 6 PM PT → report-date rolls forward: today's totals seed the NEXT PT date.
 * `wkStart` is the LA Monday of the report-date's week.
 */
export function reportDates(): { today: string; yday: string; wkStart: string; locked: boolean } {
  const parts = Object.fromEntries(
    LA_DATE_HOUR_PARTS.formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour === "24" ? "0" : parts.hour);
  const currentPT = `${parts.year}-${parts.month}-${parts.day}`;
  const locked = hour >= 18;
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

/** The most recent COMPLETED report day: the last Mon–Sat day strictly before
 *  the live report anchor. Rolls forward at the 6 PM PT lock; Sundays never
 *  appear (nobody works them). Sat 6:01 PM → Sat; all Sunday → Sat; Mon 9 AM
 *  (pre-lock) → Sat — the weekend gap is bridged, so a rep who never opened
 *  the app after Saturday's lock still gets Saturday's recap Monday morning. */
export function completedReportDay(): string {
  return lastWorkedDaysBefore(reportDates().today, 1)[0];
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
