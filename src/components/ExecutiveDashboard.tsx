import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  ArcadePanel,
  MobileCardList,
  MobileCard,
  MobileCardHeader,
  MobileStatGrid,
  MobileStat,
  metricText,
} from "@/components/arcade";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { upsertManualWeekly } from "@/lib/fleet.functions";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { useOfficeFilter } from "@/components/OfficeFilterContext";
import { laTodayISO, laWeekStartISO, weekStartOfISO } from "@/lib/dates";
import { DEFAULT_OFFICE } from "@/lib/offices";


/* ============ Helpers ============ */
/* All day/week/month buckets are America/Los_Angeles (midnight PT resets). */

/* Numeric grid cells share one recipe per table so dim-at-zero coloring
 * (metricText) composes without blowing past the print width. */
const dailyCell = "px-3 py-1.5 text-right font-mono";


// One board card = one lead (Setter Report parity). demos_sits already
// includes sold sits, so sales is not added again. OL is intentionally NOT
// in the total — outside leads are their own column, and the Monday chart
// totals don't include them either.
function leadsSum(r: { demos_sits?: number | null; no_demo?: number | null; ctc?: number | null; future_leads?: number | null; unmarked?: number | null }) {
  return (r.demos_sits ?? 0) + (r.no_demo ?? 0) + (r.ctc ?? 0) + (r.future_leads ?? 0) + (r.unmarked ?? 0);
}

/* ============ Main ============ */

// Slimmed 2026-07-22: Payroll lives only in the Payroll tab, fleet status in
// the Fleet tab, CSV import in the header dialog, and DatabaseCleanup on the
// Manage Players screen — the Executive tab no longer restated them.
// Merged 2026-08-04: the Executive tab itself is gone; these panels now render
// inside Fleet Dispatch, under ITS OfficeFilterProvider — no provider or
// office toggle of their own.
export function ExecutiveSection() {
  // Weekly Results + its week selector removed 2026-08-14 (owner request):
  // the Fleet Dispatch board above already shows the current week, and past
  // weeks' pay lives in the Payroll tab.
  return (
    <div className="space-y-6">
      <ManualEntryBar />
      <LiveDailyAction />
      <RawDataTable />
    </div>
  );
}


/* ============ Live Daily Action (Today) ============ */

function LiveDailyAction() {
  const today = useMemo(() => laTodayISO(), []);

  const q = useQuery({
    queryKey: ["live_daily_action", today],
    queryFn: async () => {
      const [logsR, profilesR, vansR, rolesR] = await Promise.all([
        supabase
          .from("daily_logs")
          .select("canvasser_id, team_id, leads_called_in, next_days, future_leads, no_demo, confirmed_leads")
          .eq("log_date", today),
        supabase.from("profiles").select("id, display_name, team_id, suspension_tracked"),
        supabase.from("teams").select("id, name, color"),
        supabase.from("user_roles").select("user_id, role"),
      ]);
      if (logsR.error) throw logsR.error;
      if (profilesR.error) throw profilesR.error;
      if (vansR.error) throw vansR.error;
      if (rolesR.error) throw rolesR.error;
      const rolesByUser = new Map<string, string[]>();
      for (const r of rolesR.data ?? []) {
        const arr = rolesByUser.get(r.user_id) ?? [];
        arr.push(r.role);
        rolesByUser.set(r.user_id, arr);
      }

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

      // Donut List: every CANVASSER (or captain) on a Van who has NOT logged
      // a Confirmed_Next_Day or Confirmed_Future ping today. Sales reps never
      // appear — suspension is canvassers-only (owner, 2026-08-04) — and
      // suspension-exempt profiles (confirmers, lead sources) are skipped.
      const confirmedToday = new Set(
        logs
          .filter((r) => (r.next_days ?? 0) > 0 || (r.future_leads ?? 0) > 0)
          .map((r) => r.canvasser_id),
      );
      const vanById = new Map((vansR.data ?? []).map((v) => [v.id, v]));
      const donut = (profilesR.data ?? [])
        .filter((p) => {
          if (!p.team_id || confirmedToday.has(p.id)) return false;
          if (p.suspension_tracked === false) return false;
          const roles = rolesByUser.get(p.id) ?? [];
          if (roles.includes("sales_rep")) return false;
          return roles.includes("canvasser") || roles.includes("captain");
        })
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
  useRealtimeInvalidate({
    channel: "live-daily-action",
    tables: ["daily_logs"],
    invalidateKeys: [["live_daily_action", today]],
  });

  const t = q.data?.totals ?? { called: 0, nextDay: 0, future: 0, blowout: 0 };
  const donut = q.data?.donut ?? [];

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="font-display text-sm uppercase tracking-widest text-foreground">Live Daily Action</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{today}</p>
        </div>
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
      action={
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Raw · Newest First
        </span>
      }
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
                  right={
                    <span className="text-muted-foreground font-mono text-xs">{r.log_date}</span>
                  }
                />
                <MobileStatGrid cols={4}>
                  <MobileStat label="Sits" value={r.demos_sits} lit="text-foreground" />
                  <MobileStat label="Sales" value={r.sales} lit="text-victory" />
                  <MobileStat label="Confirmed" value={r.confirmed_leads} lit="text-foreground" />
                  <MobileStat label="No Demo" value={r.no_demo} lit="text-foreground" />
                  <MobileStat label="One Legs" value={r.one_legs} lit="text-foreground" />
                  <MobileStat label="Future" value={r.future_leads} lit="text-foreground" />
                  <MobileStat label="Talked" value={r.people_talked_to} lit="text-foreground" />
                  <MobileStat label="Called In" value={r.leads_called_in} lit="text-foreground" />
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
                  <tr
                    key={r.id}
                    className="border-t border-border transition-colors duration-200 hover:bg-surface-elevated"
                  >
                    <td className="px-3 py-1.5 font-mono">{r.log_date}</td>
                    <td className="px-3 py-1.5">{r.name}</td>
                    <td className={cn(dailyCell, metricText(r.demos_sits, "text-foreground"))}>
                      {r.demos_sits}
                    </td>
                    <td className={cn(dailyCell, metricText(r.sales, "text-victory"))}>
                      {r.sales}
                    </td>
                    <td className={cn(dailyCell, metricText(r.no_demo, "text-foreground"))}>
                      {r.no_demo}
                    </td>
                    <td className={cn(dailyCell, metricText(r.one_legs, "text-foreground"))}>
                      {r.one_legs}
                    </td>
                    <td className={cn(dailyCell, metricText(r.future_leads, "text-foreground"))}>
                      {r.future_leads}
                    </td>
                    <td
                      className={cn(dailyCell, metricText(r.people_talked_to, "text-foreground"))}
                    >
                      {r.people_talked_to}
                    </td>
                    <td className={cn(dailyCell, metricText(r.leads_called_in, "text-foreground"))}>
                      {r.leads_called_in}
                    </td>
                    <td className={cn(dailyCell, metricText(r.confirmed_leads, "text-foreground"))}>
                      {r.confirmed_leads}
                    </td>
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

