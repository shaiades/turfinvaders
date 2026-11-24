import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { addDaysISO, laTodayISO, laWeekStartISO } from "@/lib/dates";
import { ArcadePanel, ArcadePill } from "@/components/arcade";
import { useMySickBalance } from "@/hooks/useDayOff";

const DAY_LABEL = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** This week's hours at a glance for the Office Portal — one row per worked
 *  day, a week total, and the sick-leave bank. Hours only, no dollars (the
 *  accountant applies rates). Reads the worker's own time_entries under the
 *  self-read RLS policy. */
export function OfficeWeekSummary({ userId }: { userId: string }) {
  const weekStart = laWeekStartISO();
  const weekEnd = addDaysISO(weekStart, 6);
  const today = laTodayISO();
  const sickQuery = useMySickBalance(userId);
  const sickHours = sickQuery.data?.balance_hours;

  const { data: days } = useQuery({
    queryKey: ["office-week-summary", userId, weekStart],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_entries")
        .select("log_date, billable_hours, clock_out")
        .eq("user_id", userId)
        .gte("log_date", weekStart)
        .lte("log_date", weekEnd)
        .is("voided_at", null);
      if (error) throw error;
      const byDay = new Map<string, { hours: number; open: boolean }>();
      for (const row of data ?? []) {
        const prev = byDay.get(row.log_date) ?? { hours: 0, open: false };
        byDay.set(row.log_date, {
          hours: prev.hours + Number(row.billable_hours ?? 0),
          open: prev.open || row.clock_out === null,
        });
      }
      return byDay;
    },
  });

  const total = [...(days?.values() ?? [])].reduce((s, d) => s + d.hours, 0);

  return (
    <ArcadePanel
      title="This Week"
      action={<span className="font-mono text-sm text-victory">{total.toFixed(2)} h</span>}
    >
      <div className="space-y-1">
        {DAY_LABEL.map((label, i) => {
          const iso = addDaysISO(weekStart, i);
          const d = days?.get(iso);
          const isToday = iso === today;
          const future = iso > today;
          if (future && !d) return null;
          return (
            <div
              key={iso}
              className={`flex items-center justify-between rounded-md px-2 py-1.5 text-sm ${
                isToday ? "bg-accent/10" : ""
              }`}
            >
              <span className={isToday ? "text-foreground" : "text-muted-foreground"}>
                {label}
                {isToday ? " · today" : ""}
              </span>
              <span className="font-mono">
                {d ? (
                  <>
                    {d.hours.toFixed(2)} h
                    {d.open ? <span className="text-neon"> · on the clock</span> : null}
                  </>
                ) : (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </span>
            </div>
          );
        })}
        {sickHours !== null && sickHours !== undefined ? (
          <div className="pt-2">
            <ArcadePill>Sick bank · {Number(sickHours).toFixed(1)} h</ArcadePill>
          </div>
        ) : null}
      </div>
    </ArcadePanel>
  );
}
