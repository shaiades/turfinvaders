import { useEffect, useMemo, useState } from "react";
import { formatCurrency } from "@/lib/utils";
import { laTodayISO, remainingWorkdaysInMonth, remainingWorkdaysInWeek } from "@/lib/dates";
import { backSolveFunnel, commissionGap } from "@/lib/funnel";
import { DEFAULT_AVG_COMMISSION, useCanvasserStats } from "@/hooks/useCanvasserStats";
import {
  clampCommission,
  clampGoal,
  useSaveGoals,
  type GoalsPatch,
} from "@/hooks/useCanvasserProfile";
import { ArcadePanel } from "@/components/arcade";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Calendar,
  DollarSign,
  DoorOpen,
  PhoneCall,
  Sparkles,
  Target,
  Trophy,
  Users,
  Zap,
} from "lucide-react";

/**
 * The Plan tab — the Playbook and the old "My Goals" Mission merged into one
 * goal → funnel back-solve (2026-08-14). One goal editor writes all three
 * profile columns; one solve runs on the horizon toggle (This Week ↔ This
 * Month) through the SHARED funnel engine (useFunnelRates via
 * useCanvasserStats), so the two horizons can never disagree on rates.
 * The goal is TOTAL take-home (owner, 2026-07-29): pay-engine earnings so
 * far + projected future base are subtracted first; the funnel covers only
 * the remaining commission gap. Progress lives in DOLLARS, not door counts.
 * Equation: [Knocks] × $[Value/Knock] = $[Gap]
 * Funnel:   Gap ÷ AvgCommission = Sales → ÷Close = Sits → ÷Show = Leads → ÷Contact = Knocks
 * Daily:    knocks ÷ remaining Mon–Sat workdays (week) or rest-of-month workdays.
 */

type Horizon = "week" | "month";

function fmtInt(n: number) {
  if (!isFinite(n)) return "—";
  return Math.ceil(n).toLocaleString();
}

