import { useEffect, useMemo, useState } from "react";
import { useWeekSelector } from "@/hooks/useWeekSelector";
import {
  addDaysISO,
  dateFromISO,
  formatWeekRange,
  laMidnightUtcISO,
  laMonthStartISO,
  laTodayISO,
  monthStartISO,
  nextMonthStartISO,
} from "@/lib/dates";

export type RangeTab = "day" | "week" | "month";
export type DayPreset = "today" | "yesterday";

export type ResolvedDateRange = {
  tab: RangeTab;
  /** Inclusive LA calendar-date bounds (YYYY-MM-DD) for date columns
   *  (daily_logs.log_date, daily_metrics.metric_date). */
  startISO: string;
  endISO: string;
  /** UTC instant window [startUtc, endUtcExclusive) for timestamptz columns
   *  (leads.created_at). Week runs Mon 00:00 → next Mon 00:00 LA (pay-engine
   *  attribution) even though the date bounds read Mon–Sat, mirroring Fleet
   *  Dispatch's volume windows. */
  startUtcISO: string;
  endUtcExclusiveISO: string;
  label: string;
  sub: string;
  /** True when the range covers the live LA day (today / current week / current month). */
  isLive: boolean;
};

export type DateRangeControls = {
  range: ResolvedDateRange;
  tab: RangeTab;
  setTab: (t: RangeTab) => void;
  dayPreset: DayPreset;
  setDayPreset: (p: DayPreset) => void;
  week: ReturnType<typeof useWeekSelector>;
  isCurrentMonth: boolean;
  shiftMonth: (delta: 1 | -1) => void;
  goToCurrentMonth: () => void;
};

/** Day / Week / Month range engine shared by the captain dashboard, van
 *  detail, and player profile — same LA-calendar semantics as Fleet Dispatch:
 *  Day is the full LA calendar day (Today/Yesterday presets), Week is the
 *  Mon–Sat pay week with prev/next paging, Month is the LA month with paging. */
export function useDateRange(opts?: { initialTab?: RangeTab }): DateRangeControls {
  const [tab, setTab] = useState<RangeTab>(opts?.initialTab ?? "day");
  const [dayPreset, setDayPreset] = useState<DayPreset>("today");
  const [today, setToday] = useState(laTodayISO);

  // Roll to the new calendar day at midnight PT.
  useEffect(() => {
    const id = window.setInterval(() => {
      setToday((prev) => {
        const next = laTodayISO();
        return next === prev ? prev : next;
      });
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const week = useWeekSelector({ endOffsetDays: 5 }); // Mon–Sat, Block-board convention
  const [monthStart, setMonthStart] = useState<string>(() => laMonthStartISO());
  const shiftMonth = (delta: 1 | -1) =>
    setMonthStart((m) => (delta > 0 ? nextMonthStartISO(m) : monthStartISO(addDaysISO(m, -1))));
  const isCurrentMonth = monthStart === laMonthStartISO();
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
    dateFromISO(monthStart),
  );

  const range: ResolvedDateRange = useMemo(() => {
    if (tab === "day") {
      const d = dayPreset === "yesterday" ? addDaysISO(today, -1) : today;
      return {
        tab,
        startISO: d,
        endISO: d,
        startUtcISO: laMidnightUtcISO(d),
        endUtcExclusiveISO: laMidnightUtcISO(addDaysISO(d, 1)),
        label: dayPreset === "yesterday" ? "Yesterday" : "Today",
        sub: d,
        isLive: dayPreset === "today",
      };
    }
    if (tab === "week") {
      return {
        tab,
        startISO: week.weekStartISO,
        endISO: week.weekEndISO,
        startUtcISO: laMidnightUtcISO(week.weekStartISO),
        endUtcExclusiveISO: laMidnightUtcISO(addDaysISO(week.weekStartISO, 7)),
        label: formatWeekRange(week.weekStart, week.weekEnd),
        sub: `${week.weekStartISO} → ${week.weekEndISO}`,
        isLive: week.isCurrentWeek,
      };
    }
    const monthEnd = addDaysISO(nextMonthStartISO(monthStart), -1);
    return {
      tab,
      startISO: monthStart,
      endISO: monthEnd,
      startUtcISO: laMidnightUtcISO(monthStart),
      endUtcExclusiveISO: laMidnightUtcISO(nextMonthStartISO(monthStart)),
      label: monthLabel,
      sub: `${monthStart} → ${monthEnd}`,
      isLive: isCurrentMonth,
    };
  }, [
    tab,
    dayPreset,
    today,
    week.weekStart,
    week.weekEnd,
    week.weekStartISO,
    week.weekEndISO,
    week.isCurrentWeek,
    monthStart,
    monthLabel,
    isCurrentMonth,
  ]);

  return {
    range,
    tab,
    setTab,
    dayPreset,
    setDayPreset,
    week,
    isCurrentMonth,
    shiftMonth,
    goToCurrentMonth: () => setMonthStart(laMonthStartISO()),
  };
}
