import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, TeamBadge, MobileCardList, MobileCard, MobileCardHeader, MobileStatGrid, MobileStat } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { upsertManualWeekly, getWeeklyPaychecks } from "@/lib/fleet.functions";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { OfficeFilterProvider, OfficeFilterToggle, useOfficeFilter } from "@/components/OfficeFilterContext";
import { weekStartMonday, toISODate, addDays, dateFromISO, laDateISO, laTodayISO, laWeekStartISO, weekStartOfISO } from "@/lib/dates";


/* ============ Helpers ============ */
/* All day/week/month buckets are America/Los_Angeles (midnight PT resets). */

const startOfWeekMon = weekStartMonday;
function startOfMonth(ref = new Date()) {
  return dateFromISO(`${laDateISO(ref).slice(0, 7)}-01`);
}

function leadsSum(r: { demos_sits?: number | null; sales?: number | null; no_demo?: number | null; one_legs?: number | null; future_leads?: number | null; unmarked?: number | null }) {
  return (r.demos_sits ?? 0) + (r.sales ?? 0) + (r.no_demo ?? 0) + (r.one_legs ?? 0) + (r.future_leads ?? 0) + (r.unmarked ?? 0);
}

/* ============ Main ============ */

function formatWeekRange(start: Date, end: Date): string {
  const monthFmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });
  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear())
    return `${monthFmt(start)} ${start.getDate()} – ${end.getDate()}, ${end.getFullYear()}`;
  return `${monthFmt(start)} ${start.getDate()} – ${monthFmt(end)} ${end.getDate()}, ${end.getFullYear()}`;
}

// Slimmed 2026-07-22: Payroll lives only in the Payroll tab, fleet status in
// the Fleet tab, CSV import in the header dialog, and DatabaseCleanup on the
// Manage Players screen — the Executive tab no longer restates them.
export function ExecutiveDashboard() {
  // Week selector drives Weekly Results. Defaults to last completed week
  // (the historical behavior); Mon–Sat pay week, Pacific time.
  const [weekStart, setWeekStart] = useState<Date>(() => addDays(weekStartMonday(), -7));
  const weekEnd = useMemo(() => addDays(weekStart, 5), [weekStart]);
  const thisWeekISO = toISODate(weekStartMonday());
  const isCurrentWeek = toISODate(weekStart) === thisWeekISO;
  const isLastWeek = toISODate(weekStart) === toISODate(addDays(weekStartMonday(), -7));

  return (
    <OfficeFilterProvider>
      <div className="space-y-6">
        <div className="flex items-center justify-center">
          <OfficeFilterToggle compact className="w-full max-w-md" />
        </div>

        {/* Week selector */}
        <ArcadePanel
          title="Results Week"
          action={
            <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              {isCurrentWeek ? "Current Week · In Progress" : isLastWeek ? "Last Week" : "Past Week"}
            </span>
          }
        >
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <Button size="sm" variant="outline" onClick={() => setWeekStart((w) => addDays(w, -7))} aria-label="Previous week">
                ‹
              </Button>
              <div className="min-w-0 flex-1 text-center font-display text-xs sm:text-sm text-neon truncate">
                {formatWeekRange(weekStart, weekEnd)}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setWeekStart((w) => addDays(w, 7))}
                disabled={isCurrentWeek}
                aria-label="Next week"
              >
                ›
              </Button>
            </div>
            {!isLastWeek && (
              <Button size="sm" variant="ghost" onClick={() => setWeekStart(addDays(weekStartMonday(), -7))}>
                Jump to last week
              </Button>
            )}
          </div>
        </ArcadePanel>

        <ManualEntryBar />
        <WeeklyResults weekStart={weekStart} />
        <LiveDailyAction />
        <RawDataTable />
      </div>
    </OfficeFilterProvider>
  );
}


/* ============ Live Daily Action (Today) ============ */

