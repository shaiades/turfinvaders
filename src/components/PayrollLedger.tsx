import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { CalendarIcon, Download } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, TeamBadge } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RankPill } from "@/components/RankPill";
import { useOfficeFilter } from "@/components/OfficeFilterContext";
import { cn } from "@/lib/utils";

type LogRow = {
  canvasser_id: string;
  team_id: string | null;
  no_demo: number;
  one_legs: number;
  future_leads: number;
  demos_sits: number;
  sales: number;
};

type LeadRow = {
  canvasser_id: string;
  sale_amount: number | null;
  status: string;
  reviewed_at: string | null;
  created_at: string;
};

function weekStartOf(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay(); // 0 Sun..6 Sat
  const diffToMon = (day + 6) % 7;
  x.setDate(x.getDate() - diffToMon);
  return x;
}

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

function payRate(points: number) {
  if (points >= 7) return 35;
  if (points >= 3) return 30;
  return 18;
}

function commissionRate(points: number) {
  return points >= 7 ? 0.02 : 0.01;
}

const ASSUMED_HOURS = 37.5;

type Agg = {
  bo: number;
  ol: number;
  rs: number;
  pm: number;
  sales: number;
  total: number;
  sits: number; // PM + Sale
  points: number;
  sale_amount: number;
};

function emptyAgg(): Agg {
  return { bo: 0, ol: 0, rs: 0, pm: 0, sales: 0, total: 0, sits: 0, points: 0, sale_amount: 0 };
}

