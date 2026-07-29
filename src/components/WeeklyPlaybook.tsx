import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency } from "@/lib/utils";
import { laTodayISO, laWeekStartISO, addDaysISO, remainingWorkdaysInWeek } from "@/lib/dates";
import { backSolveFunnel } from "@/lib/funnel";
import { useFunnelRates, useProfileGoals } from "@/hooks/useFunnelRates";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Zap, Target, DoorOpen, PhoneCall, Users, Trophy, Calendar, Sparkles } from "lucide-react";

/**
 * Weekly Playbook — runs on the SHARED funnel engine (useFunnelRates), the
 * same rates the monthly Mission uses, so the two can never contradict.
 * Equation: [Knocks] × $[Value/Knock] = $[Income Goal]
 * Funnel:   Goal ÷ AvgCommission = Sales → ÷Close = Sits → ÷Show = Leads → ÷Contact = Knocks
 * Daily:    knocks REMAINING this week ÷ remaining Mon–Sat workdays
 *           (owner, 2026-07-29 — progress counts down, weeks are Mon–Sat).
 */

const DEFAULT_AVG_COMMISSION = 200;
const DEFAULT_WEEKLY_GOAL = 2000;

function fmtInt(n: number) {
  if (!isFinite(n)) return "—";
  return Math.ceil(n).toLocaleString();
}