export function PlanPanel({ userId }: { userId: string }) {
  const stats = useCanvasserStats(userId);
  const { funnelRates, earnings } = stats;
  const [horizon, setHorizon] = useState<Horizon>("week");

  const goal = horizon === "week" ? stats.weeklyGoal : stats.monthlyGoal;

  const math = useMemo(() => {
    const today = laTodayISO();
    const daysLeft =
      horizon === "week" ? remainingWorkdaysInWeek(today) : remainingWorkdaysInMonth(today);
    const earned = horizon === "week" ? earnings.weekEarned : earnings.monthEarned;
    const futureBase = daysLeft * earnings.avgDailyBase;
    const { gap, goalMet } = commissionGap({ goal, earned, futureBase });
    const empty = {
      closeRate: 0,
      sitRate: 0,
      leadDoorRate: 0,
      requiredSales: 0,
      requiredSits: 0,
      requiredLeads: 0,
      requiredKnocks: 0,
      valuePerKnock: 0,
      doorsPerDay: 0,
      talksPerDay: 0,
    };
    const meta = { daysLeft, earned, futureBase, gap };
    if (goalMet) return { ready: true as const, goalMet: true as const, ...empty, ...meta };

    const rates = funnelRates.rates;
    const solve = rates
      ? backSolveFunnel({ incomeGoal: gap, avgCommissionPerSale: stats.avgCommission, rates })
      : null;
    if (!rates || !solve)
      return { ready: false as const, goalMet: false as const, ...empty, ...meta };

    const { closeRate, sitRate, leadDoorRate } = rates;
    const { requiredSales, requiredSits, requiredLeads, requiredDoors: requiredKnocks } = solve;
    // Each remaining knock is worth this much of the remaining gap.
    const valuePerKnock = requiredKnocks > 0 ? gap / requiredKnocks : 0;
    const doorsPerDay = daysLeft > 0 ? requiredKnocks / daysLeft : requiredKnocks;
    const talksPerDay = doorsPerDay * stats.talkDoorRate;

    return {
      ready: true as const,
      goalMet: false as const,
      closeRate,
      sitRate,
      leadDoorRate,
      requiredSales,
      requiredSits,
      requiredLeads,
      requiredKnocks,
      valuePerKnock,
      doorsPerDay,
      talksPerDay,
      ...meta,
    };
  }, [
    horizon,
    goal,
    earnings.weekEarned,
    earnings.monthEarned,
    earnings.avgDailyBase,
    funnelRates.rates,
    stats.avgCommission,
    stats.talkDoorRate,
  ]);

  const saveGoals = useSaveGoals(userId);
  const onSave = (patch: GoalsPatch) =>
    saveGoals.mutate(patch, {
      onSuccess: () => toast.success("Playbook updated · funnel re-engineered"),
      onError: (e: Error) => toast.error(e.message),
    });

  const horizonNoun = horizon === "week" ? "week" : "month";

  return (
    <ArcadePanel
      title="Playbook"
      action={
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          {math.ready
            ? funnelRates.source === "personal"
              ? `Personal rates · ${funnelRates.sampleDoors.toLocaleString()} doors / 60d`
              : "Company avg · 60d baseline"
            : "Awaiting conversion data"}
        </span>
      }
    >
      <div className="space-y-6">
        <HorizonToggle value={horizon} onChange={setHorizon} />

        {math.ready && math.goalMet && (
          <div className="rounded-lg border-2 border-[color-mix(in_oklab,var(--victory)_55%,transparent)] bg-[color-mix(in_oklab,var(--victory)_10%,var(--surface))] p-6 text-center">
            <div className="font-display text-2xl text-victory">
              🏆 {horizon === "week" ? "Weekly" : "Monthly"} goal met
            </div>
            <p className="mt-2 text-sm text-muted-foreground max-w-md mx-auto">
              {formatCurrency(math.earned)} earned of {formatCurrency(goal)} — everything else this{" "}
              {horizonNoun} is gravy.
            </p>
          </div>
        )}

        {/* ===== Equation ===== */}
        {math.ready && !math.goalMet && (
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-3 md:gap-4">
            <EquationTile
              label={horizon === "week" ? "Knocks · This Week" : "Knocks · This Month"}
              value={fmtInt(math.requiredKnocks)}
              accent="var(--neon)"
              icon={<DoorOpen className="w-3.5 h-3.5" />}
            />
            <Operator>×</Operator>
            <EquationTile
              label="Value / Knock"
              value={formatCurrency(math.valuePerKnock)}
              accent="var(--accent)"
              icon={<Sparkles className="w-3.5 h-3.5" />}
            />
            <Operator>=</Operator>
            <EquationTile
              label={horizon === "week" ? "Weekly Income Goal" : "Monthly Income Goal"}
              value={formatCurrency(goal)}
              accent="var(--victory)"
              icon={<Target className="w-3.5 h-3.5" />}
              mega
            />
          </div>
        )}

        {/* ===== Inputs — the ONE goal editor ===== */}
        <GoalEditor
          weeklyGoal={stats.weeklyGoal}
          monthlyGoal={stats.monthlyGoal}
          avgCommission={stats.avgCommission}
          saving={saveGoals.isPending}
          onSave={onSave}
        />

        {!math.ready && (
          <div className="rounded-lg border border-border bg-background/40 p-6 text-center">
            <div className="font-display text-sm uppercase tracking-widest text-muted-foreground">
              Playbook unavailable
            </div>
            <p className="mt-2 text-xs text-muted-foreground max-w-md mx-auto">
              We need conversion data — from your own recent logs (200+ doors knocked) or the
              company-wide 60-day baseline — plus a goal and average commission above.
            </p>
          </div>
        )}

        {/* ===== Funnel tiles ===== */}
        {math.ready && !math.goalMet && (
          <div>
            <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1.5">
              <Zap className="w-3 h-3 text-neon" /> Conversion Funnel · what it takes
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <FunnelTile
                label="Knocks"
                value={fmtInt(math.requiredKnocks)}
                sub={`${(math.leadDoorRate * 100).toFixed(1)}% → lead`}
                accent="#39ff14"
                icon={<DoorOpen className="w-4 h-4" />}
              />
              <FunnelTile
                label="Leads"
                value={fmtInt(math.requiredLeads)}
                sub={`${(math.sitRate * 100).toFixed(0)}% show → sit`}
                accent="#ffd60a"
                icon={<PhoneCall className="w-4 h-4" />}
              />
              <FunnelTile
                label="Sits"
                value={fmtInt(math.requiredSits)}
                sub={`${(math.closeRate * 100).toFixed(0)}% close → sale`}
                accent="#00e5ff"
                icon={<Users className="w-4 h-4" />}
              />
              <FunnelTile
                label="Sales"
                value={fmtInt(math.requiredSales)}
                sub={`${formatCurrency(stats.avgCommission)} avg commission`}
                accent="var(--victory)"
                icon={<Trophy className="w-4 h-4" />}
              />
            </div>
            <div className="mt-3 text-[10px] font-display uppercase tracking-widest text-muted-foreground border-t border-border pt-3 flex justify-between flex-wrap gap-2">
              <span>
                Earned so far · {formatCurrency(math.earned)} of {formatCurrency(goal)}
              </span>
              <span>Projected future base · {formatCurrency(math.futureBase)}</span>
              <span>Gap to close · {formatCurrency(math.gap)}</span>
            </div>
          </div>
        )}

        {/* ===== Daily action ===== */}
        {math.ready && !math.goalMet && (
          <DailyAction
            doorsPerDay={math.doorsPerDay}
            talksPerDay={math.talksPerDay}
            valuePerKnock={math.valuePerKnock}
            requiredKnocks={math.requiredKnocks}
            daysLeft={math.daysLeft}
            goal={goal}
            horizon={horizon}
          />
        )}
      </div>
    </ArcadePanel>
  );
}

