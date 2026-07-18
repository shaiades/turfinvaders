import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { CalendarIcon, Download } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getWeeklyPaychecks, type PaycheckResult } from "@/lib/fleet.functions";
import { sitBonusPerForRank } from "@/lib/pay";
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
      const windowStart = `${startStr}T00:00:00Z`;
      const windowEnd = `${endStr}T23:59:59Z`;
      const [logsRes, leadsRes, profilesRes, teamsRes, timeRes] = await Promise.all([
        supabase
          .from("daily_logs")
          .select("canvasser_id, team_id, no_demo, one_legs, future_leads, demos_sits, sales, log_date")
          .gte("log_date", startStr)
          .lte("log_date", endStr),
        // Only used to include sale-only canvassers in the roster; amounts come
        // from the pay engine. Windowed on both dates to match its
        // COALESCE(reviewed_at, created_at) week attribution.
        supabase
          .from("leads")
          .select("canvasser_id")
          .eq("status", "confirmed")
          .or(
            `and(created_at.gte.${windowStart},created_at.lte.${windowEnd}),and(reviewed_at.gte.${windowStart},reviewed_at.lte.${windowEnd})`,
          ),
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

      const logs = (logsRes.data ?? []) as LogRow[];
      const timeEntries = (timeRes.data ?? []) as { user_id: string; billable_hours: number }[];
      const canvasserIds = Array.from(
        new Set([
          ...logs.map((r) => r.canvasser_id),
          ...(leadsRes.data ?? []).map((l) => l.canvasser_id),
          ...timeEntries.map((t) => t.user_id),
        ]),
      );

      // The authoritative pay engine — batched calls, chunked under the
      // server fn's 300-id input cap so a large roster can never fail whole.
      const paychecks: PaycheckResult[] = [];
      for (let i = 0; i < canvasserIds.length; i += 300) {
        const chunk = canvasserIds.slice(i, i + 300);
        const { results } = await getWeeklyPaychecks({
          data: { week_start: startStr, canvasser_ids: chunk },
        });
        paychecks.push(...results);
      }

      return {
        logs,
        paychecks,
        profiles: profilesRes.data ?? [],
        teams: teamsRes.data ?? [],
        timeEntries,
      };
    },
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const profileById = new Map(data.profiles.map((p) => [p.id, p]));
    const teamById = new Map(data.teams.map((t) => [t.id, t]));
    const aggByCanv = new Map<string, Agg>();

    // Outcome breakdown (BO/OL/RS/Sit/Sale) comes from daily_logs; all pay
    // figures come from the calc_weekly_paycheck engine below.
    for (const r of data.logs) {
      const a = aggByCanv.get(r.canvasser_id) ?? emptyAgg();
      const pmOnly = Math.max(0, (r.demos_sits ?? 0) - (r.sales ?? 0));
      a.bo += r.no_demo ?? 0;
      a.ol += r.one_legs ?? 0;
      a.rs += r.future_leads ?? 0;
      a.pm += pmOnly;
      a.sales += r.sales ?? 0;
      aggByCanv.set(r.canvasser_id, a);
    }

    const hoursByCanv = new Map<string, number>();
    for (const t of data.timeEntries) {
      hoursByCanv.set(t.user_id, (hoursByCanv.get(t.user_id) ?? 0) + Number(t.billable_hours ?? 0));
    }

    return data.paychecks
      .map((res) => {
        const cid = res.canvasser_id;
        const pc = res.paycheck;
        const a = aggByCanv.get(cid) ?? emptyAgg();
        a.total = a.bo + a.ol + a.rs + a.pm + a.sales;
        a.sits = Number(pc?.sits ?? 0);
        a.points = Number(pc?.points ?? 0);
        a.sale_amount = Number(pc?.sale_price_total ?? 0);
        const profile = profileById.get(cid);
        const team = profile?.team_id ? teamById.get(profile.team_id) : null;
        const rank = pc?.rank ?? (profile as { current_rank?: string | null } | undefined)?.current_rank ?? "Jr. Silver";
        const clocked = hoursByCanv.get(cid) ?? 0;
        const hoursSource: "clocked" | "estimated" = clocked > 0 ? "clocked" : "estimated";
        const sitBonus = Number(pc?.sit_bonus ?? 0);
        const monster = Number(pc?.monster_bonus ?? 0);
        return {
          id: cid,
          name: profile?.display_name ?? "Unknown",
          team,
          rank,
          ...a,
          hours: Number(pc?.hours ?? 0),
          hoursSource,
          rate: Number(pc?.hourly_rate ?? 0),
          commRate: Number(pc?.commission_rate ?? 0),
          base: Number(pc?.base_pay ?? 0),
          commission: Number(pc?.commission ?? 0),
          sitBonus,
          sitBonusPer: sitBonusPerForRank(rank),
          monster,
          bonuses: sitBonus + monster,
          totalPay: Number(pc?.total_pay ?? 0),
          payError: res.error,
        };
      })
      .filter((r) => r.total > 0 || r.sale_amount > 0 || r.hours > 0 || r.payError)
      .filter((r) => {
        const p = profileById.get(r.id) as { office_location?: string | null } | undefined;
        return matches(p?.office_location ?? null);
      })
      .sort((a, b) => b.totalPay - a.totalPay);
  }, [data, matches]);

  const grandTotal = rows.reduce((s, r) => s + r.totalPay, 0);
  const payErrorCount = rows.filter((r) => r.payError).length;

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
        r.payError ? "ERROR" : r.totalPay.toFixed(2),
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
            Official pay engine · Hours: clocked, else est. 7.5/day Mon–Fri + 6.5 Sat from active days · Hourly tier by points · Commission by Sale Price · Sit & Monster bonuses included
          </div>
          {office !== "All" && (
            <div className="mt-3 text-[10px] font-display uppercase tracking-widest text-neon">
              Filtered · {office}
            </div>
          )}
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
          <>
          {payErrorCount > 0 && (
            <div className="mb-3 text-xs text-destructive">
              ⚠ Pay could not be computed for {payErrorCount} agent{payErrorCount === 1 ? "" : "s"} (marked ERROR below).
              The grand total and CSV export exclude them — retry or investigate before paying out.
            </div>
          )}
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
                    <td className="py-2.5 pr-1 text-right font-display text-victory">
                      {r.payError ? (
                        <span className="text-destructive text-xs" title={r.payError}>ERROR</span>
                      ) : (
                        <>${r.totalPay.toFixed(2)}</>
                      )}
                    </td>
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
          </>
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
