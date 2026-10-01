import { addDaysISO } from "@/lib/dates";
import { useDayOffWeek, type DayOffKind } from "@/hooks/useDayOff";

const DAY_LETTER = ["M", "T", "W", "T", "F", "S", "S"];

const KIND_TONE: Record<DayOffKind, string> = {
  day_off: "text-muted-foreground border-border",
  sick: "text-warning border-warning/40",
  no_show: "text-destructive border-destructive/40",
  excused: "text-victory border-victory/40",
  other: "text-muted-foreground border-border",
};

/** Mon–Sun strip of approved absences — who's off, when, and why, at a
 *  glance. Silent when the week is clean or the table hasn't shipped. */
export function DayOffWeekStrip({
  weekStartISO,
  teamId,
}: {
  weekStartISO: string;
  teamId?: string | null;
}) {
  const week = useDayOffWeek(weekStartISO, addDaysISO(weekStartISO, 6), teamId);
  if (!week.data || week.data.rows.length === 0) return null;
  const { rows, names } = week.data;
  const byDay = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byDay.get(r.absence_date) ?? [];
    list.push(r);
    byDay.set(r.absence_date, list);
  }

  return (
    <div className="mt-3 border-t border-border/40 pt-2">
      <div className="text-[9px] font-display uppercase tracking-widest text-muted-foreground mb-1">
        Days off this week
      </div>
      <div className="grid grid-cols-7 gap-1">
        {DAY_LETTER.map((letter, i) => {
          const day = addDaysISO(weekStartISO, i);
          const list = byDay.get(day) ?? [];
          return (
            <div key={day} className="min-w-0">
              <div className="text-[9px] font-display text-muted-foreground text-center">
                {letter}
              </div>
              <div className="flex flex-col gap-0.5">
                {list.map((r) => (
                  <span
                    key={r.id}
                    title={`${names.get(r.user_id) ?? "Unknown"} · ${r.kind.replace("_", "-")}`}
                    className={`truncate text-[8px] font-display uppercase tracking-wide border rounded px-0.5 text-center ${KIND_TONE[r.kind]}`}
                  >
                    {(names.get(r.user_id) ?? "?").split(" ")[0]}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
