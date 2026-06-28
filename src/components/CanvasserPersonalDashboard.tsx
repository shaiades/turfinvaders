import { useMemo, useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel } from "@/components/arcade";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { LiveLeadCounter } from "@/components/LiveLeadCounter";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { DoorOpen, CalendarClock, CalendarDays, PhoneCall, DollarSign, Target, Gauge, Trophy, Sparkles, Pencil, Check, X } from "lucide-react";

/**
 * Tiered weekly commission.
 * Points formula: every confirmed lead that becomes a sit/demo earns points.
 *   - Sit that did NOT close (pitch miss) = 1 point
 *   - Sit that closed into a sale         = 2 points
 *   → weekly points = (demos_sits - sales) * 1 + sales * 2 = demos_sits + sales
 * Rate applies to confirmed sale $ for the week.
 */
const COMMISSION_LOW = 0.01;
const COMMISSION_HIGH = 0.02;
const COMMISSION_TIER_THRESHOLD = 7; // weekly points needed to unlock 2%

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

function todayISO() {
  const d = new Date(); d.setHours(0,0,0,0);
  return d.toISOString().slice(0, 10);
}
function startOfWeekISO() {
  const d = new Date(); d.setHours(0,0,0,0);
  const day = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}
function startOfMonthISO() {
  const d = new Date(); d.setHours(0,0,0,0); d.setDate(1);
  return d.toISOString().slice(0, 10);
}
function formatUSD(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

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

  const profileQuery = useQuery({
    queryKey: ["my_profile_goal", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles").select("monthly_goal").eq("id", userId).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const monthlyGoal = Number((profileQuery.data as { monthly_goal?: number } | null)?.monthly_goal ?? DEFAULT_MONTHLY_GOAL);

  const logsQuery = useQuery({
    queryKey: ["my_logs", "mtd", userId],
    queryFn: async () => {
      const since = startOfMonthISO();
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
      const since = new Date(); since.setHours(0,0,0,0); since.setDate(1);
      const { data, error } = await supabase
        .from("leads")
        .select("sale_amount, created_at")
        .eq("canvasser_id", userId)
        .eq("status", "confirmed")
        .eq("is_sale", true)
        .gte("created_at", since.toISOString());
      if (error) throw error;
      return data ?? [];
    },
  });

  const { today, week, month, monthRevenue, weekRevenue, weekPoints, weekRate, monthCommission, weekCommission } = useMemo(() => {
    const rows = (logsQuery.data ?? []) as unknown as Array<Record<string, number | null> & { log_date: string }>;
    const t = todayISO(), w = startOfWeekISO();
    const today = aggregate(rows.filter((r) => r.log_date === t));
    const week  = aggregate(rows.filter((r) => r.log_date >= w));
    const month = aggregate(rows);

    const sales = salesQuery.data ?? [];
    const monthRevenue = sales.reduce((a, r) => a + Number(r.sale_amount ?? 0), 0);
    const wStart = new Date(); wStart.setHours(0,0,0,0);
    const day = wStart.getDay() === 0 ? 7 : wStart.getDay();
    wStart.setDate(wStart.getDate() - (day - 1));
    const weekRevenue = sales
      .filter((r) => new Date(r.created_at) >= wStart)
      .reduce((a, r) => a + Number(r.sale_amount ?? 0), 0);

    // Weekly points: 1 pt per pitch-miss sit, 2 pts per sale.
    // Simplifies to: demos_sits + sales (since a sale is also a sit).
    const weekPoints = week.demos_sits + week.sales;
    const weekRate = weekPoints >= COMMISSION_TIER_THRESHOLD ? COMMISSION_HIGH : COMMISSION_LOW;

    // Month commission: average-ish — apply 1% baseline to all month revenue,
    // plus 1% bonus only on revenue from weeks where the player hit threshold.
    // Simple approximation: use the current week's rate for the month estimate.
    const monthRate = weekRate;

    return {
      today, week, month, monthRevenue, weekRevenue, weekPoints, weekRate,
      monthCommission: monthRevenue * monthRate,
      weekCommission: weekRevenue * weekRate,
    };
  }, [logsQuery.data, salesQuery.data]);

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
  const goalProgress = monthlyGoal > 0 ? Math.min(1, monthRevenue / monthlyGoal) : 0;

  const [tab, setTab] = useState<"today" | "week" | "mtd">("today");

  const saveGoal = useMutation({
    mutationFn: async (newGoal: number) => {
      const { error } = await supabase
        .from("profiles").update({ monthly_goal: newGoal }).eq("id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Monthly goal updated");
      qc.invalidateQueries({ queryKey: ["my_profile_goal", userId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList className="grid w-full grid-cols-3 bg-surface border border-border p-1 h-auto">
          <ArcadeTab value="today">Today</ArcadeTab>
          <ArcadeTab value="week">This Week</ArcadeTab>
          <ArcadeTab value="mtd">Month to Date</ArcadeTab>
        </TabsList>

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
          />
        </TabsContent>

        {/* ============ THIS WEEK ============ */}
        <TabsContent value="week" className="mt-6 space-y-6">
          <div className="grid sm:grid-cols-2 gap-4">
            <BigStat
              label="Weekly Pay"
              value={formatUSD(weekCommission)}
              sub={`${(weekRate * 100).toFixed(0)}% tier · ${weekPoints} pts · ${formatUSD(weekRevenue)} confirmed sales`}
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

          <CommissionTierWidget points={weekPoints} threshold={COMMISSION_TIER_THRESHOLD} rate={weekRate} />

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
              value={formatUSD(monthRevenue)}
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
            revenue={monthRevenue}
            goal={monthlyGoal}
            pct={goalProgress}
            onSave={(g) => saveGoal.mutate(g)}
            saving={saveGoal.isPending}
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
  value, doors, commission,
}: { value: number; doors: number; commission: number }) {
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
            <Sparkles className="w-3 h-3" /> Value Per Door
          </div>
          <div className="mt-3 font-display text-6xl md:text-7xl text-mega-victory leading-none">
            {formatUSD(value)}
          </div>
          <div className="mt-3 text-[10px] font-display uppercase tracking-widest text-victory/80">
            EVERY KNOCK PAYS
          </div>
        </div>
        <div className="text-xs text-muted-foreground space-y-1 md:text-right">
          <div>Commission MTD · <span className="text-victory font-display">{formatUSD(commission)}</span></div>
          <div>Doors knocked MTD · <span className="text-neon font-display">{doors.toLocaleString()}</span></div>
          <div className="text-[10px] uppercase tracking-widest mt-2">commission / doors</div>
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

function CommissionTierWidget({ points, threshold, rate }: { points: number; threshold: number; rate: number }) {
  const pct = Math.min(1, points / threshold);
  const atTop = rate >= COMMISSION_HIGH;
  return (
    <ArcadePanel title="Commission Tier"
      action={<span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Weekly · {points} pts</span>}
    >
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Current Rate</div>
          <div className="font-display text-3xl text-victory mt-1" style={{ textShadow: "0 0 14px color-mix(in oklab, var(--victory) 60%, transparent)" }}>
            {(rate * 100).toFixed(0)}%
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Unlock 2%</div>
          <div className="font-display text-lg text-neon">{threshold} pts / week</div>
        </div>
      </div>
      <NeonBar pct={pct} accent={atTop ? "var(--victory)" : "var(--neon)"} />
      <div className="mt-2 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        {atTop ? "🔥 2% tier unlocked this week" : `${Math.max(0, threshold - points)} more pts to unlock 2%`}
      </div>
    </ArcadePanel>
  );
}

function GoalBar({
  revenue, goal, pct, onSave, saving,
}: { revenue: number; goal: number; pct: number; onSave: (g: number) => void; saving: boolean }) {
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
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit Goal
          </Button>
        )
      }
    >
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Revenue MTD</div>
          <div className="font-display text-4xl md:text-5xl text-mega-victory leading-none mt-1">{formatUSD(revenue)}</div>
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
            <div className="font-display text-2xl text-neon">{formatUSD(goal)}</div>
          )}
        </div>
      </div>
      <NeonBar pct={pct} accent="var(--victory)" tall />
      <div className="mt-2 flex justify-between text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        <span>{(pct * 100).toFixed(0)}% complete</span>
        <span>{pct >= 1 ? "🏆 Goal smashed" : `${formatUSD(Math.max(0, goal - revenue))} to go`}</span>
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