function LiveDailyAction() {
  const today = useMemo(() => laTodayISO(), []);
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["live_daily_action", today],
    queryFn: async () => {
      const [logsR, profilesR, vansR] = await Promise.all([
        supabase
          .from("daily_logs")
          .select("canvasser_id, team_id, leads_called_in, next_days, future_leads, no_demo, confirmed_leads")
          .eq("log_date", today),
        supabase.from("profiles").select("id, display_name, team_id"),
        supabase.from("teams").select("id, name, color"),
      ]);
      if (logsR.error) throw logsR.error;
      if (profilesR.error) throw profilesR.error;
      if (vansR.error) throw vansR.error;

      const logs = logsR.data ?? [];
      const totals = logs.reduce(
        (acc, r) => ({
          called: acc.called + (r.leads_called_in ?? 0),
          nextDay: acc.nextDay + (r.next_days ?? 0),
          future: acc.future + (r.future_leads ?? 0),
          blowout: acc.blowout + (r.no_demo ?? 0),
        }),
        { called: 0, nextDay: 0, future: 0, blowout: 0 },
      );

      // Donut List: every canvasser on a Van who has NOT logged a
      // Confirmed_Next_Day or Confirmed_Future ping today.
      const confirmedToday = new Set(
        logs
          .filter((r) => (r.next_days ?? 0) > 0 || (r.future_leads ?? 0) > 0)
          .map((r) => r.canvasser_id),
      );
      const vanById = new Map((vansR.data ?? []).map((v) => [v.id, v]));
      const donut = (profilesR.data ?? [])
        .filter((p) => p.team_id && !confirmedToday.has(p.id))
        .map((p) => ({
          id: p.id,
          name: p.display_name ?? "Unknown",
          van: p.team_id ? vanById.get(p.team_id) ?? null : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return { totals, donut };
    },
    refetchInterval: 15_000,
  });

  // Refresh when a new ping lands.
  useEffect(() => {
    const ch = supabase
      .channel("live-daily-action")
      .on("postgres_changes", { event: "*", schema: "public", table: "daily_logs" }, () => {
        qc.invalidateQueries({ queryKey: ["live_daily_action", today] });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc, today]);

  const t = q.data?.totals ?? { called: 0, nextDay: 0, future: 0, blowout: 0 };
  const donut = q.data?.donut ?? [];

  const webhookUrl = typeof window !== "undefined"
    ? `${window.location.origin}/api/public/monday-webhook`
    : "/api/public/monday-webhook";

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="font-display text-sm uppercase tracking-widest text-foreground">Live Daily Action</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{today}</p>
        </div>
        <button
          onClick={() => {
            navigator.clipboard.writeText(webhookUrl);
            toast.success("Webhook URL copied");
          }}
          className="inline-flex items-center min-h-10 md:min-h-9 px-2 -mx-2 text-[10px] font-display uppercase tracking-widest text-neon hover:underline"
        >
          Copy Webhook URL
        </button>
      </div>

      <div className="space-y-1 text-sm text-foreground">
        <p>Leads Called In: <span className="text-neon font-medium">{t.called}</span></p>
        <p>Confirmed Tomorrow: <span className="text-victory font-medium">{t.nextDay}</span></p>
        <p>Confirmed Future: <span className="text-[var(--accent)] font-medium">{t.future}</span></p>
        <p>Blowouts / Not Good: <span className="text-[var(--warning)] font-medium">{t.blowout}</span></p>
      </div>

      <div className="space-y-1">
        <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Donut List ({donut.length})
        </p>
        {donut.length === 0 ? (
          <p className="text-sm text-victory">Everyone is on the board — no donuts today.</p>
        ) : (
          <p className="text-sm text-foreground">
            {donut.map((d) => d.name).join(", ")}
          </p>
        )}
      </div>
    </section>
  );
}



/* ============ Manual Entry ============ */


function ManualEntryBar() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [canvasserId, setCanvasserId] = useState<string>("");
  const [weekStart, setWeekStart] = useState<string>(laWeekStartISO());
  const [leads, setLeads] = useState<string>("0");
  const [sits, setSits] = useState<string>("0");
  const [sales, setSales] = useState<string>("0");
  const upsertFn = useServerFn(upsertManualWeekly);

  const peopleQ = useQuery({
    queryKey: ["all_canvassers_simple"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id, display_name").order("display_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      await upsertFn({ data: {
        canvasser_id: canvasserId,
        week_start: weekStart,
        total_leads: Number(leads),
        total_sits: Number(sits),
        total_sales: Number(sales),
      }});
    },
    onSuccess: () => {
      toast.success("Saved · Paycheck engine updated");
      qc.invalidateQueries({ queryKey: ["weekly_results"] });
      qc.invalidateQueries({ queryKey: ["fleet_status"] });
      qc.invalidateQueries({ queryKey: ["raw_daily_logs"] });
      setOpen(false);
      setLeads("0"); setSits("0"); setSales("0");
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to save"),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="lg" className="w-full h-12 md:h-14 py-3 md:py-4 text-sm md:text-base font-display uppercase tracking-widest bg-victory text-background hover:bg-victory/90">
          <Plus className="w-5 h-5 mr-2" /> Manual Data Entry
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle className="font-display uppercase tracking-widest text-neon">Manual Weekly Entry</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Canvasser</Label>
            <Select value={canvasserId} onValueChange={setCanvasserId}>
              <SelectTrigger><SelectValue placeholder="Select canvasser…" /></SelectTrigger>
              <SelectContent>
                {(peopleQ.data ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.display_name ?? "Unknown"}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Week (Monday)</Label>
            <Input type="date" value={weekStart} onChange={(e) => setWeekStart(weekStartOfISO(e.target.value))} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5"><Label>Total Leads</Label><Input type="number" min={0} value={leads} onChange={(e) => setLeads(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Total Sits</Label><Input type="number" min={0} value={sits} onChange={(e) => setSits(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Total Sales</Label><Input type="number" min={0} value={sales} onChange={(e) => setSales(e.target.value)} /></div>
          </div>
          <p className="text-xs text-muted-foreground">
            Points = Sits + Sales. Pay auto-calculated by the Paycheck Engine and shown in <em>Last Week's Results</em>.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!canvasserId || save.isPending} className="bg-victory text-background hover:bg-victory/90">
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============ Raw Data Table ============ */

function RawDataTable() {
  const q = useQuery({
    queryKey: ["raw_daily_logs"],
    queryFn: async () => {
      const [logsR, profilesR] = await Promise.all([
        supabase.from("daily_logs")
          .select("id, canvasser_id, team_id, log_date, demos_sits, sales, no_demo, one_legs, future_leads, unmarked, people_talked_to, leads_called_in, confirmed_leads")
          .order("log_date", { ascending: false })
          .limit(500),
        supabase.from("profiles").select("id, display_name, office_location"),
      ]);
      if (logsR.error) throw logsR.error;
      if (profilesR.error) throw profilesR.error;
      const nameById = new Map((profilesR.data ?? []).map((p) => [p.id, p.display_name ?? "Unknown"]));
      const locById = new Map((profilesR.data ?? []).map((p) => [p.id, (p as { office_location?: string | null }).office_location ?? null]));
      return (logsR.data ?? []).map((r) => ({
        ...r,
        name: nameById.get(r.canvasser_id) ?? r.canvasser_id.slice(0,8),
        office_location: locById.get(r.canvasser_id) ?? null,
      }));
    },
  });

  const { matches } = useOfficeFilter();
  const visible = (q.data ?? []).filter((r) => matches(r.office_location));

  return (
    <ArcadePanel
      title={`All Database Records · daily_logs (${visible.length}${visible.length !== (q.data?.length ?? 0) ? ` of ${q.data?.length ?? 0}` : ""})`}
      action={<span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Raw · Newest First</span>}
    >
      {q.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="text-sm text-destructive font-medium">
          ⚠ No rows match the current Office filter.
        </div>
      ) : (
        <>
          <MobileCardList>
            {visible.map((r) => (
              <MobileCard key={r.id}>
                <MobileCardHeader
                  left={r.name}
                  right={<span className="text-muted-foreground font-mono text-xs">{r.log_date}</span>}
                />
                <MobileStatGrid cols={4}>
                  <MobileStat label="Sits" value={r.demos_sits} />
                  <MobileStat label="Sales" value={r.sales} className="text-victory" />
                  <MobileStat label="Confirmed" value={r.confirmed_leads} />
                  <MobileStat label="No Demo" value={r.no_demo} />
                  <MobileStat label="One Legs" value={r.one_legs} />
                  <MobileStat label="Future" value={r.future_leads} />
                  <MobileStat label="Talked" value={r.people_talked_to} />
                  <MobileStat label="Called In" value={r.leads_called_in} />
                </MobileStatGrid>
              </MobileCard>
            ))}
          </MobileCardList>
          <div className="hidden md:block overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Canvasser</th>
                <th className="px-3 py-2 text-right">Sits</th>
                <th className="px-3 py-2 text-right">Sales</th>
                <th className="px-3 py-2 text-right">No Demo</th>
                <th className="px-3 py-2 text-right">One Legs</th>
                <th className="px-3 py-2 text-right">Future</th>
                <th className="px-3 py-2 text-right">Talked</th>
                <th className="px-3 py-2 text-right">Called In</th>
                <th className="px-3 py-2 text-right">Confirmed</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-1.5 font-mono">{r.log_date}</td>
                  <td className="px-3 py-1.5">{r.name}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{r.demos_sits}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-victory">{r.sales}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{r.no_demo}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{r.one_legs}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{r.future_leads}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{r.people_talked_to}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{r.leads_called_in}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{r.confirmed_leads}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
    </ArcadePanel>
  );
}

/* ============ 1. Live Fleet Status (Day/Week/Month) ============ */

type Range = "today" | "week" | "month";

/* ============ 2. Last Week's Results ============ */

type WeeklyRow = {
  canvasserId: string;
  name: string;
  officeLocation: string | null;
  vanName: string | null;
  vanColor: string | null;
  totalLeads: number;
  totalSits: number;
  totalResets: number;
  totalOL: number;
  totalSales: number;
  totalPoints: number;
  totalPay: number;
  payError: string | null;
};

function WeeklyResults({ weekStart }: { weekStart: Date }) {
  const lastWeekStart = weekStart;
  const lastWeekEnd = useMemo(() => addDays(lastWeekStart, 5), [lastWeekStart]);
  const isCurrentWeek = toISODate(weekStart) === toISODate(startOfWeekMon());

  const q = useQuery({
    queryKey: ["weekly_results", toISODate(lastWeekStart)],
    queryFn: async (): Promise<WeeklyRow[]> => {
      const [profilesR, vansR, logsR] = await Promise.all([
        supabase.from("profiles").select("id, display_name, team_id, office_location"),
        supabase.from("teams").select("id, name, color"),
        supabase.from("daily_logs")
          .select("canvasser_id, demos_sits, sales, no_demo, one_legs, future_leads, unmarked")
          .gte("log_date", toISODate(lastWeekStart))
          .lte("log_date", toISODate(lastWeekEnd)),
      ]);
      if (profilesR.error) throw profilesR.error;
      if (vansR.error) throw vansR.error;
      if (logsR.error) throw logsR.error;

      const vanById = new Map((vansR.data ?? []).map((v) => [v.id, v]));
      const agg = new Map<string, { leads: number; sits: number; resets: number; ol: number; sales: number }>();
      for (const l of logsR.data ?? []) {
        const cur = agg.get(l.canvasser_id) ?? { leads: 0, sits: 0, resets: 0, ol: 0, sales: 0 };
        cur.leads += leadsSum(l);
        // demos_sits in DB includes sale rows. Sits (PM only) = demos_sits - sales.
        const pmOnly = Math.max(0, (l.demos_sits ?? 0) - (l.sales ?? 0));
        cur.sits += pmOnly;
        // RS outcomes are persisted in future_leads (see csv-import.functions.ts).
        cur.resets += l.future_leads ?? 0;
        // OL outcomes are persisted in one_legs (webhook DAILY_LOG_VECS).
        cur.ol += l.one_legs ?? 0;
        cur.sales += l.sales ?? 0;
        agg.set(l.canvasser_id, cur);
      }

      const activeIds = Array.from(agg.keys());
      // Batched calls to the pay engine (chunked under the server fn's 300-id
      // cap) — same code path as the Payroll tab.
      const payById = new Map<string, { pay: number; error: string | null }>();
      for (let i = 0; i < activeIds.length; i += 300) {
        const chunk = activeIds.slice(i, i + 300);
        try {
          const { results } = await getWeeklyPaychecks({
            data: { week_start: toISODate(lastWeekStart), canvasser_ids: chunk },
          });
          for (const r of results) {
            payById.set(r.canvasser_id, {
              pay: Number(r.paycheck?.total_pay ?? 0),
              error: r.error,
            });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          for (const id of chunk) payById.set(id, { pay: 0, error: msg });
        }
      }

      const rows: WeeklyRow[] = [];
      for (const id of activeIds) {
        const p = profilesR.data?.find((x) => x.id === id);
        const v = p?.team_id ? vanById.get(p.team_id) : null;
        const a = agg.get(id)!;
        // Strict formula: Points = (Sits * 1) + (Sales * 2)
        const totalPoints = a.sits * 1 + a.sales * 2;
        rows.push({
          canvasserId: id,
          name: p?.display_name ?? "Unknown",
          officeLocation: (p as { office_location?: string | null } | undefined)?.office_location ?? null,
          vanName: v?.name ?? null,
          vanColor: v?.color ?? null,
          totalLeads: a.leads,
          totalSits: a.sits,
          totalResets: a.resets,
          totalOL: a.ol,
          totalSales: a.sales,
          totalPoints,
          totalPay: payById.get(id)?.pay ?? 0,
          payError: payById.get(id)?.error ?? null,
        });
      }
      rows.sort((a, b) => b.totalPay - a.totalPay);
      return rows;
    },
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const { matches, office } = useOfficeFilter();
  const rows = (q.data ?? []).filter((r) => matches(r.officeLocation));

  const grand = rows.reduce(
    (acc, r) => ({
      leads: acc.leads + r.totalLeads,
      sits: acc.sits + r.totalSits,
      resets: acc.resets + r.totalResets,
      ol: acc.ol + r.totalOL,
      sales: acc.sales + r.totalSales,
      points: acc.points + r.totalPoints,
      pay: acc.pay + r.totalPay,
    }),
    { leads: 0, sits: 0, resets: 0, ol: 0, sales: 0, points: 0, pay: 0 }
  );

  return (
    <ArcadePanel
      title={isCurrentWeek ? "This Week's Results · In Progress" : "Weekly Results"}
      action={
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          {office === "All" ? "" : `${office} · `}{toISODate(lastWeekStart)} → {toISODate(lastWeekEnd)}
        </span>
      }
    >
      {q.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          {office === "All" ? "No activity recorded this week." : `No ${office} activity recorded this week.`}
        </div>
      ) : (
        <>
          <MobileCardList>
            {rows.map((r) => (
              <MobileCard key={r.canvasserId}>
                <MobileCardHeader
                  left={r.name}
                  right={r.payError ? (
                    <span className="text-destructive text-xs" title={r.payError}>—</span>
                  ) : (
                    <span className="text-victory">${r.totalPay.toFixed(2)}</span>
                  )}
                />
                {r.vanName && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <TeamBadge name={r.vanName} color={r.vanColor ?? "#888"} />
                  </div>
                )}
                <MobileStatGrid cols={3}>
                  <MobileStat label="Leads" value={r.totalLeads} />
                  <MobileStat label="Sits" value={r.totalSits} />
                  <MobileStat label="Resets" value={r.totalResets} className="text-[var(--accent)]" />
                  <MobileStat label="OL" value={r.totalOL} className="text-warning" />
                  <MobileStat label="Sales" value={r.totalSales} className="text-victory" />
                  <MobileStat label="Points" value={r.totalPoints} className="text-neon" />
                </MobileStatGrid>
              </MobileCard>
            ))}
            <MobileCard className="border-neon/40">
              <MobileCardHeader
                left={<span className="font-display text-xs uppercase tracking-widest text-neon">Grand Total</span>}
                right={<span className="text-victory">${grand.pay.toFixed(2)}</span>}
              />
              <MobileStatGrid cols={3}>
                <MobileStat label="Leads" value={grand.leads} />
                <MobileStat label="Sits" value={grand.sits} />
                <MobileStat label="Resets" value={grand.resets} className="text-[var(--accent)]" />
                <MobileStat label="OL" value={grand.ol} className="text-warning" />
                <MobileStat label="Sales" value={grand.sales} className="text-victory" />
                <MobileStat label="Points" value={grand.points} className="text-neon" />
              </MobileStatGrid>
            </MobileCard>
          </MobileCardList>
          <div className="hidden md:block overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-2">Canvasser</th>
                <th className="px-4 py-2">Van</th>
                <th className="px-4 py-2 text-right">Total Leads</th>
                <th className="px-4 py-2 text-right">Total Sits</th>
                <th className="px-4 py-2 text-right">Total Resets</th>
                <th className="px-4 py-2 text-right">Total OL</th>
                <th className="px-4 py-2 text-right">Total Sales</th>
                <th className="px-4 py-2 text-right">Total Points</th>
                <th className="px-4 py-2 text-right">Total Pay</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.canvasserId} className="border-t border-border">
                  <td className="px-4 py-2.5 font-medium">{r.name}</td>
                  <td className="px-4 py-2.5">
                    {r.vanName ? <TeamBadge name={r.vanName} color={r.vanColor ?? "#888"} /> : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right font-display">{r.totalLeads}</td>
                  <td className="px-4 py-2.5 text-right font-display">{r.totalSits}</td>
                  <td className="px-4 py-2.5 text-right font-display text-[var(--accent)]">{r.totalResets}</td>
                  <td className="px-4 py-2.5 text-right font-display text-warning">{r.totalOL}</td>
                  <td className="px-4 py-2.5 text-right font-display text-victory">{r.totalSales}</td>
                  <td className="px-4 py-2.5 text-right font-display text-neon">{r.totalPoints}</td>
                  <td className="px-4 py-2.5 text-right font-display text-victory">
                    {r.payError ? (
                      <span className="text-destructive text-xs" title={r.payError}>—</span>
                    ) : (
                      <>${r.totalPay.toFixed(2)}</>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-neon/60 bg-surface">
                <td className="px-4 py-2.5 font-display text-xs uppercase tracking-widest text-neon" colSpan={2}>Grand Total</td>
                <td className="px-4 py-2.5 text-right font-display">{grand.leads}</td>
                <td className="px-4 py-2.5 text-right font-display">{grand.sits}</td>
                <td className="px-4 py-2.5 text-right font-display text-[var(--accent)]">{grand.resets}</td>
                <td className="px-4 py-2.5 text-right font-display text-warning">{grand.ol}</td>
                <td className="px-4 py-2.5 text-right font-display text-victory">{grand.sales}</td>
                <td className="px-4 py-2.5 text-right font-display text-neon">{grand.points}</td>
                <td className="px-4 py-2.5 text-right font-display text-victory">${grand.pay.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
          </div>
        </>
      )}
    </ArcadePanel>
  );
}
