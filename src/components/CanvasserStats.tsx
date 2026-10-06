import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { addDaysISO, laWeekStartISO } from "@/lib/dates";
import { ArcadePanel } from "@/components/arcade";
import { type PinType } from "@/lib/pin-results";
import {
  countPins,
  DoorResultsGrid,
  FunnelStageBars,
  funnelStages,
} from "@/components/ConversionPanels";
import { LiveLeadCounter } from "@/components/LiveLeadCounter";
import { QueryStateCard } from "@/components/QueryStateCard";
import { Button } from "@/components/ui/button";
import type { CanvasserStatsData } from "@/hooks/useCanvasserStats";
import { Filter, Gauge } from "lucide-react";

/**
 * The Mission page's Stats tab — the pure ANALYTICS scoreboard (consolidation
 * 2026-10-05): the week's Conversion Funnel, what happened At the Door, and
 * Leads Per Day. Everything "game" or money moved to its one home — pay to the
 * Paycheck card, the $100K boss to Leaders, XP/level/badges to the Fighter card
 * — so this tab is just the numbers a grinder studies to improve, nothing
 * duplicated. Goal EDITING lives on the Plan tab; the funnel panel links there.
 */
export function CanvasserStats({
  stats,
  userId,
  onEditGoal,
}: {
  stats: CanvasserStatsData;
  userId: string;
  onEditGoal: () => void;
}) {
  const { week } = stats;
  return (
    <div className="space-y-6">
      <ConversionFunnelPanel stats={stats} onOpenPlan={onEditGoal} />
      <DoorResultsPanel userId={userId} />
      <BigStat
        label="Leads Per Day"
        value={stats.lpd.toFixed(1)}
        sub={`${week.confirmed_leads} confirmed · ${week.days_worked} days worked`}
        icon={<Gauge className="w-4 h-4" />}
        accent="var(--neon)"
      />
    </div>
  );
}

export function GrindCounter({
  label,
  counterLabel,
  value,
  icon,
  accent,
  size = "lg",
}: {
  label: string;
  /** The inner ticker's own metric name — LiveLeadCounter's default label is
   *  leads-specific and reads wrong on every other counter. */
  counterLabel: string;
  value: number;
  icon: React.ReactNode;
  accent: string;
  /** "md" fits a 2-up phone grid (Today tab); "lg" is the full-width ticker. */
  size?: "md" | "lg";
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-lg border ${size === "md" ? "p-3.5" : "p-5"}`}
      style={{
        borderColor: `color-mix(in oklab, ${accent} 35%, var(--border))`,
        background: `color-mix(in oklab, ${accent} 5%, var(--surface))`,
      }}
    >
      <div className="absolute inset-0 pointer-events-none scanlines opacity-30" />
      <div className="relative">
        <div
          className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest"
          style={{ color: accent }}
        >
          {icon} {label}
        </div>
        <div className="mt-3 flex items-end gap-2">
          <LiveLeadCounter value={value} size={size} label={counterLabel} />
        </div>
        <div className="mt-2 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          TODAY · LIVE
        </div>
      </div>
    </div>
  );
}

function BigStat({
  label,
  value,
  sub,
  icon,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  accent: string;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-lg border p-5"
      style={{
        borderColor: `color-mix(in oklab, ${accent} 30%, var(--border))`,
        background: `color-mix(in oklab, ${accent} 5%, var(--surface))`,
      }}
    >
      <div className="absolute inset-0 pointer-events-none scanlines opacity-25" />
      <div className="relative">
        <div
          className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest"
          style={{ color: accent }}
        >
          {icon} {label}
        </div>
        <div
          className="mt-3 font-display text-4xl md:text-5xl leading-none"
          style={{
            color: accent,
            textShadow: `0 0 18px color-mix(in oklab, ${accent} 55%, transparent)`,
          }}
        >
          {value}
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">{sub}</div>
      </div>
    </div>
  );
}

/** Realized funnel this week: what actually happened, stage by stage, with
 *  step conversion — the Plan tab's back-solve is the forward mirror of this.
 *  Stages are independent daily_logs counters (sits often land in a later
 *  week than their lead), so step ratios are capped at "100%+". */
function ConversionFunnelPanel({
  stats,
  onOpenPlan,
}: {
  stats: CanvasserStatsData;
  onOpenPlan: () => void;
}) {
  const w = stats.week;
  const stages = funnelStages({
    doors: w.doors_knocked,
    talks: w.people_talked_to,
    leads: w.confirmed_leads,
    sits: w.demos_sits,
    sales: w.sales,
  });
  const allZero = stages.every((s) => s.value === 0);
  const rateNote =
    stats.funnelRates.source === "personal"
      ? `Personal rates · ${stats.funnelRates.sampleDoors.toLocaleString()} tracked doors`
      : "Company baseline rates (knock more doors to earn your own)";

  return (
    <ArcadePanel
      title="Conversion Funnel"
      action={
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Mon–Sat · Live
        </span>
      }
    >
      {stats.funnelRates.isLoading ? (
        // funnelRates.isLoading carries the same 60d-logs query that produces
        // stats.week — the only pending signal the stats prop exposes here. A
        // FAILED logs fetch still reads all-zero (no error flag reaches this
        // file; see useCanvasserStats).
        <QueryStateCard pending what="this week's funnel" />
      ) : (
        <>
          {allZero ? (
            <div className="text-sm text-muted-foreground">
              No funnel activity this week yet — Not-Home pins (NH) log doors; talks, confirmed
              leads, sits and sales fill in as they land.
            </div>
          ) : (
            <FunnelStageBars stages={stages} />
          )}
          <div className="mt-4 flex items-center justify-between gap-3 flex-wrap border-t border-border pt-3">
            <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              <Filter className="inline w-3 h-3 mr-1" />
              {rateNote}
            </span>
            <Button variant="ghost" onClick={onOpenPlan}>
              Reverse-engineer my goal →
            </Button>
          </div>
        </>
      )}
    </ArcadePanel>
  );
}

function DoorResultsPanel({ userId }: { userId: string }) {
  // Mon–Sat pay week, matching the funnel above and calc_weekly_paycheck.
  const weekStart = laWeekStartISO();
  const pinsQuery = useQuery({
    enabled: !!userId,
    queryKey: ["my_pins_week", userId, weekStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("field_pins")
        .select("pin_type, is_remote_drop")
        .eq("canvasser_id", userId)
        .gte("log_date", weekStart)
        .lte("log_date", addDaysISO(weekStart, 5));
      if (error) throw error;
      return (data ?? []) as Array<{ pin_type: PinType; is_remote_drop: boolean | null }>;
    },
  });

  const pins = pinsQuery.data ?? [];
  const { total } = countPins(pins);

  return (
    <ArcadePanel
      title="At the Door · This Week"
      action={
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          {total.toLocaleString()} pins
        </span>
      }
    >
      {pinsQuery.isPending ? (
        <div className="text-sm text-muted-foreground">Loading this week's pins…</div>
      ) : pinsQuery.isError ? (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className="text-sm text-muted-foreground">Couldn't load this week's pins.</span>
          <Button variant="outline" onClick={() => pinsQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <DoorResultsGrid pins={pins} />
      )}
    </ArcadePanel>
  );
}
