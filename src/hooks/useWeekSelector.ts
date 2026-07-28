import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { addDays, toISODate, weekStartMonday } from "@/lib/dates";

/**
 * Monday-anchored week selection (LA calendar via weekStartMonday), shared by
 * the weekly views. `endOffsetDays` 5 = Mon–Sat pay week (default), 6 = full
 * Mon–Sun week.
 */
export function useWeekSelector(opts?: { initialOffsetWeeks?: number; endOffsetDays?: 5 | 6 }): {
  weekStart: Date;
  weekEnd: Date;
  weekStartISO: string;
  weekEndISO: string;
  isCurrentWeek: boolean;
  shiftWeek: (deltaWeeks: number) => void;
  goToWeek: (d?: Date) => void;
  setWeekStart: Dispatch<SetStateAction<Date>>;
} {
  const initialOffsetWeeks = opts?.initialOffsetWeeks ?? 0;
  const endOffsetDays = opts?.endOffsetDays ?? 5;
  const [weekStart, setWeekStart] = useState<Date>(() =>
    addDays(weekStartMonday(), initialOffsetWeeks * 7),
  );
  const weekEnd = useMemo(() => addDays(weekStart, endOffsetDays), [weekStart, endOffsetDays]);
  const weekStartISO = toISODate(weekStart);
  const weekEndISO = toISODate(weekEnd);
  const isCurrentWeek = weekStartISO === toISODate(weekStartMonday());
  return {
    weekStart,
    weekEnd,
    weekStartISO,
    weekEndISO,
    isCurrentWeek,
    shiftWeek: (deltaWeeks) => setWeekStart((w) => addDays(w, deltaWeeks * 7)),
    goToWeek: (d) => setWeekStart(weekStartMonday(d)),
    setWeekStart,
  };
}
