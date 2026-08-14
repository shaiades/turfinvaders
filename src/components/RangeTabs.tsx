import { Button } from "@/components/ui/button";
import { CalendarRange, ChevronLeft, ChevronRight } from "lucide-react";
import type { DateRangeControls, DayPreset, RangeTab } from "@/hooks/useDateRange";

/** Day / Week / Month pill row — visual twin of the Fleet Dispatch range bar,
 *  driven by useDateRange so every screen pages dates identically. */
export function RangeTabs({ controls }: { controls: DateRangeControls }) {
  const {
    range,
    tab,
    setTab,
    dayPreset,
    setDayPreset,
    week,
    isCurrentMonth,
    shiftMonth,
    goToCurrentMonth,
  } = controls;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
      {(
        [
          { id: "day", label: "Day" },
          { id: "week", label: "Week" },
          { id: "month", label: "Month" },
        ] as Array<{ id: RangeTab; label: string }>
      ).map((p) => {
        const active = tab === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => setTab(p.id)}
            className={`px-3 py-2 min-h-11 md:min-h-0 rounded-full text-[10px] font-display uppercase tracking-widest whitespace-nowrap border transition-colors ${
              active
                ? "bg-neon text-background border-neon"
                : "border-border text-muted-foreground hover:text-foreground hover:border-neon/40"
            }`}
          >
            {p.label}
          </button>
        );
      })}

      <span className="mx-1 h-5 w-px bg-border shrink-0" aria-hidden />

      {tab === "day" && (
        <>
          {(
            [
              { id: "today", label: "Today" },
              { id: "yesterday", label: "Yesterday" },
            ] as Array<{ id: DayPreset; label: string }>
          ).map((p) => {
            const active = dayPreset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setDayPreset(p.id)}
                className={`px-2.5 py-1.5 min-h-11 md:min-h-0 rounded-full text-[10px] font-display uppercase tracking-widest whitespace-nowrap border transition-colors ${
                  active
                    ? "bg-neon text-background border-neon"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-neon/40"
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </>
      )}

      {tab === "week" && (
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={() => week.shiftWeek(-1)}
            title="Previous week"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="px-3 py-1 rounded border border-neon/40 bg-neon/5 flex items-center gap-2 whitespace-nowrap">
            <CalendarRange className="w-4 h-4 text-neon shrink-0" />
            <span className="text-xs font-display">{range.label}</span>
          </div>
          <Button size="sm" variant="outline" onClick={() => week.shiftWeek(1)} title="Next week">
            <ChevronRight className="w-4 h-4" />
          </Button>
          {!week.isCurrentWeek && (
            <Button size="sm" variant="ghost" onClick={() => week.goToWeek()}>
              Jump to current week
            </Button>
          )}
        </>
      )}

      {tab === "month" && (
        <>
          <Button size="sm" variant="outline" onClick={() => shiftMonth(-1)} title="Previous month">
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="px-3 py-1 rounded border border-neon/40 bg-neon/5 flex items-center gap-2 whitespace-nowrap">
            <CalendarRange className="w-4 h-4 text-neon shrink-0" />
            <span className="text-xs font-display">{range.label}</span>
          </div>
          <Button size="sm" variant="outline" onClick={() => shiftMonth(1)} title="Next month">
            <ChevronRight className="w-4 h-4" />
          </Button>
          {!isCurrentMonth && (
            <Button size="sm" variant="ghost" onClick={goToCurrentMonth}>
              Jump to current month
            </Button>
          )}
        </>
      )}

      <span className="ml-2 text-[10px] text-muted-foreground font-mono whitespace-nowrap">
        {range.sub}
      </span>
    </div>
  );
}
