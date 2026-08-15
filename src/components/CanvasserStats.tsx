import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency } from "@/lib/utils";
import { addDaysISO, laWeekStartISO } from "@/lib/dates";
import {
  HOURLY_MID,
  HOURLY_TOP,
  POINTS_TIER_MID,
  POINTS_TIER_TOP,
  commissionRateForPoints,
} from "@/lib/pay";
import { ArcadePanel, NeonBar } from "@/components/arcade";
import { type PinType } from "@/lib/pin-results";
import {
  countPins,
  DoorResultsGrid,
  FunnelStageBars,
  funnelStages,
} from "@/components/ConversionPanels";
import { LiveLeadCounter } from "@/components/LiveLeadCounter";
import { Button } from "@/components/ui/button";
import type { CanvasserStatsData } from "@/hooks/useCanvasserStats";
import {
  CalendarClock,
  CalendarDays,
  DollarSign,
  DoorOpen,
  Filter,
  Gauge,
  Pencil,
  PhoneCall,
  Target,
} from "lucide-react";

/**
 * The Mission page's Stats tab — read-only review, stacked in day order:
 * TODAY (live counters) → THIS WEEK (pace + paycheck engine) → MONTH TO
 * DATE (revenue, sales, goal progress). Goal EDITING lives on the Plan tab;
 * the goal bar here links there. Weekly pay itself isn't repeated — the
 * Take-Home widget in the page header owns that number.
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
  const { today, week, month } = stats;
  return (
    <div className="space-y-6">
      <SectionLabel>Today</SectionLabel>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <GrindCounter
          label="Doors Knocked"
          counterLabel="DOORS · TODAY"
          value={today.doors_knocked}
          icon={<DoorOpen className="w-4 h-4" />}
          accent="#ff2d55"
        />
        <GrindCounter
          label="Leads Called In"
          value={today.leads_called_in}
          icon={<PhoneCall className="w-4 h-4" />}
          accent="var(--neon)"
        />
        <GrindCounter
          label="Confirmed Next Day Leads"
          value={today.next_days}
          icon={<CalendarClock className="w-4 h-4" />}
          accent="var(--victory)"
        />
        <GrindCounter
          label="Confirmed Future Leads"
          value={today.future_leads}
          icon={<CalendarDays className="w-4 h-4" />}
          accent="var(--accent)"
        />
      </div>

      <SectionLabel>This Week</SectionLabel>
      <ConversionFunnelPanel stats={stats} onOpenPlan={onEditGoal} />
      <DoorResultsPanel userId={userId} />
      <BigStat
        label="Leads Per Day"
        value={stats.lpd.toFixed(1)}
        sub={`${week.confirmed_leads} confirmed · ${week.days_worked} days worked`}
        icon={<Gauge className="w-4 h-4" />}
        accent="var(--neon)"
      />
      <PaycheckEngineWidget
        points={stats.weekPoints}
        hours={stats.weekHours}
        hourlyRate={stats.hourlyRate}
        base={stats.weekBase}
        commission={stats.weekCommission}
        revenue={stats.weekRevenue}
      />

      <SectionLabel>Month to Date</SectionLabel>
      <div className="grid sm:grid-cols-2 gap-4">
        <BigStat
          label="Monthly Revenue Generated"
          value={formatCurrency(stats.monthRevenue)}
          sub={
            stats.valuePerDoor > 0
              ? `Confirmed sales · MTD · every knock paid ${formatCurrency(stats.valuePerDoor)}`
              : "Confirmed sales · MTD"
          }
          icon={<DollarSign className="w-4 h-4" />}
          accent="var(--victory)"
        />
        <BigStat
          label="Total Sales"
          value={month.sales.toLocaleString()}
          sub={`${month.confirmed_leads} confirmed leads · MTD`}
          icon={<Target className="w-4 h-4" />}
          accent="var(--accent)"
        />
      </div>
      <GoalBar
        earned={stats.earnings.monthEarned}
        goal={stats.monthlyGoal}
        pct={stats.goalProgress}
        onEditGoal={onEditGoal}
      />
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-display uppercase tracking-[0.25em] text-muted-foreground border-b border-border/60 pb-1.5">
      {children}
    </div>
  );
}

function GrindCounter({
  label,
  counterLabel,
  value,
  icon,
  accent,
}: {
  label: string;
  counterLabel?: string;
  value: number;
  icon: React.ReactNode;
  accent: string;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-lg border p-5"
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
          <LiveLeadCounter value={value} size="lg" {...(counterLabel ? { label: counterLabel } : {})} />
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

function PaycheckEngineWidget({
  points,
  hours,
  hourlyRate,
  base,
  commission,
  revenue,
}: {
  points: number;
  hours: number;
  hourlyRate: number;
  base: number;
  commission: number;
  revenue: number;
}) {
  const atTop = hourlyRate >= HOURLY_TOP;
  const nextTarget = points >= POINTS_TIER_MID ? POINTS_TIER_TOP : POINTS_TIER_MID;
  const nextRate = points >= POINTS_TIER_MID ? HOURLY_TOP : HOURLY_MID;
  // Monotonic progress toward the top tier so the bar never shrinks as points grow.
  const pct = Math.min(1, points / POINTS_TIER_TOP);
  const commissionPct = Math.round(commissionRateForPoints(points) * 100);
  const accent = atTop ? "var(--victory)" : "var(--neon)";
  return (
    <ArcadePanel
      title="Paycheck Engine"
      action={
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Auto · Weekly
        </span>
      }
    >
      <div className="grid sm:grid-cols-3 gap-4">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Hourly Tier
          </div>
          <div
            className="font-display text-3xl mt-1"
            style={{
              color: accent,
              textShadow: `0 0 14px color-mix(in oklab, ${accent} 60%, transparent)`,
            }}
          >
            ${hourlyRate}/hr
          </div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">
            {atTop
              ? `🔥 $${HOURLY_TOP} tier unlocked`
              : `${Math.max(0, nextTarget - points)} pt(s) to $${nextRate}/hr`}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Clocked Hours
          </div>
          <div className="font-display text-3xl text-neon mt-1">{hours.toFixed(1)}</div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">
            from time clock · lunch deducted
          </div>
        </div>
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Sits / Points
          </div>
          <div className="font-display text-3xl text-accent mt-1">{points}</div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">
            Sit = 1 · Sale = 2
          </div>
        </div>
      </div>
      <NeonBar pct={pct} accent={accent} />
      <div className="mt-3 grid sm:grid-cols-3 gap-2 text-[11px] text-muted-foreground border-t border-border pt-3">
        <div>
          Base · <span className="text-foreground">{formatCurrency(base)}</span>
        </div>
        <div>
          Commission ({commissionPct}% of {formatCurrency(revenue)}) ·{" "}
          <span className="text-victory">{formatCurrency(commission)}</span>
        </div>
        <div className="sm:text-right">
          Total ·{" "}
          <span className="font-display text-victory">{formatCurrency(base + commission)}</span>
        </div>
      </div>
    </ArcadePanel>
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
      ? `Personal rates · ${stats.funnelRates.sampleDoors.toLocaleString()} doors / 60d`
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
      {allZero ? (
        <div className="text-sm text-muted-foreground">
          No funnel activity this week yet — NH pins log doors; talks, confirmed leads, sits and
          sales fill in as they land.
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

function GoalBar({
  earned,
  goal,
  pct,
  onEditGoal,
}: {
  earned: number;
  goal: number;
  pct: number;
  onEditGoal: () => void;
}) {
  return (
    <ArcadePanel
      title="Monthly Goal"
      action={
        <Button variant="ghost" onClick={onEditGoal}>
          <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit in Plan
        </Button>
      }
    >
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Earned MTD · All Pay Combined
          </div>
          <div className="font-display text-4xl md:text-5xl text-mega-victory leading-none mt-1">
            {formatCurrency(earned)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Goal
          </div>
          <div className="font-display text-2xl text-neon">{formatCurrency(goal)}</div>
        </div>
      </div>
      <NeonBar pct={pct} accent="var(--victory)" tall />
      <div className="mt-2 flex justify-between text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        <span>{(pct * 100).toFixed(0)}% complete</span>
        <span>
          {pct >= 1 ? "🏆 Goal smashed" : `${formatCurrency(Math.max(0, goal - earned))} to go`}
        </span>
      </div>
    </ArcadePanel>
  );
}
