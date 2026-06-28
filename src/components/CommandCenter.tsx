import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel } from "@/components/arcade";
import { LiveFeed } from "@/components/LiveFeed";
import { Gauge, Zap, Target, DoorClosed, TrendingUp } from "lucide-react";

type Props = {
  /** Restrict to a single van (Captain view). Omit for company-wide (Owner). */
  teamId?: string | null;
};

type WeekTotals = {
  confirmedLeads: number;
  leadsCalledIn: number;
  demosSits: number;
  sales: number;
  noShows: number;
  daysWorked: number;
};

function startOfISOWeek(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay() === 0 ? 7 : d.getDay(); // Mon=1..Sun=7
  d.setDate(d.getDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

export function CommandCenter({ teamId }: Props) {
  const totals = useQuery({
    queryKey: ["command_center", teamId ?? "all"],
    queryFn: async (): Promise<WeekTotals> => {
      const since = startOfISOWeek();
      let q = supabase
        .from("daily_logs")
        .select("canvasser_id, log_date, leads_called_in, confirmed_leads, demos_sits, sales, no_shows")
        .gte("log_date", since);
      if (teamId) q = q.eq("team_id", teamId);
      const { data, error } = await q;
      if (error) throw error;

      const rows = data ?? [];
      const daySet = new Set<string>();
      let confirmedLeads = 0, leadsCalledIn = 0, demosSits = 0, sales = 0, noShows = 0;
      for (const r of rows) {
        confirmedLeads += r.confirmed_leads ?? 0;
        leadsCalledIn += r.leads_called_in ?? 0;
        demosSits += r.demos_sits ?? 0;
        sales += r.sales ?? 0;
        noShows += r.no_shows ?? 0;
        // count distinct (canvasser, day) entries with ANY activity as "worked"
        const hadActivity = (r.leads_called_in ?? 0) + (r.confirmed_leads ?? 0)
          + (r.demos_sits ?? 0) + (r.sales ?? 0) > 0;
        if (hadActivity) daySet.add(`${r.canvasser_id}|${r.log_date}`);
      }
      return {
        confirmedLeads, leadsCalledIn, demosSits, sales, noShows,
        daysWorked: daySet.size,
      };
    },
  });

  const t = totals.data ?? { confirmedLeads: 0, leadsCalledIn: 0, demosSits: 0, sales: 0, noShows: 0, daysWorked: 0 };
  const pace = t.daysWorked > 0 ? t.confirmedLeads / t.daysWorked : 0;
  const sitRate = t.confirmedLeads > 0 ? Math.min(1, t.demosSits / t.confirmedLeads) : 0;
  const closeRate = t.demosSits > 0 ? Math.min(1, t.sales / t.demosSits) : 0;
  const noShowRate = t.confirmedLeads > 0 ? Math.min(1, t.noShows / t.confirmedLeads) : 0;

  return (
    <div className="space-y-4">
      <LiveFeed />
      <ArcadePanel
        title="Command Center"
        action={
          <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Week to Date · Live
          </span>
        }
      >
        <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        {/* Volume + Pace */}
        <div className="grid gap-6 md:grid-cols-2">
          <VolumeTile value={t.confirmedLeads} />
          <PaceGauge value={pace} max={Math.max(20, Math.ceil(pace * 1.4))} />
        </div>

        {/* Conversion Trinity */}
        <div className="grid grid-cols-3 gap-3">
          <Donut label="Sit Rate"     value={sitRate}    color="var(--neon)"    icon={<Target className="w-3.5 h-3.5" />} />
          <Donut label="Close Rate"   value={closeRate}  color="var(--victory)" icon={<TrendingUp className="w-3.5 h-3.5" />} />
          <Donut label="No-Show Rate" value={noShowRate} color="var(--destructive)" icon={<DoorClosed className="w-3.5 h-3.5" />} invert />
        </div>
        </div>
      </ArcadePanel>
    </div>
  );
}

/* ============ Volume ============ */
function VolumeTile({ value }: { value: number }) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-[color-mix(in_oklab,var(--victory)_6%,var(--surface))] p-6">
      <div className="absolute inset-0 scanlines opacity-40 pointer-events-none" />
      <div className="relative">
        <div className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          <Zap className="w-3 h-3 text-victory" /> Total Confirmed · This Week
        </div>
        <div className="mt-3 font-display text-5xl md:text-6xl text-mega-victory leading-none">
          {value.toLocaleString().padStart(3, "0")}
        </div>
        <div className="mt-3 text-[10px] font-display uppercase tracking-widest text-victory/80">
          LEADS LOCKED IN
        </div>
      </div>
    </div>
  );
}

