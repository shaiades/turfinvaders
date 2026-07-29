import { useMemo, useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency } from "@/lib/utils";
import { ArcadePanel } from "@/components/arcade";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { LiveLeadCounter } from "@/components/LiveLeadCounter";
import { WeeklyPlaybook } from "@/components/WeeklyPlaybook";
import { TimeClock } from "@/components/TimeClock";
import { RankPill, RANK_PERKS } from "@/components/RankPill";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { DoorOpen, CalendarClock, CalendarDays, PhoneCall, DollarSign, Target, Gauge, Trophy, Sparkles, Pencil, Check, X, Crosshair, Zap, Users, Swords, Flame } from "lucide-react";
import {
  payRateForPoints,
  commissionRateForPoints,
  COMMISSION_BASE,
  POINTS_TIER_MID,
  POINTS_TIER_TOP,
  HOURLY_MID,
  HOURLY_TOP,
  VOLUME_BONUS_STEP,
  PAY_LOCK_MIN_ROLLING_AVG,
  weeklyPoints,
} from "@/lib/pay";
import { getMonthlyPaychecks } from "@/lib/fleet.functions";
import { laTodayISO, laWeekStartISO, addDaysISO, laMidnightUtcISO, laMonthStartISO, remainingWorkdaysInMonth } from "@/lib/dates";
import { backSolveFunnel, commissionGap } from "@/lib/funnel";
import { useFunnelRates, useProfileGoals } from "@/hooks/useFunnelRates";
import { useMyEarnings } from "@/hooks/useMyEarnings";

/**
 * Paycheck engine — automated.
 *
 * Hours: real clocked time only (time_entries; 30-min lunch deducted per
 *   shift, no daily caps, Sundays unpaid). No clock-in = no base pay.
 *
 * Weekly Points (Sits): pitch-miss sit = 1 pt, sale = 2 pts.
 *   → weekPoints = demos_sits + sales
 *
 * Hourly threshold (end-of-week rule, from @/lib/pay which mirrors calc_weekly_paycheck):
 *   < 3 pts  → $18/hr + 1% commission
 *   ≥ 3 pts  → $30/hr + 1% commission
 *   ≥ 7 pts  → $35/hr + 2% commission
 */

/** Fallback monthly financial goal default (USD) until canvasser sets their own. */
const DEFAULT_MONTHLY_GOAL = 10_000;

/** Rank ladder — order matters. */
const RANKS = [
  { key: "rookie",   label: "Rookie",      minSales: 0 },
  { key: "bronze",   label: "Bronze",      minSales: 5 },
  { key: "silver",   label: "Silver",      minSales: 15 },
  { key: "jr_gold",  label: "Jr. Gold",    minSales: 30 },
  { key: "sr_gold",  label: "Sr. Gold",    minSales: 50 },
  { key: "platinum", label: "Platinum",    minSales: 80 },
  { key: "diamond",  label: "Diamond",     minSales: 120 },
] as const;

// All day/week/month buckets are America/Los_Angeles (midnight PT resets).

type Totals = {
  doors_knocked: number;
  people_talked_to: number;
  leads_called_in: number;
  confirmed_leads: number;
  next_days: number;
  future_leads: number;
  demos_sits: number;
  sales: number;
  no_shows: number;
  days_worked: number;
};
const ZERO: Totals = {
  doors_knocked: 0, people_talked_to: 0, leads_called_in: 0,
  confirmed_leads: 0, next_days: 0, future_leads: 0,
  demos_sits: 0, sales: 0, no_shows: 0, days_worked: 0,
};

function aggregate(rows: Array<Record<string, number | null> & { log_date: string }>): Totals {
  const t = { ...ZERO };
  const days = new Set<string>();
  for (const r of rows) {
    t.doors_knocked    += r.doors_knocked    ?? 0;
    t.people_talked_to += r.people_talked_to ?? 0;
    t.leads_called_in  += r.leads_called_in  ?? 0;
    t.confirmed_leads  += r.confirmed_leads  ?? 0;
    t.next_days        += r.next_days        ?? 0;
    t.future_leads     += r.future_leads     ?? 0;
    t.demos_sits       += r.demos_sits       ?? 0;
    t.sales            += r.sales            ?? 0;
    t.no_shows         += r.no_shows         ?? 0;
    const hadActivity = (r.doors_knocked ?? 0) + (r.leads_called_in ?? 0) + (r.confirmed_leads ?? 0) > 0;
    if (hadActivity && typeof r.log_date === "string") days.add(r.log_date);
  }
  t.days_worked = days.size;
  return t;
}