export function WeeklyPlaybook({ userId }: { userId: string }) {
  const qc = useQueryClient();

  const goalsQuery = useProfileGoals(userId);
  const weeklyGoal = Number(goalsQuery.data?.weekly_income_goal ?? DEFAULT_WEEKLY_GOAL);
  const avgCommission = Number(goalsQuery.data?.avg_commission ?? DEFAULT_AVG_COMMISSION) || DEFAULT_AVG_COMMISSION;

  // Rates come from the shared engine — identical to the monthly Mission's.
  const funnelRates = useFunnelRates(userId);

  // This week's own knocks (Mon–Sat) — the plan counts DOWN as they log.
  const weekStart = laWeekStartISO();
  const weekProgressQuery = useQuery({
    queryKey: ["funnel", "week-progress", userId, weekStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("daily_logs")
        .select("doors_knocked")
        .eq("canvasser_id", userId)
        .gte("log_date", weekStart)
        .lte("log_date", addDaysISO(weekStart, 5));
      if (error) throw error;
      return (data ?? []).reduce((a, r) => a + (r.doors_knocked ?? 0), 0);
    },
  });
  const weekDoors = weekProgressQuery.data ?? 0;

  const math = useMemo(() => {
    const rates = funnelRates.rates;
    const solve = rates
      ? backSolveFunnel({ incomeGoal: weeklyGoal, avgCommissionPerSale: avgCommission, rates })
      : null;
    if (!rates || !solve) {
      return {
        ready: false as const,
        closeRate: 0, sitRate: 0, leadDoorRate: 0,
        requiredSales: 0, requiredSits: 0, requiredLeads: 0, requiredKnocks: 0,
        valuePerKnock: 0, doorsPerDay: 0, knocksRemaining: 0, daysLeft: 0,
      };
    }
    const { closeRate, sitRate, leadDoorRate } = rates;
    const { requiredSales, requiredSits, requiredLeads, requiredDoors: requiredKnocks } = solve;
    const valuePerKnock = requiredKnocks > 0 ? weeklyGoal / requiredKnocks : 0;
    // Remaining-per-day: subtract this week's knocks, divide by the Mon–Sat
    // days left (0 on Sunday → show the full remainder).
    const knocksRemaining = Math.max(0, requiredKnocks - weekDoors);
    const daysLeft = remainingWorkdaysInWeek(laTodayISO());
    const doorsPerDay = daysLeft > 0 ? knocksRemaining / daysLeft : knocksRemaining;

    return {
      ready: true as const,
      closeRate, sitRate, leadDoorRate,
      requiredSales, requiredSits, requiredLeads, requiredKnocks,
      valuePerKnock, doorsPerDay, knocksRemaining, daysLeft,
    };
  }, [funnelRates.rates, weeklyGoal, avgCommission, weekDoors]);

  const save = useMutation({
    mutationFn: async (patch: { weekly_income_goal?: number; avg_commission?: number }) => {
      const { error } = await supabase.from("profiles").update(patch).eq("id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Playbook updated · funnel re-engineered");
      qc.invalidateQueries({ queryKey: ["profile_goals", userId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="relative overflow-hidden rounded-xl border border-[color-mix(in_oklab,var(--neon)_45%,var(--border))] bg-[linear-gradient(140deg,color-mix(in_oklab,var(--neon)_8%,var(--surface)),color-mix(in_oklab,var(--victory)_6%,var(--surface)))] p-6 md:p-7">
      <div className="absolute inset-0 pointer-events-none scanlines opacity-25" />
      <div className="absolute -inset-1 pointer-events-none rounded-xl opacity-60" style={{ boxShadow: "inset 0 0 80px -16px var(--neon)" }} />

      <div className="relative space-y-6">
        <header className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 text-[10px] font-display uppercase tracking-[0.25em] text-neon">
            <Trophy className="w-3.5 h-3.5" /> Your Weekly Playbook
          </div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            {math.ready
              ? funnelRates.source === "personal"
                ? "Personal rates · your last 60 days"
                : "Company avg · 60d baseline"
              : "Awaiting conversion data"}
          </div>
        </header>

        {/* ===== Equation ===== */}
        {math.ready && (
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-3 md:gap-4">
          <EquationTile
            label="Knocks · This Week"
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
            label="Income Goal"
            value={formatCurrency(weeklyGoal)}
            accent="var(--victory)"
            icon={<Target className="w-3.5 h-3.5" />}
            mega
          />
        </div>
        )}

        {/* ===== Inputs ===== */}
        <GoalInputs
          weeklyGoal={weeklyGoal}
          avgCommission={avgCommission}
          saving={save.isPending}
          onSave={(p) => save.mutate(p)}
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
        {math.ready && (
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
              sub={`${formatCurrency(avgCommission)} avg commission`}
              accent="var(--victory)"
              icon={<Trophy className="w-4 h-4" />}
            />
          </div>
        </div>
        )}

        {/* ===== Daily action ===== */}
        {math.ready && (
          <DailyAction
            doorsPerDay={math.doorsPerDay}
            knocksRemaining={math.knocksRemaining}
            daysLeft={math.daysLeft}
          />
        )}
      </div>
    </section>
  );
}

function Operator({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex md:block items-center justify-center font-display text-3xl md:text-4xl text-neon/70 select-none"
         style={{ textShadow: "0 0 14px color-mix(in oklab, var(--neon) 60%, transparent)" }}>
      {children}
    </div>
  );
}

function EquationTile({
  label, value, accent, icon, mega = false,
}: { label: string; value: string; accent: string; icon: React.ReactNode; mega?: boolean }) {
  return (
    <div
      className="relative overflow-hidden rounded-lg border p-4"
      style={{
        borderColor: `color-mix(in oklab, ${accent} 50%, var(--border))`,
        background: `color-mix(in oklab, ${accent} 8%, var(--surface))`,
        boxShadow: `0 0 22px -10px ${accent}, inset 0 0 24px -12px ${accent}`,
      }}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest" style={{ color: accent }}>
        {icon} {label}
      </div>
      <div
        className={`mt-2 font-display leading-none ${mega ? "text-4xl md:text-5xl" : "text-3xl md:text-4xl"}`}
        style={{ color: accent, textShadow: `0 0 18px color-mix(in oklab, ${accent} 65%, transparent)` }}
      >
        {value}
      </div>
    </div>
  );
}

function GoalInputs({
  weeklyGoal, avgCommission, saving, onSave,
}: {
  weeklyGoal: number; avgCommission: number; saving: boolean;
  onSave: (patch: { weekly_income_goal?: number; avg_commission?: number }) => void;
}) {
  const [goalDraft, setGoalDraft] = useState(String(weeklyGoal));
  const [commDraft, setCommDraft] = useState(String(avgCommission));
  useEffect(() => { setGoalDraft(String(weeklyGoal)); }, [weeklyGoal]);
  useEffect(() => { setCommDraft(String(avgCommission)); }, [avgCommission]);

  const submit = () => {
    const g = Math.max(0, Math.round(Number(goalDraft) || 0));
    const c = Math.max(1, Math.round(Number(commDraft) || DEFAULT_AVG_COMMISSION));
    onSave({ weekly_income_goal: g, avg_commission: c });
  };

  return (
    <div className="grid sm:grid-cols-[1fr_1fr_auto] gap-3 items-end rounded-lg border border-border bg-background/40 p-4">
      <Field label="Weekly Income Goal" prefix="$">
        <Input
          type="number" min={0} step={50} inputMode="numeric"
          value={goalDraft}
          onChange={(e) => setGoalDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          className="h-12 pl-7 font-display text-xl bg-background/60 text-neon border-[color-mix(in_oklab,var(--neon)_40%,var(--border))]"
          placeholder="2000"
        />
      </Field>
      <Field label="Average Commission" prefix="$" hint="Defaults to $200">
        <Input
          type="number" min={1} step={10} inputMode="numeric"
          value={commDraft}
          onChange={(e) => setCommDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
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

function Field({ label, prefix, hint, children }: { label: string; prefix?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center justify-between">
        <span>{label}</span>
        {hint && <span className="opacity-70">{hint}</span>}
      </div>
      <div className="relative">
        {prefix && <span className="absolute left-2.5 top-1/2 -translate-y-1/2 font-display text-lg text-muted-foreground pointer-events-none">{prefix}</span>}
        {children}
      </div>
    </label>
  );
}

function FunnelTile({
  label, value, sub, accent, icon,
}: { label: string; value: string; sub: string; accent: string; icon: React.ReactNode }) {
  return (
    <div
      className="relative overflow-hidden rounded-lg border p-4"
      style={{
        borderColor: `color-mix(in oklab, ${accent} 40%, var(--border))`,
        background: `color-mix(in oklab, ${accent} 6%, var(--surface))`,
        boxShadow: `0 0 18px -10px ${accent}, inset 0 0 18px -10px ${accent}`,
      }}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest" style={{ color: accent }}>
        {icon} {label}
      </div>
      <div
        className="mt-2 font-display text-3xl leading-none"
        style={{ color: accent, textShadow: `0 0 16px color-mix(in oklab, ${accent} 60%, transparent)` }}
      >
        {value}
      </div>
      <div className="mt-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">{sub}</div>
    </div>
  );
}

function DailyAction({
  doorsPerDay, knocksRemaining, daysLeft,
}: { doorsPerDay: number; knocksRemaining: number; daysLeft: number }) {
  return (
    <div
      className="relative overflow-hidden rounded-lg border border-[color-mix(in_oklab,var(--accent)_50%,var(--border))] bg-[color-mix(in_oklab,var(--accent)_8%,var(--surface))] p-5"
      style={{ boxShadow: "inset 0 0 30px -10px var(--accent)" }}
    >
      <div className="flex items-center gap-2 text-[10px] font-display uppercase tracking-widest text-accent">
        <Calendar className="w-3.5 h-3.5" /> Daily Action · Mon–Sat Plan
      </div>
      <div className="mt-2 flex items-end gap-3 flex-wrap">
        <div className="font-display text-4xl md:text-5xl text-accent leading-none"
             style={{ textShadow: "0 0 18px color-mix(in oklab, var(--accent) 65%, transparent)" }}>
          {fmtInt(doorsPerDay)}
        </div>
        <div className="text-sm text-muted-foreground pb-1">
          doors / day · {daysLeft > 0 ? `${daysLeft} workday${daysLeft === 1 ? "" : "s"} left this week` : "week complete"}  →{"  "}
          <span className="text-foreground">{fmtInt(knocksRemaining)} remaining</span>
        </div>
      </div>
    </div>
  );
}
