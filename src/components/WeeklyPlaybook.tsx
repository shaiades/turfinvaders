import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Zap, Target, DoorOpen, PhoneCall, Users, Trophy, Calendar, Sparkles } from "lucide-react";

/**
 * Weekly Playbook
 * Equation: [Knocks] × $[Value/Knock] = $[Income Goal]
 * Funnel:   Goal / AvgCommission = Sales → /Close = Sits → /Show = Leads → /Contact = Knocks
 * Daily:    Knocks / 5
 */

const WORK_DAYS = 5;
const DEFAULT_AVG_COMMISSION = 200;
const DEFAULT_WEEKLY_GOAL = 2000;

// Industry-typical fallbacks when canvasser has no history
const FALLBACK_CLOSE_RATE = 0.35;     // sales / sits
const FALLBACK_SIT_RATE = 0.5;        // sits / leads (show rate)
const FALLBACK_LEAD_DOOR_RATE = 0.05; // leads / knocks (contact-to-lead)

function fmtUSD(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function fmtInt(n: number) {
  if (!isFinite(n)) return "—";
  return Math.ceil(n).toLocaleString();
}

export function WeeklyPlaybook({ userId }: { userId: string }) {
  const qc = useQueryClient();

  const profileQuery = useQuery({
    queryKey: ["playbook_profile", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("weekly_income_goal, avg_commission")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw error;
      return data as { weekly_income_goal: number | null; avg_commission: number | null } | null;
    },
  });

  const weeklyGoal = Number(profileQuery.data?.weekly_income_goal ?? DEFAULT_WEEKLY_GOAL);
  const avgCommission = Number(profileQuery.data?.avg_commission ?? DEFAULT_AVG_COMMISSION) || DEFAULT_AVG_COMMISSION;

  // Personal conversion rates from last 60 days
  const ratesQuery = useQuery({
    queryKey: ["playbook_rates", userId],
    queryFn: async () => {
      const since = new Date(); since.setHours(0,0,0,0); since.setDate(since.getDate() - 60);
      const [logsRes, companyLogsRes] = await Promise.all([
        supabase.from("daily_logs")
          .select("doors_knocked, confirmed_leads, demos_sits, sales")
          .eq("canvasser_id", userId)
          .gte("log_date", since.toISOString().slice(0, 10)),
        supabase.from("daily_logs")
          .select("doors_knocked, confirmed_leads, demos_sits, sales")
          .gte("log_date", since.toISOString().slice(0, 10)),
      ]);
      const agg = (rows: Array<Record<string, number | null>> | null) => {
        const t = { doors: 0, leads: 0, sits: 0, sales: 0 };
        for (const r of rows ?? []) {
          t.doors += r.doors_knocked ?? 0;
          t.leads += r.confirmed_leads ?? 0;
          t.sits  += r.demos_sits ?? 0;
          t.sales += r.sales ?? 0;
        }
        return t;
      };
      return { personal: agg(logsRes.data), company: agg(companyLogsRes.data) };
    },
  });

  const math = useMemo(() => {
    const personal = ratesQuery.data?.personal ?? { doors: 0, leads: 0, sits: 0, sales: 0 };
    const company  = ratesQuery.data?.company  ?? { doors: 0, leads: 0, sits: 0, sales: 0 };
    const usePersonal = personal.doors >= 200 && personal.sits >= 5;
    const src = usePersonal ? personal : company;

    const closeRate    = src.sits  > 0 ? src.sales / src.sits  : FALLBACK_CLOSE_RATE;
    const sitRate      = src.leads > 0 ? src.sits  / src.leads : FALLBACK_SIT_RATE;
    const leadDoorRate = src.doors > 0 ? src.leads / src.doors : FALLBACK_LEAD_DOOR_RATE;

    const requiredSales = avgCommission > 0 ? weeklyGoal / avgCommission : 0;
    const requiredSits  = closeRate > 0 ? requiredSales / closeRate : 0;
    const requiredLeads = sitRate   > 0 ? requiredSits  / sitRate   : 0;
    const requiredKnocks = leadDoorRate > 0 ? requiredLeads / leadDoorRate : 0;
    const valuePerKnock = requiredKnocks > 0 ? weeklyGoal / requiredKnocks : 0;
    const doorsPerDay = requiredKnocks / WORK_DAYS;

    return {
      usePersonal, closeRate, sitRate, leadDoorRate,
      requiredSales, requiredSits, requiredLeads, requiredKnocks,
      valuePerKnock, doorsPerDay,
    };
  }, [ratesQuery.data, weeklyGoal, avgCommission]);

  const save = useMutation({
    mutationFn: async (patch: { weekly_income_goal?: number; avg_commission?: number }) => {
      const { error } = await supabase.from("profiles").update(patch).eq("id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Playbook updated · funnel re-engineered");
      qc.invalidateQueries({ queryKey: ["playbook_profile", userId] });
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
            {math.usePersonal ? "Personal historical rates" : "Company-average rates (new player)"}
          </div>
        </header>

        {/* ===== Equation ===== */}
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-3 md:gap-4">
          <EquationTile
            label="Total Knocks"
            value={fmtInt(math.requiredKnocks)}
            accent="var(--neon)"
            icon={<DoorOpen className="w-3.5 h-3.5" />}
          />
          <Operator>×</Operator>
          <EquationTile
            label="Value / Knock"
            value={fmtUSD(math.valuePerKnock)}
            accent="var(--accent)"
            icon={<Sparkles className="w-3.5 h-3.5" />}
          />
          <Operator>=</Operator>
          <EquationTile
            label="Income Goal"
            value={fmtUSD(weeklyGoal)}
            accent="var(--victory)"
            icon={<Target className="w-3.5 h-3.5" />}
            mega
          />
        </div>

        {/* ===== Inputs ===== */}
        <GoalInputs
          weeklyGoal={weeklyGoal}
          avgCommission={avgCommission}
          saving={save.isPending}
          onSave={(p) => save.mutate(p)}
        />

        {/* ===== Funnel tiles ===== */}
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
              sub={`${fmtUSD(avgCommission)} avg commission`}
              accent="var(--victory)"
              icon={<Trophy className="w-4 h-4" />}
            />
          </div>
        </div>

        {/* ===== Daily action ===== */}
        <DailyAction doorsPerDay={math.doorsPerDay} totalKnocks={math.requiredKnocks} />
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

function DailyAction({ doorsPerDay, totalKnocks }: { doorsPerDay: number; totalKnocks: number }) {
  return (
    <div
      className="relative overflow-hidden rounded-lg border border-[color-mix(in_oklab,var(--accent)_50%,var(--border))] bg-[color-mix(in_oklab,var(--accent)_8%,var(--surface))] p-5"
      style={{ boxShadow: "inset 0 0 30px -10px var(--accent)" }}
    >
      <div className="flex items-center gap-2 text-[10px] font-display uppercase tracking-widest text-accent">
        <Calendar className="w-3.5 h-3.5" /> Daily Action · 5-Day Plan
      </div>
      <div className="mt-2 flex items-end gap-3 flex-wrap">
        <div className="font-display text-4xl md:text-5xl text-accent leading-none"
             style={{ textShadow: "0 0 18px color-mix(in oklab, var(--accent) 65%, transparent)" }}>
          {fmtInt(doorsPerDay)}
        </div>
        <div className="text-sm text-muted-foreground pb-1">
          doors / day · for 5 days  →  <span className="text-foreground">{fmtInt(totalKnocks)} total</span>
        </div>
      </div>
    </div>
  );
}
