import { useMemo, useState } from "react";
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

function leadsSum(r: { demos_sits?: number | null; sales?: number | null; no_demo?: number | null; one_legs?: number | null; future_leads?: number | null }) {
  return (r.demos_sits ?? 0) + (r.sales ?? 0) + (r.no_demo ?? 0) + (r.one_legs ?? 0) + (r.future_leads ?? 0);
}

/* ============ Main ============ */

export function ExecutiveDashboard() {
  return (
    <div className="space-y-6">
      <DatabaseCleanup />
      <LiveFleetStatus />
      <WeeklyResults />
    </div>
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
      const agg = new Map<string, { leads: number; sits: number; points: number }>();
      for (const l of logsR.data ?? []) {
        const cur = agg.get(l.canvasser_id) ?? { leads: 0, sits: 0, points: 0 };
        cur.leads += leadsSum(l);
        cur.sits += (l.demos_sits ?? 0) + (l.sales ?? 0);
        cur.points += (l.demos_sits ?? 0) + 2 * (l.sales ?? 0);
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
        rows.push({
          canvasserId: id,
          name: p?.display_name ?? "Unknown",
          vanName: v?.name ?? null,
          vanColor: v?.color ?? null,
          totalLeads: a.leads,
          totalSits: a.sits,
          totalPoints: a.points,
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
      points: acc.points + r.totalPoints,
      pay: acc.pay + r.totalPay,
    }),
    { leads: 0, sits: 0, points: 0, pay: 0 }
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
                  <td className="px-4 py-2.5 text-right font-display">{r.totalPoints}</td>
                  <td className="px-4 py-2.5 text-right font-display text-victory">${r.totalPay.toFixed(2)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-neon/60 bg-surface">
                <td className="px-4 py-2.5 font-display text-xs uppercase tracking-widest text-neon" colSpan={2}>Grand Total</td>
                <td className="px-4 py-2.5 text-right font-display">{grand.leads}</td>
                <td className="px-4 py-2.5 text-right font-display">{grand.sits}</td>
                <td className="px-4 py-2.5 text-right font-display">{grand.points}</td>
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
