import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel } from "@/components/arcade";
import { LiveFeed } from "@/components/LiveFeed";
import turfInvadersHero from "@/assets/turf-invaders-hero.png.asset.json";

type Props = {
  /** Restrict to a single van (Captain view). Omit for company-wide. */
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
  const day = d.getDay() === 0 ? 7 : d.getDay();
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
        const hadActivity = (r.leads_called_in ?? 0) + (r.confirmed_leads ?? 0)
          + (r.demos_sits ?? 0) + (r.sales ?? 0) > 0;
        if (hadActivity) daySet.add(`${r.canvasser_id}|${r.log_date}`);
      }
      return { confirmedLeads, leadsCalledIn, demosSits, sales, noShows, daysWorked: daySet.size };
    },
  });

  const t = totals.data ?? { confirmedLeads: 0, leadsCalledIn: 0, demosSits: 0, sales: 0, noShows: 0, daysWorked: 0 };
  const points = t.demosSits + t.sales;
  const pace = t.daysWorked > 0 ? t.confirmedLeads / t.daysWorked : 0;
  const sitRate = t.confirmedLeads > 0 ? (t.demosSits / t.confirmedLeads) * 100 : 0;
  const closeRate = t.demosSits > 0 ? (t.sales / t.demosSits) * 100 : 0;
  const noShowRate = t.confirmedLeads > 0 ? (t.noShows / t.confirmedLeads) * 100 : 0;

  const rows: Array<[string, string]> = [
    ["Confirmed Leads", t.confirmedLeads.toLocaleString()],
    ["Leads Called In", t.leadsCalledIn.toLocaleString()],
    ["Sits (Demos)", t.demosSits.toLocaleString()],
    ["Sales", t.sales.toLocaleString()],
    ["No Shows", t.noShows.toLocaleString()],
    ["Total Points", points.toLocaleString()],
    ["Days Worked", t.daysWorked.toLocaleString()],
    ["Pace (leads/day)", pace.toFixed(1)],
    ["Sit Rate", `${sitRate.toFixed(0)}%`],
    ["Close Rate", `${closeRate.toFixed(0)}%`],
    ["No-Show Rate", `${noShowRate.toFixed(0)}%`],
  ];

  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-lg border border-[var(--neon)]/40 shadow-[0_0_32px_-8px_var(--neon)]">
        <img src={turfInvadersHero.url} alt="Turf Invaders" className="w-full h-40 sm:h-56 object-cover object-center" />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/30 to-transparent" />
        <div className="absolute bottom-3 left-4">
          <div className="font-display text-[10px] uppercase tracking-[0.25em] text-[var(--accent)]">Turf Invaders</div>
          <div className="font-display text-sm text-neon">Command Center</div>
        </div>
      </div>
      <LiveFeed />
      <ArcadePanel
        title="Command Center"
        action={
          <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Week to Date
          </span>
        }
      >
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label} className="border-b border-border/40 last:border-0">
                <td className="py-2.5 text-muted-foreground">{label}</td>
                <td className="py-2.5 text-right font-display text-foreground">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ArcadePanel>
    </div>
  );
}