/* ============ Pace gauge (semi-circular neon) ============ */
function PaceGauge({ value, max }: { value: number; max: number }) {
  const pct = Math.max(0, Math.min(1, value / max));
  const R = 70;
  const C = Math.PI * R; // half circle circumference
  const dash = C * pct;
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-surface p-6">
      <div className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        <Gauge className="w-3 h-3 text-neon" /> Pace · Leads / Day
      </div>
      <div className="mt-2 grid place-items-center">
        <svg viewBox="0 0 180 110" className="w-full max-w-[240px]">
          <defs>
            <linearGradient id="pace-grad" x1="0" x2="1">
              <stop offset="0%" stopColor="var(--neon)" />
              <stop offset="60%" stopColor="var(--victory)" />
              <stop offset="100%" stopColor="var(--accent)" />
            </linearGradient>
            <filter id="pace-glow"><feGaussianBlur stdDeviation="2.5" /></filter>
          </defs>
          {/* track */}
          <path d="M 20 100 A 70 70 0 0 1 160 100"
            fill="none" stroke="color-mix(in oklab, var(--neon) 12%, transparent)" strokeWidth="14" strokeLinecap="round" />
          {/* glow under */}
          <path d="M 20 100 A 70 70 0 0 1 160 100"
            fill="none" stroke="url(#pace-grad)" strokeWidth="14" strokeLinecap="round"
            strokeDasharray={`${dash} ${C}`} filter="url(#pace-glow)" opacity="0.55" />
          {/* main */}
          <path d="M 20 100 A 70 70 0 0 1 160 100"
            fill="none" stroke="url(#pace-grad)" strokeWidth="14" strokeLinecap="round"
            strokeDasharray={`${dash} ${C}`}
            style={{ transition: "stroke-dasharray 700ms cubic-bezier(.2,.7,.2,1)" }} />
          {/* needle */}
          <g transform={`rotate(${-90 + pct * 180} 90 100)`}>
            <line x1="90" y1="100" x2="90" y2="38"
              stroke="var(--foreground)" strokeWidth="2" strokeLinecap="round"
              style={{ transition: "transform 700ms cubic-bezier(.2,.7,.2,1)" }} />
            <circle cx="90" cy="100" r="5" fill="var(--neon)" />
          </g>
        </svg>
      </div>
      <div className="text-center -mt-2">
        <div className="font-display text-3xl text-neon leading-none">{value.toFixed(1)}</div>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mt-1">
          / day · target {max}
        </div>
      </div>
    </div>
  );
}

/* ============ Donut ============ */
function Donut({
  label, value, color, icon, invert = false,
}: { label: string; value: number; color: string; icon: React.ReactNode; invert?: boolean }) {
  const R = 36;
  const C = 2 * Math.PI * R;
  const dash = C * value;
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-surface p-4 flex flex-col items-center text-center">
      <div className="flex items-center gap-1 text-[9px] font-display uppercase tracking-widest text-muted-foreground" style={{ color }}>
        {icon} {label}
      </div>
      <div className="relative my-2">
        <svg viewBox="0 0 100 100" className="w-24 h-24 -rotate-90">
          <defs>
            <filter id={`donut-glow-${label}`}><feGaussianBlur stdDeviation="1.8" /></filter>
          </defs>
          <circle cx="50" cy="50" r={R}
            stroke="color-mix(in oklab, var(--foreground) 8%, transparent)"
            strokeWidth="10" fill="none" />
          <circle cx="50" cy="50" r={R}
            stroke={color} strokeWidth="10" strokeLinecap="round" fill="none"
            strokeDasharray={`${dash} ${C}`}
            filter={`url(#donut-glow-${label})`} opacity="0.5" />
          <circle cx="50" cy="50" r={R}
            stroke={color} strokeWidth="10" strokeLinecap="round" fill="none"
            strokeDasharray={`${dash} ${C}`}
            style={{ transition: "stroke-dasharray 700ms cubic-bezier(.2,.7,.2,1)" }} />
        </svg>
        <div className="absolute inset-0 grid place-items-center">
          <div className="font-display text-base" style={{ color }}>
            {(value * 100).toFixed(0)}%
          </div>
        </div>
      </div>
      <div className="text-[9px] text-muted-foreground">
        {invert ? "Lower is better" : "Higher is better"}
      </div>
    </div>
  );
}