function HorizonToggle({ value, onChange }: { value: Horizon; onChange: (h: Horizon) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-surface p-1">
      {(["week", "month"] as const).map((h) => (
        <button
          key={h}
          type="button"
          onClick={() => onChange(h)}
          className={`px-4 py-1.5 rounded-md font-display text-[10px] uppercase tracking-widest transition ${
            value === h
              ? "bg-[color-mix(in_oklab,var(--neon)_15%,transparent)] text-neon shadow-[0_0_18px_-4px_var(--neon)]"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {h === "week" ? "This Week" : "This Month"}
        </button>
      ))}
    </div>
  );
}

function Operator({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex md:block items-center justify-center font-display text-3xl md:text-4xl text-neon/70 select-none"
      style={{ textShadow: "0 0 14px color-mix(in oklab, var(--neon) 60%, transparent)" }}
    >
      {children}
    </div>
  );
}

function EquationTile({
  label,
  value,
  sub,
  accent,
  icon,
  mega = false,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: string;
  icon: React.ReactNode;
  mega?: boolean;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-lg border p-4"
      style={{
        borderColor: `color-mix(in oklab, ${accent} 50%, var(--border))`,
        background: `color-mix(in oklab, ${accent} 8%, var(--surface))`,
        boxShadow: `0 0 22px -10px ${accent}, inset 0 0 24px -12px ${accent}`,
      }}
    >
      <div
        className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest"
        style={{ color: accent }}
      >
        {icon} {label}
      </div>
      <div
        className={`mt-2 font-display leading-none ${mega ? "text-4xl md:text-5xl" : "text-3xl md:text-4xl"}`}
        style={{
          color: accent,
          textShadow: `0 0 18px color-mix(in oklab, ${accent} 65%, transparent)`,
        }}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          {sub}
        </div>
      )}
    </div>
  );
}

function GoalEditor({
  weeklyGoal,
  monthlyGoal,
  avgCommission,
  saving,
  onSave,
}: {
  weeklyGoal: number;
  monthlyGoal: number;
  avgCommission: number;
  saving: boolean;
  onSave: (patch: GoalsPatch) => void;
}) {
  const [weeklyDraft, setWeeklyDraft] = useState(String(weeklyGoal));
  const [monthlyDraft, setMonthlyDraft] = useState(String(monthlyGoal));
  const [commDraft, setCommDraft] = useState(String(avgCommission));
  useEffect(() => {
    setWeeklyDraft(String(weeklyGoal));
  }, [weeklyGoal]);
  useEffect(() => {
    setMonthlyDraft(String(monthlyGoal));
  }, [monthlyGoal]);
  useEffect(() => {
    setCommDraft(String(avgCommission));
  }, [avgCommission]);

  const submit = () => {
    onSave({
      weekly_income_goal: clampGoal(weeklyDraft),
      monthly_goal: clampGoal(monthlyDraft),
      avg_commission: clampCommission(commDraft, DEFAULT_AVG_COMMISSION),
    });
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submit();
  };

  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end rounded-lg border border-border bg-background/40 p-4">
      <Field label="Weekly Income Goal" prefix="$" hint="Week plan">
        <Input
          type="number"
          min={0}
          step={50}
          inputMode="numeric"
          value={weeklyDraft}
          onChange={(e) => setWeeklyDraft(e.target.value)}
          onKeyDown={onEnter}
          className="h-12 pl-7 font-display text-xl bg-background/60 text-neon border-[color-mix(in_oklab,var(--neon)_40%,var(--border))]"
          placeholder="2000"
        />
      </Field>
      <Field label="Monthly Income Goal" prefix="$" hint="Month plan">
        <Input
          type="number"
          min={0}
          step={100}
          inputMode="numeric"
          value={monthlyDraft}
          onChange={(e) => setMonthlyDraft(e.target.value)}
          onKeyDown={onEnter}
          className="h-12 pl-7 font-display text-xl bg-background/60 text-accent border-[color-mix(in_oklab,var(--accent)_40%,var(--border))]"
          placeholder="10000"
        />
      </Field>
      <Field label="Average Commission" prefix="$" hint="Company avg when unset">
        <Input
          type="number"
          min={1}
          step={10}
          inputMode="numeric"
          value={commDraft}
          onChange={(e) => setCommDraft(e.target.value)}
          onKeyDown={onEnter}
          className="h-12 pl-7 font-display text-xl bg-background/60 text-victory border-[color-mix(in_oklab,var(--victory)_40%,var(--border))]"
          placeholder="200"
        />
      </Field>
      <Button
        onClick={submit}
        disabled={saving}
        className="h-12 px-6 font-display uppercase tracking-widest bg-neon/15 hover:bg-neon/25 text-neon border border-neon/50"
        style={{ boxShadow: "0 0 16px -6px var(--neon)" }}
      >
        <Zap className="w-4 h-4 mr-2" /> Recalc
      </Button>
    </div>
  );
}

function Field({
  label,
  prefix,
  hint,
  children,
}: {
  label: string;
  prefix?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center justify-between">
        <span>{label}</span>
        {hint && <span className="opacity-70">{hint}</span>}
      </div>
      <div className="relative">
        {prefix && (
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 font-display text-lg text-muted-foreground pointer-events-none">
            {prefix}
          </span>
        )}
        {children}
      </div>
    </label>
  );
}

function FunnelTile({
  label,
  value,
  sub,
  accent,
  icon,
}: {
  label: string;
  value: string;
  sub: string;
  accent: string;
  icon: React.ReactNode;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-lg border p-4"
      style={{
        borderColor: `color-mix(in oklab, ${accent} 40%, var(--border))`,
        background: `color-mix(in oklab, ${accent} 6%, var(--surface))`,
        boxShadow: `0 0 18px -10px ${accent}, inset 0 0 18px -10px ${accent}`,
      }}
    >
      <div
        className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest"
        style={{ color: accent }}
      >
        {icon} {label}
      </div>
      <div
        className="mt-2 font-display text-3xl leading-none"
        style={{
          color: accent,
          textShadow: `0 0 16px color-mix(in oklab, ${accent} 60%, transparent)`,
        }}
      >
        {value}
      </div>
      <div className="mt-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        {sub}
      </div>
    </div>
  );
}

/** The per-day marching orders — absorbs the old Daily Mission widget:
 *  mission sentence + doors/talks/per-knock-value stat trio. */
function DailyAction({
  doorsPerDay,
  talksPerDay,
  valuePerKnock,
  requiredKnocks,
  daysLeft,
  goal,
  horizon,
}: {
  doorsPerDay: number;
  talksPerDay: number;
  valuePerKnock: number;
  requiredKnocks: number;
  daysLeft: number;
  goal: number;
  horizon: Horizon;
}) {
  const doors = Math.ceil(doorsPerDay);
  const talks = Math.ceil(talksPerDay);
  return (
    <div
      className="relative overflow-hidden rounded-lg border border-[color-mix(in_oklab,var(--accent)_50%,var(--border))] bg-[color-mix(in_oklab,var(--accent)_8%,var(--surface))] p-5"
      style={{ boxShadow: "inset 0 0 30px -10px var(--accent)" }}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-[10px] font-display uppercase tracking-widest text-accent">
          <Calendar className="w-3.5 h-3.5" /> Daily Action ·{" "}
          {horizon === "week" ? "Mon–Sat Plan" : "Rest of Month"}
        </div>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          {daysLeft > 0
            ? `${daysLeft} workday${daysLeft === 1 ? "" : "s"} left`
            : horizon === "week"
              ? "week complete"
              : "month complete"}
        </div>
      </div>

      <div className="mt-4 font-display text-lg md:text-xl text-foreground/90 leading-relaxed">
        To hit <span className="text-victory text-mega-victory">{formatCurrency(goal)}</span>, your
        mission today is to knock{" "}
        <span className="text-neon" style={{ textShadow: "0 0 18px var(--neon)" }}>
          {doors.toLocaleString()} doors
        </span>{" "}
        and talk to{" "}
        <span className="text-accent" style={{ textShadow: "0 0 18px var(--accent)" }}>
          {talks.toLocaleString()} people
        </span>
        .
      </div>

      <div className="mt-5 grid sm:grid-cols-3 gap-4">
        <MissionStat
          icon={<DoorOpen className="w-4 h-4" />}
          label="Doors / Day"
          value={doors.toLocaleString()}
          accent="var(--neon)"
        />
        <MissionStat
          icon={<Users className="w-4 h-4" />}
          label="Talk To / Day"
          value={talks.toLocaleString()}
          accent="var(--accent)"
        />
        <MissionStat
          icon={<DollarSign className="w-4 h-4" />}
          label="Per-Knock Value"
          value={formatCurrency(valuePerKnock)}
          accent="var(--victory)"
        />
      </div>

      <div className="mt-4 text-[10px] font-display uppercase tracking-widest text-muted-foreground border-t border-border/60 pt-3">
        {fmtInt(requiredKnocks)} knocks to close the gap
      </div>
    </div>
  );
}

function MissionStat({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div
      className="rounded-md border p-4"
      style={{
        borderColor: `color-mix(in oklab, ${accent} 40%, var(--border))`,
        background: `color-mix(in oklab, ${accent} 6%, var(--surface))`,
      }}
    >
      <div
        className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest"
        style={{ color: accent }}
      >
        {icon} {label}
      </div>
      <div
        className="mt-2 font-display text-3xl leading-none"
        style={{
          color: accent,
          textShadow: `0 0 16px color-mix(in oklab, ${accent} 60%, transparent)`,
        }}
      >
        {value}
      </div>
    </div>
  );
}
