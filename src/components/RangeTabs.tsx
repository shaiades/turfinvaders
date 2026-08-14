import { Button } from "@/components/ui/button";
import { ArcadePill, RangeChip } from "@/components/arcade";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { DateRangeControls, DayPreset, RangeTab } from "@/hooks/useDateRange";

/** Day / Week / Month pill row — visual twin of the Fleet Dispatch range bar,
 *  driven by useDateRange so every screen pages dates identically. Pills and
 *  the range label render through the shared ArcadePill/RangeChip primitives
 *  (arcade.tsx) — Close Kombat's strip is the gold-toned twin. */
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
      ).map((p) => (
        <ArcadePill key={p.id} active={tab === p.id} onClick={() => setTab(p.id)}>
          {p.label}
        </ArcadePill>
      ))}

      <span className="mx-1 h-5 w-px bg-border shrink-0" aria-hidden />

      {tab === "day" && (
        <>
          {(
            [
              { id: "today", label: "Today" },
              { id: "yesterday", label: "Yesterday" },
            ] as Array<{ id: DayPreset; label: string }>
          ).map((p) => (
            <ArcadePill
              key={p.id}
              size="sm"
              active={dayPreset === p.id}
              onClick={() => setDayPreset(p.id)}
            >
              {p.label}
            </ArcadePill>
          ))}
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
          <RangeChip>{range.label}</RangeChip>
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
          <RangeChip>{range.label}</RangeChip>
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
