// God Mode calendar heatmap (owner asked for heat maps, 2026-10-01):
// GitHub-style month grid, Monday-start, one cell per day, quantile color
// ramp (robust to one monster day), tap-a-day readout. Pure CSS divs.

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { heatStep } from "@/lib/collections";

export type HeatDay = {
  iso: string;
  value: number;
  /** Rendered dimmed-dash: data not tracked for this day (doors pre-9/10). */
  untracked?: boolean;
  /** Faint cyan ring: money is scheduled to land this day. */
  dueHint?: boolean;
};

const STEP_MIX = [0, 25, 45, 70, 100] as const;

export function CalendarHeatmap({
  days,
  accent,
  todayISO,
  renderReadout,
  onPick,
  pickedISO,
}: {
  days: HeatDay[];
  /** CSS color the ramp mixes toward (victory / kombat-gold / turf-cyan). */
  accent: string;
  todayISO: string;
  renderReadout: (day: HeatDay | null) => React.ReactNode;
  onPick?: (day: HeatDay | null) => void;
  pickedISO?: string | null;
}) {
  const [localPick, setLocalPick] = useState<string | null>(null);
  const picked = pickedISO !== undefined ? pickedISO : localPick;

  const { cells, sortedNonZero } = useMemo(() => {
    const nz = days
      .filter((d) => !d.untracked && d.value > 0)
      .map((d) => d.value)
      .sort((a, b) => a - b);
    // Monday-start leading blanks.
    const first = days[0];
    const lead = first ? (new Date(`${first.iso}T12:00:00Z`).getUTCDay() + 6) % 7 : 0;
    return { cells: [...Array.from({ length: lead }, () => null), ...days], sortedNonZero: nz };
  }, [days]);

  const pick = (d: HeatDay | null) => {
    const next = d && d.iso === picked ? null : d;
    if (pickedISO === undefined) setLocalPick(next?.iso ?? null);
    onPick?.(next);
  };

  const pickedDay = days.find((d) => d.iso === picked) ?? null;

  return (
    <div className="min-w-0 space-y-2">
      <div className="grid grid-cols-7 gap-1 text-center text-[9px] font-display uppercase text-muted-foreground">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <div key={i}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (d === null) return <div key={`b${i}`} />;
          const step = d.untracked ? 0 : heatStep(d.value, sortedNonZero);
          const isPicked = picked === d.iso;
          return (
            <button
              key={d.iso}
              type="button"
              onClick={() => pick(d)}
              aria-label={`${d.iso}: ${d.untracked ? "not tracked" : d.value}`}
              className={cn(
                "relative aspect-square min-w-0 rounded-[4px] text-[10px] tabular-nums transition-colors",
                step >= 3 ? "text-background font-medium" : "text-muted-foreground",
                d.iso === todayISO && "ring-1 ring-neon",
                isPicked && "ring-2 ring-neon",
                d.dueHint &&
                  step === 0 &&
                  "border border-[color-mix(in_oklab,var(--turf-cyan)_40%,transparent)]",
              )}
              style={{
                background:
                  step === 0
                    ? "var(--surface-elevated)"
                    : `color-mix(in oklab, ${accent} ${STEP_MIX[step]}%, var(--surface-elevated))`,
              }}
            >
              {d.untracked ? "–" : Number(d.iso.slice(8, 10))}
            </button>
          );
        })}
      </div>
      <div className="min-h-5 text-[11px] text-muted-foreground tabular-nums">
        {renderReadout(pickedDay)}
      </div>
    </div>
  );
}
