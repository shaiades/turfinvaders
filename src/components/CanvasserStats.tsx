import { formatCurrency } from "@/lib/utils";
import {
  HOURLY_MID,
  HOURLY_TOP,
  POINTS_TIER_MID,
  POINTS_TIER_TOP,
  commissionRateForPoints,
} from "@/lib/pay";
import { ArcadePanel, NeonBar } from "@/components/arcade";
import { LiveLeadCounter } from "@/components/LiveLeadCounter";
import { Button } from "@/components/ui/button";
import type { CanvasserStatsData } from "@/hooks/useCanvasserStats";
import {
  CalendarClock,
  CalendarDays,
  DollarSign,
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
  onEditGoal,
}: {
  stats: CanvasserStatsData;
  onEditGoal: () => void;
}) {
  const { today, week, month } = stats;
  return (
    <div className="space-y-6">
      <SectionLabel>Today</SectionLabel>
      <div className="grid sm:grid-cols-3 gap-4">
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
          sub="Confirmed sales · MTD"
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
  value,
  icon,
  accent,
}: {
  label: string;
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
          <LiveLeadCounter value={value} size="lg" />
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
