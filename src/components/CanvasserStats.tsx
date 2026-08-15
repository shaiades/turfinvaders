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
import { PIN_COLORS, type PinType } from "@/lib/pin-results";
import { LiveLeadCounter } from "@/components/LiveLeadCounter";
import { Button } from "@/components/ui/button";
import type { CanvasserStatsData } from "@/hooks/useCanvasserStats";
import {
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  DollarSign,
  DoorOpen,
  Filter,
  Gauge,
  Home,
  KeyRound,
  MessageSquare,
  Pencil,
  PhoneCall,
  Sparkles,
  Target,
  ThumbsDown,
  Undo2,
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
  const stages = [
    { label: "Doors", value: w.doors_knocked, color: "#ff2d55" },
    { label: "Talks", value: w.people_talked_to, color: "#ffd60a" },
    { label: "Leads", value: w.confirmed_leads, color: "#39ff14" },
    { label: "Sits", value: w.demos_sits, color: "#00e5ff" },
    { label: "Sales", value: w.sales, color: "#c77dff" },
  ];
  const allZero = stages.every((s) => s.value === 0);
  const max = Math.max(1, ...stages.map((s) => s.value));
  const pct = (n: number, of: number) => {
    if (of <= 0) return "—";
    const r = Math.round((n / of) * 100);
    return r > 100 ? "100%+" : `${r}%`;
  };
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
        <div className="space-y-2.5">
          {stages.map((s, i) => {
            const prev = i > 0 ? stages[i - 1].value : null;
            return (
              <div key={s.label} className="flex items-center gap-2 min-w-0">
                <div className="w-16 shrink-0 text-[10px] font-display uppercase tracking-widest text-muted-foreground truncate">
                  {s.label}
                </div>
                <div className="flex-1 min-w-0 h-4 rounded bg-background/60 overflow-hidden">
                  <div
                    className="h-full rounded"
                    style={{
                      width: `${Math.min(100, Math.max(s.value > 0 ? 2 : 0, (s.value / max) * 100))}%`,
                      background: s.color,
                      boxShadow: `0 0 10px color-mix(in srgb, ${s.color} 60%, transparent)`,
                    }}
                  />
                </div>
                <div className="w-10 shrink-0 text-right font-display text-sm" style={{ color: s.color }}>
                  {s.value.toLocaleString()}
                </div>
                <div className="w-14 shrink-0 text-right text-[10px] uppercase tracking-widest text-muted-foreground">
                  {prev == null ? "" : pct(s.value, prev)}
                </div>
              </div>
            );
          })}
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground pt-1">
            Leads = confirmed · Sits &amp; Sales sync from Monday
          </div>
        </div>
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

// What happened at the doors this week, result by result (remote drops
// excluded from counts — they never bump stats). Labels match the picker
// abbreviations so they fit 375px cards; legacy pin types only render when
// they actually occur in the window.
const RESULT_ORDER: Array<{ type: PinType; label: string; icon: React.ReactNode; alwaysShow: boolean }> = [
  { type: "lead", label: "Lead", icon: <Sparkles className="w-3.5 h-3.5" />, alwaysShow: true },
  { type: "not_home", label: "NH", icon: <Home className="w-3.5 h-3.5" />, alwaysShow: true },
  { type: "go_back", label: "GB", icon: <Undo2 className="w-3.5 h-3.5" />, alwaysShow: true },
  { type: "renter", label: "Renter", icon: <KeyRound className="w-3.5 h-3.5" />, alwaysShow: true },
  { type: "not_interested", label: "NI", icon: <ThumbsDown className="w-3.5 h-3.5" />, alwaysShow: true },
  { type: "appt", label: "Appt", icon: <CalendarCheck className="w-3.5 h-3.5" />, alwaysShow: true },
  { type: "talked_to", label: "Talked", icon: <MessageSquare className="w-3.5 h-3.5" />, alwaysShow: false },
  { type: "knock", label: "Knock", icon: <DoorOpen className="w-3.5 h-3.5" />, alwaysShow: false },
];

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
  const counted = pins.filter((p) => !p.is_remote_drop);
  const remote = pins.length - counted.length;
  const byType = counted.reduce<Partial<Record<PinType, number>>>((a, p) => {
    a[p.pin_type] = (a[p.pin_type] ?? 0) + 1;
    return a;
  }, {});
  const total = counted.length;

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
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {RESULT_ORDER.filter((r) => r.alwaysShow || (byType[r.type] ?? 0) > 0).map((r) => {
          const n = byType[r.type] ?? 0;
          const color = PIN_COLORS[r.type];
          return (
            <div
              key={r.type}
              className="rounded-lg border p-3 min-w-0"
              style={{
                borderColor: `color-mix(in oklab, ${color} 30%, var(--border))`,
                background: `color-mix(in oklab, ${color} 5%, var(--surface))`,
              }}
            >
              <div
                className="flex items-center gap-1.5 text-[9px] font-display uppercase tracking-widest truncate"
                style={{ color }}
              >
                {r.icon} <span className="truncate">{r.label}</span>
              </div>
              <div className="mt-2 flex items-end justify-between gap-2">
                <span
                  className="font-display text-2xl leading-none"
                  style={{ color, textShadow: `0 0 12px color-mix(in srgb, ${color} 55%, transparent)` }}
                >
                  {n}
                </span>
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                  {total > 0 ? `${Math.round((n / total) * 100)}%` : "0%"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      )}
      <div className="mt-3 text-[10px] uppercase tracking-widest text-muted-foreground">
        Appt pins mark the house — appointments &amp; sales are counted from Monday.
        {remote > 0 ? ` · ${remote} remote drop(s) excluded` : ""}
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