export function CanvasserPersonalDashboard({ userId }: { userId: string }) {
  const qc = useQueryClient();

  const goalsQuery = useProfileGoals(userId);
  const funnelRates = useFunnelRates(userId);
  const earnings = useMyEarnings(userId);
  const monthlyGoal = Number(goalsQuery.data?.monthly_goal ?? DEFAULT_MONTHLY_GOAL);
  // Income semantics (owner, 2026-07-29): required sales = goal ÷ avg
  // commission per sale — the same editable number the Weekly Playbook uses,
  // falling back to the company 60d average for a missing profile row.
  const avgCommission =
    Number(goalsQuery.data?.avg_commission ?? 0) || funnelRates.companyAvgCommission;

  // Personal logs — last 60 days for both MTD math and historical conversion rates.
  const logsQuery = useQuery({
    queryKey: ["my_logs", "60d", userId],
    queryFn: async () => {
      const since = addDaysISO(laTodayISO(), -60);
      const { data, error } = await supabase
        .from("daily_logs")
        .select("log_date, doors_knocked, people_talked_to, leads_called_in, confirmed_leads, next_days, future_leads, demos_sits, sales, no_shows")
        .eq("canvasser_id", userId)
        .gte("log_date", since);
      if (error) throw error;
      return data ?? [];
    },
  });

  const salesQuery = useQuery({
    queryKey: ["my_confirmed_sales", "mtd", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leads")
        .select("sale_amount, created_at")
        .eq("canvasser_id", userId)
        .eq("status", "confirmed")
        .eq("is_sale", true)
        .gte("created_at", laMidnightUtcISO(laMonthStartISO()));
      if (error) throw error;
      return data ?? [];
    },
  });

  // Real clocked hours this week — base pay comes only from clocked time
  // (no activity-based estimates; no clock-in means no base pay).
  const clockedQuery = useQuery({
    queryKey: ["my_clocked_hours", "week", userId],
    queryFn: async () => {
      // Mon–Sat window, matching calc_weekly_paycheck exactly.
      const weekStart = laWeekStartISO();
      const { data, error } = await supabase
        .from("time_entries")
        .select("billable_hours")
        .eq("user_id", userId)
        .gte("log_date", weekStart)
        .lte("log_date", addDaysISO(weekStart, 5))
        .not("clock_out", "is", null);
      if (error) throw error;
      return (data ?? []).reduce((a, r) => a + Number(r.billable_hours ?? 0), 0);
    },
  });

  const { today, week, month, monthRevenue, weekRevenue, weekPoints,
          weekHours, hourlyRate, weekBase, weekCommission, monthCommission, funnel } = useMemo(() => {
    const allRows = (logsQuery.data ?? []) as unknown as Array<Record<string, number | null> & { log_date: string }>;
    const t = laTodayISO(), w = laWeekStartISO(), m = laMonthStartISO();
    const mtdRows = allRows.filter((r) => r.log_date >= m);
    const today = aggregate(allRows.filter((r) => r.log_date === t));
    const week  = aggregate(allRows.filter((r) => r.log_date >= w));
    const month = aggregate(mtdRows);

    const sales = salesQuery.data ?? [];
    const monthRevenue = sales.reduce((a, r) => a + Number(r.sale_amount ?? 0), 0);
    const wStartMs = Date.parse(laMidnightUtcISO(w));
    const weekRevenue = sales
      .filter((r) => Date.parse(r.created_at) >= wStartMs)
      .reduce((a, r) => a + Number(r.sale_amount ?? 0), 0);

    const weekPoints = weeklyPoints(week.demos_sits, week.sales);
    const weekHours = clockedQuery.data ?? 0;
    const hourlyRate = payRateForPoints(weekPoints);
    const weekBase = weekHours * hourlyRate;
    const weekCommission = weekRevenue * commissionRateForPoints(weekPoints);
    // Month-level projection uses the base rate — the real per-week rate comes from the RPC.
    const monthCommission = monthRevenue * COMMISSION_BASE;

    // ===== Funnel math (reverse engineering) =====
    // Conversion rates come from the SHARED engine (useFunnelRates) so this
    // Mission and the WeeklyPlaybook below can never disagree. Only the
    // talk-per-door extra stays local (dashboard-only tile).
    const personalAgg = aggregate(allRows);
    const talkDoorRate =
      funnelRates.source === "personal" && personalAgg.doors_knocked > 0
        ? personalAgg.people_talked_to / personalAgg.doors_knocked
        : 0.27; // industry-typical fallback ~27%

    const funnel = {
      source: funnelRates.source,
      sampleDoors: funnelRates.sampleDoors,
      rates: funnelRates.rates,
      talkDoorRate,
    };

    return {
      today, week, month, monthRevenue, weekRevenue, weekPoints,
      weekHours, hourlyRate, weekBase, weekCommission, monthCommission, funnel,
    };
  }, [logsQuery.data, salesQuery.data, clockedQuery.data, funnelRates.source, funnelRates.sampleDoors, funnelRates.rates]);

  // Pay-engine truth (base + commission + sit/monster bonuses, rank locks
  // honored); the client estimate only bridges the loading gap.
  const weeklyPay = earnings.weekPaycheck?.total_pay ?? weekBase + weekCommission;

  const valuePerDoor = month.doors_knocked > 0 ? monthCommission / month.doors_knocked : 0;
  const lpd = week.days_worked > 0 ? week.confirmed_leads / week.days_worked : 0;

  // Rank progression based on month-to-date sales
  const currentIdx = (() => {
    let i = 0;
    for (let k = 0; k < RANKS.length; k++) if (month.sales >= RANKS[k].minSales) i = k;
    return i;
  })();
  const current = RANKS[currentIdx];
  const next = RANKS[Math.min(currentIdx + 1, RANKS.length - 1)];
  const rankSpan = Math.max(1, next.minSales - current.minSales);
  const rankProgress = current === next ? 1 : Math.min(1, (month.sales - current.minSales) / rankSpan);
  const goalProgress = monthlyGoal > 0 ? Math.min(1, earnings.monthEarned / monthlyGoal) : 0;

  // ===== Level-Up Detection → Hype Feed =====
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const { data: prof } = await supabase
        .from("profiles")
        .select("current_rank, display_name")
        .eq("id", userId)
        .maybeSingle();
      if (cancelled) return;
      const stored = (prof as { current_rank?: string | null } | null)?.current_rank ?? null;
      const name = (prof as { display_name?: string | null } | null)?.display_name ?? "A canvasser";
      const newRank = current.key;
      // Skip first-ever stamp (no level-up alert when seeding).
      if (stored === newRank) return;
      // SCCE Rank Engine owns profiles.current_rank server-side — do not overwrite from legacy ladder.
      if (stored && stored !== newRank) {
        await supabase.from("hype_events").insert({
          kind: "level_up",
          canvasser_id: userId,
          canvasser_name: name,
          message: `${name} just Leveled Up to ${current.label}!`,
          payload: { from: stored, to: newRank },
        });
      }
    })();
    return () => { cancelled = true; };
  }, [userId, current.key, current.label]);

  const [tab, setTab] = useState<"today" | "week" | "mtd" | "goals">("today");

  // ===== Reverse-engineering funnel (drives My Goals tab & Value Per Door) =====
  const mission = useMemo(() => {
    // Goal = TOTAL take-home (owner, 2026-07-29). The pay engine says what's
    // already earned; future base pay is projected for the remaining Mon–Sat
    // days; the funnel covers only the commission gap. Progress lives in
    // DOLLARS — no door-count subtraction (banked sales are inside earned).
    const workdaysLeft = remainingWorkdaysInMonth(laTodayISO());
    const futureBase = workdaysLeft * earnings.avgDailyBase;
    const { gap, goalMet } = commissionGap({
      goal: monthlyGoal,
      earned: earnings.monthEarned,
      futureBase,
    });
    const empty = {
      requiredSales: 0, requiredSits: 0, requiredConfirmed: 0, requiredDoors: 0,
      requiredPeopleTalkedTo: 0,
      doorsPerDay: 0, talksPerDay: 0, targetValuePerDoor: 0,
    };
    const meta = { daysRemaining: workdaysLeft, earned: earnings.monthEarned, futureBase, gap };
    if (goalMet) return { ready: true, goalMet: true, ...empty, ...meta };

    const solve = funnel.rates
      ? backSolveFunnel({ incomeGoal: gap, avgCommissionPerSale: avgCommission, rates: funnel.rates })
      : null;
    if (!solve) return { ready: false, goalMet: false, ...empty, ...meta };

    const { requiredSales, requiredSits, requiredLeads: requiredConfirmed, requiredDoors } = solve;
    const requiredPeopleTalkedTo = requiredDoors * funnel.talkDoorRate;
    const doorsPerDay = workdaysLeft > 0 ? requiredDoors / workdaysLeft : requiredDoors;
    const talksPerDay = workdaysLeft > 0 ? requiredPeopleTalkedTo / workdaysLeft : requiredPeopleTalkedTo;
    // Each remaining knock is worth this much of the REMAINING gap.
    const targetValuePerDoor = requiredDoors > 0 ? gap / requiredDoors : 0;

    return {
      ready: true, goalMet: false,
      requiredSales, requiredSits, requiredConfirmed, requiredDoors,
      requiredPeopleTalkedTo,
      doorsPerDay, talksPerDay, targetValuePerDoor,
      ...meta,
    };
  }, [funnel, monthlyGoal, avgCommission, earnings.monthEarned, earnings.avgDailyBase]);


  const saveGoal = useMutation({
    mutationFn: async (newGoal: number) => {
      const { error } = await supabase
        .from("profiles").update({ monthly_goal: newGoal }).eq("id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Monthly goal updated");
      qc.invalidateQueries({ queryKey: ["profile_goals", userId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <TimeClock userId={userId} />
      <TakeHomeWidget userId={userId} weeklyPay={weeklyPay} hourlyRate={hourlyRate} weekPoints={weekPoints} />
      <SCCERankBanner userId={userId} />
      <WeeklyPlaybook userId={userId} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <div className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto scrollbar-hide">
          <TabsList className="flex w-max min-w-full flex-nowrap whitespace-nowrap md:grid md:w-full md:grid-cols-4 bg-surface border border-border p-1 h-auto">
            <ArcadeTab value="today">Today</ArcadeTab>
            <ArcadeTab value="week">This Week</ArcadeTab>
            <ArcadeTab value="mtd">Month to Date</ArcadeTab>
            <ArcadeTab value="goals">My Goals</ArcadeTab>
          </TabsList>
        </div>

        {/* ============ TODAY ============ */}
        <TabsContent value="today" className="mt-6 space-y-6">
          <div className="grid sm:grid-cols-3 gap-4">
            <GrindCounter label="Leads Called In"          value={today.leads_called_in} icon={<PhoneCall className="w-4 h-4" />}     accent="var(--neon)" />
            <GrindCounter label="Confirmed Next Day Leads" value={today.next_days}       icon={<CalendarClock className="w-4 h-4" />} accent="var(--victory)" />
            <GrindCounter label="Confirmed Future Leads"   value={today.future_leads}    icon={<CalendarDays className="w-4 h-4" />}  accent="var(--accent)" />
          </div>

          <ValuePerDoorWidget
            value={valuePerDoor}
            doors={month.doors_knocked}
            commission={monthCommission}
            targetValue={mission.targetValuePerDoor}
            targetReady={mission.ready}
            monthlyGoal={monthlyGoal}
          />
        </TabsContent>


        {/* ============ THIS WEEK ============ */}
        <TabsContent value="week" className="mt-6 space-y-6">
          <div className="grid sm:grid-cols-2 gap-4">
            <BigStat
              label="Weekly Pay"
              value={formatCurrency(weeklyPay)}
              sub={`${weekHours.toFixed(1)} hrs clocked · base + commission + bonuses`}
              icon={<DollarSign className="w-4 h-4" />}
              accent="var(--victory)"
            />
            <BigStat
              label="Leads Per Day"
              value={lpd.toFixed(1)}
              sub={`${week.confirmed_leads} confirmed · ${week.days_worked} days worked`}
              icon={<Gauge className="w-4 h-4" />}
              accent="var(--neon)"
            />
          </div>

          <PaycheckEngineWidget
            points={weekPoints}
            hours={weekHours}
            hourlyRate={hourlyRate}
            base={weekBase}
            commission={weekCommission}
            revenue={weekRevenue}
          />

          <RankProgress
            current={current.label}
            next={next.label}
            sales={month.sales}
            currentMin={current.minSales}
            nextMin={next.minSales}
            pct={rankProgress}
            maxed={current === next}
          />
        </TabsContent>

        {/* ============ MONTH TO DATE ============ */}
        <TabsContent value="mtd" className="mt-6 space-y-6">
          <div className="grid sm:grid-cols-2 gap-4">
            <BigStat
              label="Monthly Revenue Generated"
              value={formatCurrency(monthRevenue)}
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
            earned={earnings.monthEarned}
            goal={monthlyGoal}
            pct={goalProgress}
            onSave={(g) => saveGoal.mutate(g)}
            saving={saveGoal.isPending}
          />
        </TabsContent>

        {/* ============ MY GOALS — Reverse-engineering funnel ============ */}
        <TabsContent value="goals" className="mt-6 space-y-6">
          <GoalInputPanel
            goal={monthlyGoal}
            onSave={(g) => saveGoal.mutate(g)}
            saving={saveGoal.isPending}
          />
          <DailyMissionWidget
            ready={mission.ready}
            goalMet={mission.goalMet}
            earned={mission.earned}
            goal={monthlyGoal}
            doorsPerDay={mission.doorsPerDay}
            talksPerDay={mission.talksPerDay}
            daysRemaining={mission.daysRemaining}
            targetValuePerDoor={mission.targetValuePerDoor}
          />
          <FunnelBreakdown
            ready={mission.ready}
            goal={monthlyGoal}
            avgCommissionPerSale={avgCommission}
            closeRate={funnel.rates?.closeRate ?? 0}
            sitRate={funnel.rates?.sitRate ?? 0}
            leadDoorRate={funnel.rates?.leadDoorRate ?? 0}
            requiredSales={mission.requiredSales}
            requiredSits={mission.requiredSits}
            requiredConfirmed={mission.requiredConfirmed}
            requiredDoors={mission.requiredDoors}
            source={funnel.source}
            sampleDoors={funnel.sampleDoors}
            earned={mission.earned}
            futureBase={mission.futureBase}
            gap={mission.gap}
          />
        </TabsContent>

      </Tabs>
    </div>
  );
}

/* ============ Sub-components ============ */

function ArcadeTab({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsTrigger
      value={value}
      className="font-display text-[10px] uppercase tracking-widest data-[state=active]:bg-[color-mix(in_oklab,var(--neon)_15%,transparent)] data-[state=active]:text-neon data-[state=active]:shadow-[0_0_18px_-4px_var(--neon)] py-2.5"
    >
      {children}
    </TabsTrigger>
  );
}

function GrindCounter({
  label, value, icon, accent,
}: { label: string; value: number; icon: React.ReactNode; accent: string }) {
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
        <div className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest" style={{ color: accent }}>
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

function ValuePerDoorWidget({
  value, doors, commission, targetValue, targetReady, monthlyGoal,
}: { value: number; doors: number; commission: number; targetValue: number; targetReady: boolean; monthlyGoal: number }) {
  // If a target has been set and funnel math is ready, show the goal-driven value per door.
  // Otherwise, fall back to historical (commission MTD / doors MTD).
  const showTarget = targetReady && targetValue > 0;
  const display = showTarget ? targetValue : value;
  return (
    <div className="relative overflow-hidden rounded-lg border border-[color-mix(in_oklab,var(--victory)_40%,var(--border))] bg-[color-mix(in_oklab,var(--victory)_7%,var(--surface))] p-6">
      <div className="absolute inset-0 pointer-events-none scanlines opacity-30" />
      <div
        className="absolute -inset-1 pointer-events-none rounded-lg opacity-50"
        style={{ boxShadow: "inset 0 0 60px -10px var(--victory)" }}
      />
      <div className="relative flex flex-col md:flex-row md:items-center md:justify-between gap-6">
        <div>
          <div className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest text-victory">
            <Sparkles className="w-3 h-3" /> Value Per Door {showTarget && <span className="text-victory/60">· TARGET</span>}
          </div>
          <div className="mt-3 font-display text-5xl sm:text-6xl md:text-7xl text-mega-victory leading-none">
            {formatCurrency(display)}
          </div>
          <div className="mt-3 text-[10px] font-display uppercase tracking-widest text-victory/80">
            {showTarget ? "EACH REQUIRED KNOCK IS WORTH THIS" : "EVERY KNOCK PAYS"}
          </div>
        </div>
        <div className="text-xs text-muted-foreground space-y-1 md:text-right">
          {showTarget ? (
            <>
              <div>Target Income · <span className="text-victory font-display">{formatCurrency(monthlyGoal)}</span></div>
              <div>Historical pace · <span className="text-neon font-display">{formatCurrency(value)}/door</span></div>
              <div className="text-[10px] uppercase tracking-widest mt-2">goal commission / required doors</div>
            </>
          ) : (
            <>
              <div>Commission MTD · <span className="text-victory font-display">{formatCurrency(commission)}</span></div>
              <div>Doors knocked MTD · <span className="text-neon font-display">{doors.toLocaleString()}</span></div>
              <div className="text-[10px] uppercase tracking-widest mt-2">commission / doors</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


function BigStat({
  label, value, sub, icon, accent,
}: { label: string; value: string; sub: string; icon: React.ReactNode; accent: string }) {
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
        <div className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest" style={{ color: accent }}>
          {icon} {label}
        </div>
        <div className="mt-3 font-display text-4xl md:text-5xl leading-none" style={{ color: accent, textShadow: `0 0 18px color-mix(in oklab, ${accent} 55%, transparent)` }}>
          {value}
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">{sub}</div>
      </div>
    </div>
  );
}

function RankProgress({
  current, next, sales, currentMin, nextMin, pct, maxed,
}: { current: string; next: string; sales: number; currentMin: number; nextMin: number; pct: number; maxed: boolean }) {
  return (
    <ArcadePanel title="Rank Progression"
      action={<span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">MTD · Sales-based</span>}
    >
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Trophy className="w-5 h-5 text-victory" />
          <div>
            <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Current Rank</div>
            <div className="font-display text-lg text-neon">{current.toUpperCase()}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Next</div>
          <div className="font-display text-lg text-victory">{maxed ? "MAXED" : next.toUpperCase()}</div>
        </div>
      </div>
      <NeonBar pct={pct} accent="var(--neon)" />
      <div className="mt-2 flex justify-between text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        <span>{sales} sales</span>
        <span>{maxed ? "Top tier reached" : `${Math.max(0, nextMin - sales)} sales to ${next}`}</span>
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground">Tier · {currentMin}–{maxed ? "∞" : nextMin}</div>
    </ArcadePanel>
  );
}

function PaycheckEngineWidget({
  points, hours, hourlyRate, base, commission, revenue,
}: { points: number; hours: number; hourlyRate: number; base: number; commission: number; revenue: number }) {
  const atTop = hourlyRate >= HOURLY_TOP;
  const nextTarget = points >= POINTS_TIER_MID ? POINTS_TIER_TOP : POINTS_TIER_MID;
  const nextRate = points >= POINTS_TIER_MID ? HOURLY_TOP : HOURLY_MID;
  // Monotonic progress toward the top tier so the bar never shrinks as points grow.
  const pct = Math.min(1, points / POINTS_TIER_TOP);
  const commissionPct = Math.round(commissionRateForPoints(points) * 100);
  const accent = atTop ? "var(--victory)" : "var(--neon)";
  return (
    <ArcadePanel title="Paycheck Engine"
      action={<span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Auto · Weekly</span>}
    >
      <div className="grid sm:grid-cols-3 gap-4">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Hourly Tier</div>
          <div className="font-display text-3xl mt-1" style={{ color: accent, textShadow: `0 0 14px color-mix(in oklab, ${accent} 60%, transparent)` }}>
            ${hourlyRate}/hr
          </div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">
            {atTop
              ? `🔥 $${HOURLY_TOP} tier unlocked`
              : `${Math.max(0, nextTarget - points)} pt(s) to $${nextRate}/hr`}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Clocked Hours</div>
          <div className="font-display text-3xl text-neon mt-1">{hours.toFixed(1)}</div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">
            from time clock · lunch deducted
          </div>
        </div>
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Sits / Points</div>
          <div className="font-display text-3xl text-accent mt-1">{points}</div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">
            Sit = 1 · Sale = 2
          </div>
        </div>
      </div>
      <NeonBar pct={pct} accent={accent} />
      <div className="mt-3 grid sm:grid-cols-3 gap-2 text-[11px] text-muted-foreground border-t border-border pt-3">
        <div>Base · <span className="text-foreground">{formatCurrency(base)}</span></div>
        <div>
          Commission ({commissionPct}% of {formatCurrency(revenue)}) ·{" "}
          <span className="text-victory">{formatCurrency(commission)}</span>
        </div>
        <div className="sm:text-right">Total · <span className="font-display text-victory">{formatCurrency(base + commission)}</span></div>
      </div>
    </ArcadePanel>
  );
}

function GoalBar({
  earned, goal, pct, onSave, saving,
}: { earned: number; goal: number; pct: number; onSave: (g: number) => void; saving: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(goal));
  useEffect(() => { if (!editing) setDraft(String(goal)); }, [goal, editing]);

  const submit = () => {
    const n = Math.max(0, Math.round(Number(draft) || 0));
    onSave(n);
    setEditing(false);
  };

  return (
    <ArcadePanel title="Monthly Goal"
      action={
        editing ? (
          <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Set your target</span>
        ) : (
          <Button variant="ghost" onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit Goal
          </Button>
        )
      }
    >
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Earned MTD · All Pay Combined</div>
          <div className="font-display text-4xl md:text-5xl text-mega-victory leading-none mt-1">{formatCurrency(earned)}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Goal</div>
          {editing ? (
            <div className="mt-1 flex items-center gap-2 justify-end">
              <Input
                type="number" min={0} step={100} inputMode="numeric"
                className="w-36 font-display text-lg"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
              />
              <Button size="sm" onClick={submit} disabled={saving}>
                <Check className="w-3.5 h-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setDraft(String(goal)); setEditing(false); }}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          ) : (
            <div className="font-display text-2xl text-neon">{formatCurrency(goal)}</div>
          )}
        </div>
      </div>
      <NeonBar pct={pct} accent="var(--victory)" tall />
      <div className="mt-2 flex justify-between text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        <span>{(pct * 100).toFixed(0)}% complete</span>
        <span>{pct >= 1 ? "🏆 Goal smashed" : `${formatCurrency(Math.max(0, goal - earned))} to go`}</span>
      </div>
    </ArcadePanel>
  );
}

function NeonBar({ pct, accent, tall = false }: { pct: number; accent: string; tall?: boolean }) {
  const w = Math.max(0, Math.min(1, pct)) * 100;
  return (
    <div className={`mt-4 relative ${tall ? "h-4" : "h-3"} w-full rounded-full overflow-hidden border border-border bg-[color-mix(in_oklab,var(--foreground)_4%,transparent)]`}>
      <div
        className="h-full rounded-full transition-[width] duration-700 ease-out"
        style={{
          width: `${w}%`,
          background: `linear-gradient(90deg, color-mix(in oklab, ${accent} 70%, transparent), ${accent})`,
          boxShadow: `0 0 14px ${accent}, 0 0 28px color-mix(in oklab, ${accent} 60%, transparent)`,
        }}
      />
      <div className="absolute inset-0 pointer-events-none scanlines opacity-30" />
    </div>
  );
}

/* ============ My Goals — Reverse Engineering ============ */

function GoalInputPanel({
  goal, onSave, saving,
}: { goal: number; onSave: (g: number) => void; saving: boolean }) {
  const [draft, setDraft] = useState(String(goal));
  useEffect(() => { setDraft(String(goal)); }, [goal]);
  const submit = () => {
    const n = Math.max(0, Math.round(Number(draft) || 0));
    onSave(n);
  };
  return (
    <div className="relative overflow-hidden rounded-lg border border-[color-mix(in_oklab,var(--neon)_45%,var(--border))] bg-[color-mix(in_oklab,var(--neon)_6%,var(--surface))] p-6">
      <div className="absolute inset-0 pointer-events-none scanlines opacity-25" />
      <div className="absolute -inset-1 pointer-events-none rounded-lg opacity-50" style={{ boxShadow: "inset 0 0 50px -8px var(--neon)" }} />
      <div className="relative space-y-4">
        <div className="flex items-center gap-2 text-[10px] font-display uppercase tracking-widest text-neon">
          <Crosshair className="w-3.5 h-3.5" /> Target Monthly Income · Quest Input
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="relative flex-1 min-w-0">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 font-display text-3xl text-neon/70 pointer-events-none">$</span>
            <Input
              type="number" min={0} step={100} inputMode="numeric"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              className="h-16 pl-10 pr-4 font-display text-3xl bg-background/60 border-[color-mix(in_oklab,var(--neon)_50%,var(--border))] text-neon"
              style={{ boxShadow: "0 0 24px -6px var(--neon), inset 0 0 16px -8px var(--neon)" }}
              placeholder="5000"
            />
          </div>
          <Button
            size="lg"
            onClick={submit}
            disabled={saving}
            className="h-16 px-8 font-display uppercase tracking-widest bg-neon/15 hover:bg-neon/25 text-neon border border-neon/50"
            style={{ boxShadow: "0 0 20px -6px var(--neon)" }}
          >
            <Zap className="w-4 h-4 mr-2" /> Set Mission
          </Button>
        </div>
        <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          The funnel re-engineers backwards to tell you exactly what to do today.
        </p>
      </div>
    </div>
  );
}

function DailyMissionWidget({
  ready, goalMet, earned, goal, doorsPerDay, talksPerDay, daysRemaining, targetValuePerDoor,
}: {
  ready: boolean; goalMet: boolean; earned: number; goal: number;
  doorsPerDay: number; talksPerDay: number;
  daysRemaining: number; targetValuePerDoor: number;
}) {
  if (goalMet) {
    return (
      <div className="rounded-lg border-2 border-[color-mix(in_oklab,var(--victory)_55%,transparent)] bg-[color-mix(in_oklab,var(--victory)_10%,var(--surface))] p-8 text-center">
        <div className="font-display text-2xl text-victory">🏆 Goal met</div>
        <p className="mt-2 text-sm text-muted-foreground max-w-md mx-auto">
          You&apos;ve already cleared {formatCurrency(goal)} in total earnings this month
          ({formatCurrency(earned)} banked). Everything from here is gravy.
        </p>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="rounded-lg border border-border bg-surface p-6 text-center">
        <Swords className="w-6 h-6 text-muted-foreground mx-auto" />
        <div className="mt-3 font-display text-sm uppercase tracking-widest text-muted-foreground">Mission unavailable</div>
        <p className="mt-2 text-xs text-muted-foreground max-w-md mx-auto">
          Set a target income above. We also need conversion data — from your own recent logs (200+ doors knocked) or the company-wide 60-day baseline.
        </p>
      </div>
    );
  }
  const doors = Math.ceil(doorsPerDay);
  const talks = Math.ceil(talksPerDay);
  return (
    <div className="relative overflow-hidden rounded-lg border-2 border-[color-mix(in_oklab,var(--victory)_55%,transparent)] bg-gradient-to-br from-[color-mix(in_oklab,var(--victory)_12%,var(--surface))] to-[color-mix(in_oklab,var(--neon)_8%,var(--surface))] p-8">
      <div className="absolute inset-0 pointer-events-none scanlines opacity-30" />
      <div className="absolute -inset-1 pointer-events-none rounded-lg opacity-60" style={{ boxShadow: "inset 0 0 80px -12px var(--victory)" }} />
      <div className="relative">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-[10px] font-display uppercase tracking-widest text-victory">
            <Flame className="w-3.5 h-3.5" /> Daily Mission · Objective
          </div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            {daysRemaining} working day{daysRemaining === 1 ? "" : "s"} left
          </div>
        </div>

        <div className="mt-4 font-display text-lg md:text-xl text-foreground/90 leading-relaxed">
          To hit <span className="text-victory text-mega-victory">{formatCurrency(goal)}</span>, your mission today is to knock{" "}
          <span className="text-neon" style={{ textShadow: "0 0 18px var(--neon)" }}>{doors.toLocaleString()} doors</span>{" "}
          and talk to{" "}
          <span className="text-accent" style={{ textShadow: "0 0 18px var(--accent)" }}>{talks.toLocaleString()} people</span>.
        </div>

        <div className="mt-6 grid sm:grid-cols-3 gap-4">
          <MissionStat icon={<DoorOpen className="w-4 h-4" />} label="Doors / Day" value={doors.toLocaleString()} accent="var(--neon)" />
          <MissionStat icon={<Users   className="w-4 h-4" />} label="Talk To / Day" value={talks.toLocaleString()} accent="var(--accent)" />
          <MissionStat icon={<DollarSign className="w-4 h-4" />} label="Per-Door Value" value={formatCurrency(targetValuePerDoor)} accent="var(--victory)" />
        </div>
      </div>
    </div>
  );
}

function MissionStat({
  icon, label, value, accent,
}: { icon: React.ReactNode; label: string; value: string; accent: string }) {
  return (
    <div className="rounded-md border p-4" style={{
      borderColor: `color-mix(in oklab, ${accent} 40%, var(--border))`,
      background: `color-mix(in oklab, ${accent} 6%, var(--surface))`,
    }}>
      <div className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest" style={{ color: accent }}>
        {icon} {label}
      </div>
      <div className="mt-2 font-display text-3xl leading-none" style={{ color: accent, textShadow: `0 0 16px color-mix(in oklab, ${accent} 60%, transparent)` }}>
        {value}
      </div>
    </div>
  );
}

function FunnelBreakdown({
  ready, goal, avgCommissionPerSale, closeRate, sitRate, leadDoorRate,
  requiredSales, requiredSits, requiredConfirmed, requiredDoors,
  source, sampleDoors, earned, futureBase, gap,
}: {
  ready: boolean; goal: number; avgCommissionPerSale: number;
  closeRate: number; sitRate: number; leadDoorRate: number;
  requiredSales: number; requiredSits: number; requiredConfirmed: number; requiredDoors: number;
  source: "personal" | "company"; sampleDoors: number;
  earned: number; futureBase: number; gap: number;
}) {
  if (!ready) return null;
  const rows = [
    { label: "Required Sales",          value: Math.ceil(requiredSales),     formula: `${formatCurrency(gap)} gap ÷ ${formatCurrency(avgCommissionPerSale)} avg commission`, accent: "var(--victory)" },
    { label: "Required Sits / Demos",   value: Math.ceil(requiredSits),      formula: `Sales ÷ ${(closeRate*100).toFixed(0)}% close rate`,    accent: "var(--accent)" },
    { label: "Required Confirmed Leads",value: Math.ceil(requiredConfirmed), formula: `Sits ÷ ${(sitRate*100).toFixed(0)}% sit rate`,         accent: "var(--neon)" },
    { label: "Total Doors to Knock",    value: Math.ceil(requiredDoors),     formula: `Leads ÷ ${(leadDoorRate*100).toFixed(2)}% lead-per-door`, accent: "var(--neon)" },
  ];
  return (
    <ArcadePanel
      title="Funnel Breakdown · Reverse Engineering"
      action={
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          {source === "personal" ? `Personal · ${sampleDoors.toLocaleString()} doors` : "Company avg · 60d baseline"}
        </span>
      }
    >
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-4 rounded-md border border-border bg-background/40 px-4 py-3">
            <div>
              <div className="text-[10px] font-display uppercase tracking-widest" style={{ color: r.accent }}>{r.label}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">{r.formula}</div>
            </div>
            <div className="font-display text-2xl" style={{ color: r.accent, textShadow: `0 0 14px color-mix(in oklab, ${r.accent} 60%, transparent)` }}>
              {r.value.toLocaleString()}
            </div>
          </div>
        ))}
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground border-t border-border pt-3 flex justify-between flex-wrap gap-2">
          <span>Earned so far · {formatCurrency(earned)} of {formatCurrency(goal)}</span>
          <span>Projected future base · {formatCurrency(futureBase)}</span>
          <span>Gap to close · {formatCurrency(gap)}</span>
        </div>
      </div>
    </ArcadePanel>
  );
}

function SCCERankBanner({ userId }: { userId: string }) {
  const { data } = useQuery({
    queryKey: ["scce_rank", userId],
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("current_rank, consecutive_weeks_3_plus_sits, consecutive_weeks_7_plus_sits, rolling_4_week_sit_avg, recruits_count, pay_lock_status")
        .eq("id", userId)
        .maybeSingle();
      return data as {
        current_rank: string | null;
        consecutive_weeks_3_plus_sits: number;
        consecutive_weeks_7_plus_sits: number;
        rolling_4_week_sit_avg: number;
        recruits_count: number;
        pay_lock_status: string | null;
      } | null;
    },
  });
  const rank = data?.current_rank ?? "Jr. Silver";
  const payLock = data?.pay_lock_status ?? "active";
  return (
    <>
    {payLock === "warned" && (
      <div className="rounded-xl border border-warning/50 bg-warning/10 p-4 text-xs">
        <span className="font-display uppercase tracking-widest text-warning">⚠ Pay Lock Warning</span>
        <span className="text-muted-foreground"> — your rolling 4-week sit average is below {PAY_LOCK_MIN_ROLLING_AVG}. A second violation within 90 days reverts your comp to the weekly tier reset (rank retained).</span>
      </div>
    )}
    {payLock === "reverted" && (
      <div className="rounded-xl border border-destructive/50 bg-destructive/10 p-4 text-xs">
        <span className="font-display uppercase tracking-widest text-destructive">Pay Lock Reverted</span>
        <span className="text-muted-foreground"> — you're currently paid on the weekly point tiers. Reinstatement: 3 consecutive weeks at 7+ sits.</span>
      </div>
    )}
    <div className="arcade-card p-4 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <RankPill rank={rank} size="md" />
        <div className="min-w-0">
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">SCCE Rank</div>
          <div className="text-xs text-muted-foreground truncate">{RANK_PERKS[rank] ?? ""}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        <span>3+ sits wks · <span className="text-neon">{data?.consecutive_weeks_3_plus_sits ?? 0}</span></span>
        <span>7+ sits wks · <span className="text-victory">{data?.consecutive_weeks_7_plus_sits ?? 0}</span></span>
        <span>4-wk avg · <span className="text-accent">{(data?.rolling_4_week_sit_avg ?? 0).toFixed(1)}</span></span>
        <span>recruits · <span className="text-foreground">{data?.recruits_count ?? 0}</span></span>
      </div>
    </div>
    </>
  );
}

/* ============ TAKE-HOME WIDGET (top of canvasser dashboard) ============ */
function TakeHomeWidget({ userId, weeklyPay, hourlyRate, weekPoints }: {
  userId: string;
  weeklyPay: number;
  hourlyRate: number;
  weekPoints: number;
}) {
  const { data } = useQuery({
    queryKey: ["takehome_rank", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("current_rank")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const rank = (data?.current_rank ?? "Jr. Silver") as string;

  // Authoritative MTD volume bonus from the pay engine (calc_monthly_paycheck)
  // — the same source the owner's payroll screen pays from. Hidden on error
  // rather than showing a possibly-wrong dollar figure.
  const monthStart = laMonthStartISO();
  const { data: monthly } = useQuery({
    queryKey: ["takehome_volume_bonus", userId, monthStart],
    queryFn: async () => {
      const { results } = await getMonthlyPaychecks({
        data: { month_start: monthStart, canvasser_ids: [userId] },
      });
      return results[0]?.paycheck ?? null;
    },
  });

  return (
    <div className="rounded-xl border border-victory/40 bg-[color-mix(in_oklab,var(--victory)_8%,var(--surface))] p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-6">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-victory/80">
            Weekly Pay · All Sources
          </div>
          <div className="mt-2 font-display text-4xl sm:text-5xl text-victory leading-none">
            {formatCurrency(weeklyPay)}
          </div>
          <div className="mt-2 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            ${hourlyRate}/hr · {weekPoints} pts this week
          </div>
          {monthly && (
            <div className="mt-1 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              Volume bonus earned this month · <span className={Number(monthly.volume_bonus) > 0 ? "text-victory" : ""}>{formatCurrency(Number(monthly.volume_bonus))}</span>
              {" (paid next month) · "}{formatCurrency(VOLUME_BONUS_STEP - (Number(monthly.sale_price_total) % VOLUME_BONUS_STEP))} to next $1,500
            </div>
          )}
          {monthly && (
            <div className="mt-1 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              Month take-home so far · <span className="text-victory">{formatCurrency(Number(monthly.total_pay))}</span>
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Current Rank
          </div>
          <div className="mt-2 flex justify-end">
            <RankPill rank={rank} />
          </div>
        </div>
      </div>
    </div>
  );
}

