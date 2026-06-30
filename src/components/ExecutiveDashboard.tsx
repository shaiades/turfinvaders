import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, TeamBadge } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { deleteProfile, deleteVan, upsertManualWeekly } from "@/lib/fleet.functions";
import { HistoricalImporter } from "@/components/HistoricalImporter";
import { PayrollLedger } from "@/components/PayrollLedger";
import { toast } from "sonner";
import { Plus, Trash2, Truck, User } from "lucide-react";


/* ============ Helpers ============ */

function toISODate(d: Date) { return d.toISOString().slice(0, 10); }
function startOfWeekMon(ref = new Date()) {
  const d = new Date(ref); d.setHours(0, 0, 0, 0);
  const day = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() - (day - 1));
  return d;
}
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfMonth(ref = new Date()) { const d = new Date(ref); d.setHours(0,0,0,0); d.setDate(1); return d; }

function leadsSum(r: { demos_sits?: number | null; sales?: number | null; no_demo?: number | null; one_legs?: number | null; future_leads?: number | null; unmarked?: number | null }) {
  return (r.demos_sits ?? 0) + (r.sales ?? 0) + (r.no_demo ?? 0) + (r.one_legs ?? 0) + (r.future_leads ?? 0) + (r.unmarked ?? 0);
}

/* ============ Main ============ */

export function ExecutiveDashboard() {
  return (
    <div className="space-y-6">
      <ManualEntryBar />
      <HistoricalImporter />
      <WeeklyResults />
      <PayrollLedger />
      <LiveDailyAction />
      <DatabaseCleanup />
      <RawDataTable />
      <LiveFleetStatus />
    </div>
  );
}


/* ============ Live Daily Action (Today) ============ */