export function PayrollLedger() {
  const { matches, office } = useOfficeFilter();
  const [weekStart, setWeekStart] = useState<Date>(() => {
    // Default to last week
    const lastWk = new Date();
    lastWk.setDate(lastWk.getDate() - 7);
    return weekStartOf(lastWk);
  });
  const [pickerOpen, setPickerOpen] = useState(false);

  const weekEnd = useMemo(() => {
    const e = new Date(weekStart);
    e.setDate(e.getDate() + 5); // Mon..Sat
    return e;
  }, [weekStart]);

  const startStr = iso(weekStart);
  const endStr = iso(weekEnd);

  const { data, isLoading } = useQuery({
    queryKey: ["payroll-ledger", startStr, endStr],
    queryFn: async () => {
      const [logsRes, leadsRes, profilesRes, teamsRes, timeRes] = await Promise.all([
        supabase
          .from("daily_logs")
          .select("canvasser_id, team_id, no_demo, one_legs, future_leads, demos_sits, sales, log_date")
          .gte("log_date", startStr)
          .lte("log_date", endStr),
        supabase
          .from("leads")
          .select("canvasser_id, sale_amount, status, reviewed_at, created_at")
          .eq("status", "confirmed")
          .gte("created_at", `${startStr}T00:00:00Z`)
          .lte("created_at", `${endStr}T23:59:59Z`),
        supabase.from("profiles").select("id, display_name, team_id, current_rank, office_location"),
        supabase.from("teams").select("id, name, color"),
        supabase
          .from("time_entries")
          .select("user_id, billable_hours, log_date, clock_out")
          .gte("log_date", startStr)
          .lte("log_date", endStr)
          .not("clock_out", "is", null),
      ]);
      if (logsRes.error) throw logsRes.error;
      if (leadsRes.error) throw leadsRes.error;
      if (profilesRes.error) throw profilesRes.error;
      if (teamsRes.error) throw teamsRes.error;
      if (timeRes.error) throw timeRes.error;
      return {
        logs: (logsRes.data ?? []) as LogRow[],
        leads: (leadsRes.data ?? []) as LeadRow[],
        profiles: profilesRes.data ?? [],
        teams: teamsRes.data ?? [],
        timeEntries: (timeRes.data ?? []) as { user_id: string; billable_hours: number }[],
      };
    },
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const profileById = new Map(data.profiles.map((p) => [p.id, p]));
    const teamById = new Map(data.teams.map((t) => [t.id, t]));
    const aggByCanv = new Map<string, Agg>();

    for (const r of data.logs) {
      const a = aggByCanv.get(r.canvasser_id) ?? emptyAgg();
      const pmOnly = Math.max(0, (r.demos_sits ?? 0) - (r.sales ?? 0));
      a.bo += r.no_demo ?? 0;
      a.ol += r.one_legs ?? 0;
      a.rs += r.future_leads ?? 0;
      a.pm += pmOnly;
      a.sales += r.sales ?? 0;
      a.sits += r.demos_sits ?? 0; // demos_sits already includes sales (every sale is a sit)
      a.points += (r.demos_sits ?? 0) + (r.sales ?? 0);
      aggByCanv.set(r.canvasser_id, a);
    }

    for (const l of data.leads) {
      const a = aggByCanv.get(l.canvasser_id) ?? emptyAgg();
      a.sale_amount += Number(l.sale_amount ?? 0);
      aggByCanv.set(l.canvasser_id, a);
    }

    const hoursByCanv = new Map<string, number>();
    for (const t of data.timeEntries) {
      hoursByCanv.set(t.user_id, (hoursByCanv.get(t.user_id) ?? 0) + Number(t.billable_hours ?? 0));
    }

    return Array.from(aggByCanv.entries())
      .map(([cid, a]) => {
        a.total = a.bo + a.ol + a.rs + a.pm + a.sales;
        const profile = profileById.get(cid);
        const team = profile?.team_id ? teamById.get(profile.team_id) : null;
        const rank = (profile as any)?.current_rank ?? "Jr. Silver";
        const isDiamondLock = rank === "Jr. Diamond" || rank === "Sr. Diamond" || rank === "Captain";
        const isSrGoldPlus = isDiamondLock || rank === "Sr. Gold";
        const rate = isDiamondLock ? 35 : payRate(a.points);
        const commRate = isDiamondLock ? 0.02 : commissionRate(a.points);
        const sitBonusPer = isSrGoldPlus ? 75 : 50;
        const clocked = hoursByCanv.get(cid) ?? 0;
        const hours = clocked > 0 ? clocked : ASSUMED_HOURS;
        const hoursSource: "clocked" | "estimated" = clocked > 0 ? "clocked" : "estimated";
        const base = hours * rate;
        const commission = a.sale_amount * commRate;
        const sitBonus = Math.max(0, a.sits - 3) * sitBonusPer;
        const monster = a.points >= 10 ? 500 : 0;
        const bonuses = sitBonus + monster;
        const total = base + commission + bonuses;
        return {
          id: cid,
          name: profile?.display_name ?? "Unknown",
          team,
          rank,
          ...a,
          hours,
          hoursSource,
          rate,
          commRate,
          base,
          commission,
          sitBonus,
          sitBonusPer,
          monster,
          bonuses,
          totalPay: total,
        };
      })
      .filter((r) => r.total > 0 || r.sale_amount > 0 || r.hours > 0)
      .filter((r) => {
        const p = data.profiles.find((x) => x.id === r.id) as { office_location?: string | null } | undefined;
        return matches(p?.office_location ?? null);
      })
      .sort((a, b) => b.totalPay - a.totalPay);
  }, [data, matches]);

  const grandTotal = rows.reduce((s, r) => s + r.totalPay, 0);

  function shiftWeek(delta: number) {
    const next = new Date(weekStart);
    next.setDate(next.getDate() + delta * 7);
    setWeekStart(weekStartOf(next));
  }

  function exportCsv() {
    const headers = [
      "Agent Name",
      "Rank",
      "Van / Team",
      "Total Leads",
      "Results Breakdown",
      "Total Sits",
      "Total Points",
      "Hourly Rate",
      "Total Hours",
      "Hours Source",
      "Base Pay",
      "Total Sales Volume ($)",
      "Commission Rate",
      "Commission Earned ($)",
      "Sit Bonus ($/sit)",
      "Sit Bonus",
      "Monster Bonus",
      "Bonuses Total",
      "Total Estimated Pay ($)",
    ];
    const lines = [headers.join(",")];
    for (const r of rows) {
      const breakdown = `${r.bo} BO, ${r.ol} OL, ${r.rs} RS, ${r.pm} Sit, ${r.sales} Sale`;
      const cells = [
        r.name,
        r.rank,
        r.team?.name ?? "Unassigned",
        r.total,
        breakdown,
        r.sits,
        r.points,
        `$${r.rate}/hr`,
        r.hours.toFixed(2),
        r.hoursSource,
        r.base.toFixed(2),
        r.sale_amount.toFixed(2),
        `${(r.commRate * 100).toFixed(0)}%`,
        r.commission.toFixed(2),
        `$${r.sitBonusPer}`,
        r.sitBonus.toFixed(2),
        r.monster.toFixed(2),
        r.bonuses.toFixed(2),
        r.totalPay.toFixed(2),
      ];
      lines.push(cells.map(csvCell).join(","));
    }
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payroll-${startStr}-to-${endStr}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div className="arcade-card p-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Weekly Payroll Report</div>
          <h2 className="font-display text-lg text-neon mt-1">
            {format(weekStart, "MMM d")} → {format(weekEnd, "MMM d, yyyy")}
          </h2>
          <div className="text-xs text-muted-foreground mt-1">
            Assumed hours: {ASSUMED_HOURS}/wk · Hourly tier by points · Commission by Sale Price · Sit & Monster bonuses included
          </div>
          <div className="mt-3">
            <OfficeFilterToggle />
            {office !== "All" && (
              <span className="ml-3 text-[10px] font-display uppercase tracking-widest text-neon">
                Filtered · {office}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => shiftWeek(-1)} className="font-display text-[10px] uppercase tracking-widest">
            ← Prev Week
          </Button>
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "w-[240px] justify-start text-left font-normal border-neon/40",
                )}
              >
                <CalendarIcon className="mr-2 h-4 w-4 text-neon" />
                Week of {format(weekStart, "PPP")}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={weekStart}
                onSelect={(d) => {
                  if (d) {
                    setWeekStart(weekStartOf(d));
                    setPickerOpen(false);
                  }
                }}
                initialFocus
                className={cn("p-3 pointer-events-auto")}
              />
            </PopoverContent>
          </Popover>
          <Button variant="outline" size="sm" onClick={() => shiftWeek(1)} className="font-display text-[10px] uppercase tracking-widest">
            Next Week →
          </Button>
          <Button
            onClick={exportCsv}
            disabled={rows.length === 0}
            className="bg-victory text-background hover:bg-victory/90 font-display text-xs tracking-widest uppercase shadow-[0_0_24px_color-mix(in_oklab,var(--victory)_55%,transparent)] animate-pulse"
          >
            <Download className="w-4 h-4 mr-2" />
            Export to CSV
          </Button>
        </div>
      </div>

      <ArcadePanel title={`Payroll Ledger · ${rows.length} agents`} action={
        <span className="font-display text-xs text-victory">GRAND TOTAL · ${grandTotal.toFixed(2)}</span>
      }>
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading payroll…</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-muted-foreground">No activity recorded for this week.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] font-display uppercase tracking-widest text-muted-foreground border-b border-border">
                  <th className="text-left py-2 pr-3">Agent</th>
                  <th className="text-left py-2 pr-3">Rank</th>
                  <th className="text-left py-2 pr-3">Van</th>
                  <th className="text-right py-2 pr-3">Leads</th>
                  <th className="text-left py-2 pr-3">Breakdown</th>
                  <th className="text-right py-2 pr-3">Sits</th>
                  <th className="text-right py-2 pr-3">Pts</th>
                  <th className="text-right py-2 pr-3">Rate</th>
                  <th className="text-right py-2 pr-3">Total Hours</th>
                  <th className="text-right py-2 pr-3">Total Sales Volume ($)</th>
                  <th className="text-right py-2 pr-3">Commission Earned ($)</th>
                  <th className="text-right py-2 pr-3">Bonuses</th>
                  <th className="text-right py-2 pr-1">Total Estimated Pay ($)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border/40 hover:bg-surface-elevated">
                    <td className="py-2.5 pr-3 font-medium">{r.name}</td>
                    <td className="py-2.5 pr-3"><RankPill rank={r.rank} /></td>
                    <td className="py-2.5 pr-3">
                      {r.team ? <TeamBadge name={r.team.name} color={r.team.color} /> : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                    <td className="py-2.5 pr-3 text-right text-victory">{r.total}</td>
                    <td className="py-2.5 pr-3 text-xs text-muted-foreground whitespace-nowrap">
                      {r.bo} BO, {r.ol} OL, {r.rs} RS, <span className="text-neon">{r.pm} Sit</span>, <span className="text-victory">{r.sales} Sale</span>
                    </td>
                    <td className="py-2.5 pr-3 text-right">{r.sits}</td>
                    <td className="py-2.5 pr-3 text-right font-display text-neon">{r.points}</td>
                    <td className="py-2.5 pr-3 text-right font-display text-xs">
                      <span className={r.rate === 35 ? "text-victory" : r.rate === 30 ? "text-neon" : "text-muted-foreground"}>
                        ${r.rate}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-right">
                      <div className="font-display text-neon">{r.hours.toFixed(2)}h</div>
                      <div className="text-[9px] text-muted-foreground">
                        {r.hoursSource === "clocked" ? "clocked" : "est. from logs"}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-right font-display text-victory">
                      ${r.sale_amount.toFixed(2)}
                    </td>
                    <td className="py-2.5 pr-3 text-right">
                      <div>${r.commission.toFixed(2)}</div>
                      <div className="text-[9px] text-muted-foreground">
                        {(r.commRate * 100).toFixed(0)}% commission tier
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-right">
                      <div>${r.bonuses.toFixed(2)}</div>
                      {(r.sitBonus > 0 || r.monster > 0) && (
                        <div className="text-[9px] text-muted-foreground">
                          {r.sitBonus > 0 && `+$${r.sitBonus.toFixed(0)} sits`}
                          {r.sitBonus > 0 && r.monster > 0 && " · "}
                          {r.monster > 0 && `+$500 MONSTER`}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 pr-1 text-right font-display text-victory">${r.totalPay.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-neon/40">
                  <td colSpan={12} className="py-3 text-right text-[10px] font-display uppercase tracking-widest text-muted-foreground">Grand Total · Estimated Pay</td>
                  <td className="py-3 pr-1 text-right font-display text-victory text-base">${grandTotal.toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </ArcadePanel>
    </div>
  );
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
