import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency } from "@/lib/utils";
import { addDaysISO, laWeekStartISO } from "@/lib/dates";
import { HOURLY_MID, HOURLY_TOP, POINTS_TIER_MID, POINTS_TIER_TOP } from "@/lib/pay";
import { ArcadePanel, NeonBar } from "@/components/arcade";
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
import {
  DollarSign,
  Filter,
  Gauge,
  Pencil,
  Target,
} from "lucide-react";

/**
 * The Mission page's Stats tab — the read-only SCOREBOARD (owner merge
 * 2026-09-12: everything live-today moved to the Today tab): THIS WEEK
 * (pace + paycheck engine) → MONTH TO DATE (revenue, sales, goal progress). Goal EDITING lives on the Plan tab;
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
  const { week, month } = stats;
  // Today lives on the Today tab now (owner merge, 2026-09-12) — this tab is
  // the pure scoreboard: the week you're being paid on, then the month.
  return (
    <div className="space-y-6">
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
        pending={stats.funnelRates.isLoading}
        points={stats.weekPoints}
        hours={stats.weekHours}
        hourlyRate={stats.hourlyRate}
        base={stats.weekBase}
        commission={stats.weekCommission}
        commissionPct={Math.round(stats.weekCommissionRate * 100)}
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
        profile={stats.profile}
        earningsLoading={stats.earnings.isLoading}
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

function PaycheckEngineWidget({
  pending,
  points,
  hours,
  hourlyRate,
  base,
  commission,
  commissionPct,
  revenue,
}: {
  /** The 60d-logs query behind `points` — the clocked-hours and sales-revenue
   *  legs expose neither pending nor error via stats (see useCanvasserStats),
   *  so a failed fetch on those still shows as zeros. */
  pending: boolean;
  points: number;
  hours: number;
  hourlyRate: number;
  base: number;
  commission: number;
  /** Rank-lock-aware rate from the stats hook — never recomputed here. */
  commissionPct: number;
  revenue: number;
}) {
  const atTop = hourlyRate >= HOURLY_TOP;
  const nextTarget = points >= POINTS_TIER_MID ? POINTS_TIER_TOP : POINTS_TIER_MID;
  const nextRate = points >= POINTS_TIER_MID ? HOURLY_TOP : HOURLY_MID;
  // Monotonic progress toward the top tier so the bar never shrinks as points grow.
  const pct = Math.min(1, points / POINTS_TIER_TOP);
  const accent = atTop ? "var(--victory)" : "var(--neon)";
  const action = (
    <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
      Auto · Weekly
    </span>
  );
  // Zero ≠ error: never flash the $18/hr floor and 0 pts while the week is
  // still loading.
  if (pending) {
    return (
      <ArcadePanel title="Paycheck Engine" action={action}>
        <QueryStateCard pending what="this week's paycheck" />
      </ArcadePanel>
    );
  }
  return (
    <ArcadePanel title="Paycheck Engine" action={action}>
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
            from time clock · punched lunches deducted
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

function GoalBar({
  earned,
  goal,
  pct,
  onEditGoal,
  profile,
  earningsLoading,
}: {
  earned: number;
  goal: number;
  pct: number;
  onEditGoal: () => void;
  /** The profiles query behind `goal` — a failed fetch must not pass the
   *  $10k default off as the canvasser's real goal. */
  profile: CanvasserStatsData["profile"];
  /** The pay-engine RPCs behind `earned` (useMyEarnings exposes loading
   *  only — a failed RPC still reads $0 earned). */
  earningsLoading: boolean;
}) {
  const pending = profile.isPending || earningsLoading;
  return (
    <ArcadePanel
      title="Monthly Goal"
      action={
        <Button variant="ghost" onClick={onEditGoal}>
          <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit in Plan
        </Button>
      }
    >
      {pending || profile.isError ? (
        <QueryStateCard
          pending={pending}
          what="your monthly goal"
          onRetry={() => profile.refetch()}
        />
      ) : (
        <>
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
        </>
      )}
    </ArcadePanel>
  );
}