function LiveDailyAction() {
  const today = useMemo(() => toISODate(new Date()), []);
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
          className="text-[10px] font-display uppercase tracking-widest text-neon hover:underline"
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

function startOfWeekMonISO(d: Date) {
  const x = new Date(d); x.setHours(0,0,0,0);
  const day = x.getDay() === 0 ? 7 : x.getDay();
  x.setDate(x.getDate() - (day - 1));
  return x.toISOString().slice(0, 10);
}

function ManualEntryBar() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [canvasserId, setCanvasserId] = useState<string>("");
  const [weekStart, setWeekStart] = useState<string>(startOfWeekMonISO(new Date()));
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
        <Button size="lg" className="w-full h-14 text-base font-display uppercase tracking-widest bg-victory text-background hover:bg-victory/90">
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
            <Input type="date" value={weekStart} onChange={(e) => setWeekStart(startOfWeekMonISO(new Date(e.target.value)))} />
          </div>
          <div className="grid grid-cols-3 gap-3">
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
          .select("id, canvasser_id, team_id, log_date, demos_sits, sales, no_demo, one_legs, future_leads, people_talked_to, leads_called_in, confirmed_leads")
          .order("log_date", { ascending: false })
          .limit(500),
        supabase.from("profiles").select("id, display_name"),
      ]);
      if (logsR.error) throw logsR.error;
      if (profilesR.error) throw profilesR.error;
      const nameById = new Map((profilesR.data ?? []).map((p) => [p.id, p.display_name ?? "Unknown"]));
      return (logsR.data ?? []).map((r) => ({ ...r, name: nameById.get(r.canvasser_id) ?? r.canvasser_id.slice(0,8) }));
    },
  });

  return (
    <ArcadePanel
      title={`All Database Records · daily_logs (${q.data?.length ?? 0})`}
      action={<span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Raw · Newest First</span>}
    >
      {q.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (q.data?.length ?? 0) === 0 ? (
        <div className="text-sm text-destructive font-medium">
          ⚠ The database table is EMPTY. No CSV rows saved. Use Manual Data Entry above to add records.
        </div>
      ) : (
        <div className="overflow-x-auto -mx-4 sm:mx-0">
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
              {q.data!.map((r) => (
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
      )}
    </ArcadePanel>
  );
}

/* ============ 1. Live Fleet Status (Day/Week/Month) ============ */

type Range = "today" | "week" | "month";

function LiveFleetStatus() {
  const [range, setRange] = useState<Range>("today");

  const since = useMemo(() => {
    const today = new Date(); today.setHours(0,0,0,0);
    if (range === "today") return today;
    if (range === "week") return startOfWeekMon(today);
    return startOfMonth(today);
  }, [range]);

  const q = useQuery({
    queryKey: ["fleet_status", range],
    queryFn: async () => {
      const [vansR, logsR] = await Promise.all([
        supabase.from("teams").select("id, name, color").order("name"),
        supabase.from("daily_logs")
          .select("team_id, demos_sits, sales, no_demo, one_legs, future_leads, log_date")
          .gte("log_date", toISODate(since)),
      ]);
      if (vansR.error) throw vansR.error;
      if (logsR.error) throw logsR.error;
      const byVan = new Map<string, { leads: number; sits: number }>();
      for (const l of logsR.data ?? []) {
        if (!l.team_id) continue;
        const cur = byVan.get(l.team_id) ?? { leads: 0, sits: 0 };
        cur.leads += leadsSum(l);
        cur.sits += l.sales ?? 0; // closed sales count as sits too, but spec asks "sits"
        cur.sits = cur.sits; // no-op to make ts happy
        byVan.set(l.team_id, cur);
      }
      // Re-compute sits properly: demos_sits + sales (a sale is also a sit/demo)
      const fresh = new Map<string, { leads: number; sits: number }>();
      for (const l of logsR.data ?? []) {
        if (!l.team_id) continue;
        const cur = fresh.get(l.team_id) ?? { leads: 0, sits: 0 };
        cur.leads += leadsSum(l);
        cur.sits += (l.demos_sits ?? 0) + (l.sales ?? 0);
        fresh.set(l.team_id, cur);
      }
      return { vans: vansR.data ?? [], byVan: fresh };
    },
  });

  return (
    <ArcadePanel title="Live Fleet Status" action={
      <div className="inline-flex rounded-md border border-border bg-surface p-0.5">
        {(["today","week","month"] as Range[]).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`px-3 py-1 text-[10px] font-display uppercase tracking-widest rounded-sm transition ${
              range === r ? "bg-neon text-background" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {r === "today" ? "Today" : r === "week" ? "This Week" : "This Month"}
          </button>
        ))}
      </div>
    }>
      {q.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (q.data?.vans.length ?? 0) === 0 ? (
        <div className="text-sm text-muted-foreground">No vans yet.</div>
      ) : (
        <div className="space-y-2">
          {q.data!.vans.map((v) => {
            const totals = q.data!.byVan.get(v.id) ?? { leads: 0, sits: 0 };
            return (
              <div key={v.id} className="flex items-center justify-between gap-4 px-4 py-3 rounded-lg border border-border bg-surface">
                <div className="flex items-center gap-3 min-w-0">
                  <Truck className="w-4 h-4 shrink-0" style={{ color: v.color }} />
                  <TeamBadge name={v.name} color={v.color} />
                </div>
                <div className="flex items-center gap-6">
                  <div className="text-right">
                    <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Leads</div>
                    <div className="font-display text-xl text-neon">{totals.leads}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Sits</div>
                    <div className="font-display text-xl text-victory">{totals.sits}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ArcadePanel>
  );
}

/* ============ 2. Last Week's Results ============ */

type WeeklyRow = {
  canvasserId: string;
  name: string;
  vanName: string | null;
  vanColor: string | null;
  totalLeads: number;
  totalSits: number;
  totalSales: number;
  totalPoints: number;
  totalPay: number;
};

function WeeklyResults() {
  const lastWeekStart = useMemo(() => addDays(startOfWeekMon(), -7), []);
  const lastWeekEnd = useMemo(() => addDays(lastWeekStart, 5), [lastWeekStart]);

  const q = useQuery({
    queryKey: ["weekly_results", toISODate(lastWeekStart)],
    queryFn: async (): Promise<WeeklyRow[]> => {
      const [profilesR, vansR, logsR] = await Promise.all([
        supabase.from("profiles").select("id, display_name, team_id"),
        supabase.from("teams").select("id, name, color"),
        supabase.from("daily_logs")
          .select("canvasser_id, demos_sits, sales, no_demo, one_legs, future_leads")
          .gte("log_date", toISODate(lastWeekStart))
          .lte("log_date", toISODate(lastWeekEnd)),
      ]);
      if (profilesR.error) throw profilesR.error;
      if (vansR.error) throw vansR.error;
      if (logsR.error) throw logsR.error;

      const vanById = new Map((vansR.data ?? []).map((v) => [v.id, v]));
      const agg = new Map<string, { leads: number; sits: number; sales: number }>();
      for (const l of logsR.data ?? []) {
        const cur = agg.get(l.canvasser_id) ?? { leads: 0, sits: 0, sales: 0 };
        cur.leads += leadsSum(l);
        // demos_sits in DB includes sale rows. Sits (PM only) = demos_sits - sales.
        const pmOnly = Math.max(0, (l.demos_sits ?? 0) - (l.sales ?? 0));
        cur.sits += pmOnly;
        cur.sales += l.sales ?? 0;
        agg.set(l.canvasser_id, cur);
      }

      const activeIds = Array.from(agg.keys());
      const pays = await Promise.all(activeIds.map((id) =>
        supabase.rpc("calc_weekly_paycheck", { _canvasser_id: id, _week_start: toISODate(lastWeekStart) })
          .then((r) => ({ id, pay: Number(r.data?.[0]?.total_pay ?? 0) }))
      ));
      const payById = new Map(pays.map((p) => [p.id, p.pay]));

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
          vanName: v?.name ?? null,
          vanColor: v?.color ?? null,
          totalLeads: a.leads,
          totalSits: a.sits,
          totalSales: a.sales,
          totalPoints,
          totalPay: payById.get(id) ?? 0,
        });
      }
      rows.sort((a, b) => b.totalPay - a.totalPay);
      return rows;
    },
  });

  const grand = (q.data ?? []).reduce(
    (acc, r) => ({
      leads: acc.leads + r.totalLeads,
      sits: acc.sits + r.totalSits,
      sales: acc.sales + r.totalSales,
      points: acc.points + r.totalPoints,
      pay: acc.pay + r.totalPay,
    }),
    { leads: 0, sits: 0, sales: 0, points: 0, pay: 0 }
  );

  return (
    <ArcadePanel
      title="Last Week's Results"
      action={
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          {toISODate(lastWeekStart)} → {toISODate(lastWeekEnd)}
        </span>
      }
    >
      {q.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (q.data?.length ?? 0) === 0 ? (
        <div className="text-sm text-muted-foreground">No activity recorded last week.</div>
      ) : (
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-2">Canvasser</th>
                <th className="px-4 py-2">Van</th>
                <th className="px-4 py-2 text-right">Total Leads</th>
                <th className="px-4 py-2 text-right">Total Sits</th>
                <th className="px-4 py-2 text-right">Total Sales</th>
                <th className="px-4 py-2 text-right">Total Points</th>
                <th className="px-4 py-2 text-right">Total Pay</th>
              </tr>
            </thead>
            <tbody>
              {q.data!.map((r) => (
                <tr key={r.canvasserId} className="border-t border-border">
                  <td className="px-4 py-2.5 font-medium">{r.name}</td>
                  <td className="px-4 py-2.5">
                    {r.vanName ? <TeamBadge name={r.vanName} color={r.vanColor ?? "#888"} /> : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right font-display">{r.totalLeads}</td>
                  <td className="px-4 py-2.5 text-right font-display">{r.totalSits}</td>
                  <td className="px-4 py-2.5 text-right font-display text-victory">{r.totalSales}</td>
                  <td className="px-4 py-2.5 text-right font-display text-neon">{r.totalPoints}</td>
                  <td className="px-4 py-2.5 text-right font-display text-victory">${r.totalPay.toFixed(2)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-neon/60 bg-surface">
                <td className="px-4 py-2.5 font-display text-xs uppercase tracking-widest text-neon" colSpan={2}>Grand Total</td>
                <td className="px-4 py-2.5 text-right font-display">{grand.leads}</td>
                <td className="px-4 py-2.5 text-right font-display">{grand.sits}</td>
                <td className="px-4 py-2.5 text-right font-display text-victory">{grand.sales}</td>
                <td className="px-4 py-2.5 text-right font-display text-neon">{grand.points}</td>
                <td className="px-4 py-2.5 text-right font-display text-victory">${grand.pay.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </ArcadePanel>
  );
}


/* ============ 3. Database Cleanup ============ */

function DatabaseCleanup() {
  const qc = useQueryClient();
  const deleteProfileFn = useServerFn(deleteProfile);
  const deleteVanFn = useServerFn(deleteVan);

  const q = useQuery({
    queryKey: ["cleanup_inventory"],
    queryFn: async () => {
      const [vansR, profilesR, rolesR] = await Promise.all([
        supabase.from("teams").select("id, name, color").order("name"),
        supabase.from("profiles").select("id, display_name, team_id").order("display_name"),
        supabase.from("user_roles").select("user_id, role"),
      ]);
      if (vansR.error) throw vansR.error;
      if (profilesR.error) throw profilesR.error;
      if (rolesR.error) throw rolesR.error;
      const rolesByUser = new Map<string, string[]>();
      for (const r of rolesR.data ?? []) {
        const arr = rolesByUser.get(r.user_id) ?? [];
        arr.push(r.role);
        rolesByUser.set(r.user_id, arr);
      }
      return { vans: vansR.data ?? [], profiles: profilesR.data ?? [], rolesByUser };
    },
  });

  const delVan = useMutation({
    mutationFn: async (id: string) => { await deleteVanFn({ data: { id } }); },
    onSuccess: () => {
      toast.success("Van deleted");
      qc.invalidateQueries({ queryKey: ["cleanup_inventory"] });
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
      qc.invalidateQueries({ queryKey: ["fleet_status"] });
      qc.invalidateQueries({ queryKey: ["offices"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to delete"),
  });

  const delUser = useMutation({
    mutationFn: async (id: string) => { await deleteProfileFn({ data: { id } }); },
    onSuccess: () => {
      toast.success("User deleted");
      qc.invalidateQueries({ queryKey: ["cleanup_inventory"] });
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
      qc.invalidateQueries({ queryKey: ["weekly_results"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to delete"),
  });

  return (
    <ArcadePanel
      title="Database Cleanup · Purge Mode"
      action={<span className="text-[10px] font-display uppercase tracking-widest text-destructive">Destructive · Owner Only</span>}
    >
      {q.isLoading || !q.data ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Vans */}
          <div>
            <h3 className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
              All Vans ({q.data.vans.length})
            </h3>
            <div className="space-y-1.5">
              {q.data.vans.length === 0 ? (
                <div className="text-xs text-muted-foreground italic">No vans.</div>
              ) : q.data.vans.map((v) => (
                <div key={v.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded border border-border bg-surface">
                  <div className="flex items-center gap-2 min-w-0">
                    <Truck className="w-4 h-4 shrink-0" style={{ color: v.color }} />
                    <TeamBadge name={v.name} color={v.color} />
                  </div>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={delVan.isPending}
                    onClick={() => {
                      if (confirm(`Permanently delete Van "${v.name}"? Members will become Unassigned.`)) {
                        delVan.mutate(v.id);
                      }
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {/* Users */}
          <div>
            <h3 className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
              All Users ({q.data.profiles.length})
            </h3>
            <div className="space-y-1.5 max-h-[480px] overflow-y-auto pr-1">
              {q.data.profiles.length === 0 ? (
                <div className="text-xs text-muted-foreground italic">No users.</div>
              ) : q.data.profiles.map((p) => {
                const roles = q.data.rolesByUser.get(p.id) ?? [];
                const isOwner = roles.includes("owner");
                return (
                  <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded border border-border bg-surface">
                    <div className="flex items-center gap-2 min-w-0">
                      <User className="w-4 h-4 shrink-0 text-muted-foreground" />
                      <span className="text-sm truncate">{p.display_name ?? "Unknown"}</span>
                      {roles.length > 0 && (
                        <span className="text-[9px] font-display uppercase tracking-widest text-muted-foreground">
                          · {roles.join(", ")}
                        </span>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={delUser.isPending || isOwner}
                      title={isOwner ? "Cannot delete an Owner here" : "Permanently delete user"}
                      onClick={() => {
                        if (confirm(`Permanently delete user "${p.display_name}"? This removes their account and data.`)) {
                          delUser.mutate(p.id);
                        }
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </ArcadePanel>
  );
}
