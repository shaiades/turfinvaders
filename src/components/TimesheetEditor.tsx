import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Clock, ChevronLeft, ChevronRight, Save, Trash2, AlertTriangle } from "lucide-react";

function weekStartOf(d: Date) {
  const x = new Date(d);
  const day = x.getDay(); // 0 Sun..6 Sat
  const mondayOffset = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + mondayOffset);
  x.setHours(0, 0, 0, 0);
  return x;
}
function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function toLocalInput(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(s: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

type Entry = {
  id: string;
  user_id: string;
  clock_in: string;
  clock_out: string | null;
  log_date: string;
  billable_hours: number;
};
type Profile = { id: string; display_name: string };

export function TimesheetEditor() {
  const qc = useQueryClient();
  const [weekStart, setWeekStart] = useState<Date>(weekStartOf(new Date()));
  const [filterUser, setFilterUser] = useState<string>("");
  const [edits, setEdits] = useState<Record<string, { clock_in?: string; clock_out?: string | null }>>({});

  const start = ymd(weekStart);
  const end = ymd(new Date(weekStart.getTime() + 6 * 86400000));

  const { data, isLoading } = useQuery({
    queryKey: ["timesheets", start, end],
    queryFn: async () => {
      const [entriesRes, profilesRes] = await Promise.all([
        supabase
          .from("time_entries")
          .select("id, user_id, clock_in, clock_out, log_date, billable_hours")
          .gte("log_date", start)
          .lte("log_date", end)
          .order("log_date", { ascending: false })
          .order("clock_in", { ascending: false }),
        supabase.from("profiles").select("id, display_name"),
      ]);
      if (entriesRes.error) throw entriesRes.error;
      if (profilesRes.error) throw profilesRes.error;
      return {
        entries: (entriesRes.data ?? []) as Entry[],
        profiles: (profilesRes.data ?? []) as Profile[],
      };
    },
  });

  const profileById = useMemo(
    () => new Map((data?.profiles ?? []).map((p) => [p.id, p])),
    [data?.profiles],
  );

  const visibleEntries = useMemo(() => {
    const list = data?.entries ?? [];
    if (!filterUser) return list;
    const q = filterUser.toLowerCase();
    return list.filter((e) => {
      const n = profileById.get(e.user_id)?.display_name?.toLowerCase() ?? "";
      return n.includes(q);
    });
  }, [data?.entries, filterUser, profileById]);

  const totalsByUser = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of data?.entries ?? []) {
      m.set(e.user_id, (m.get(e.user_id) ?? 0) + Number(e.billable_hours ?? 0));
    }
    return m;
  }, [data?.entries]);

  const saveMut = useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: { clock_in?: string; clock_out?: string | null; log_date?: string };
    }) => {
      const { error } = await supabase.from("time_entries").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success("Time entry updated");
      setEdits((e) => {
        const { [vars.id]: _omit, ...rest } = e;
        return rest;
      });
      qc.invalidateQueries({ queryKey: ["timesheets"] });
      qc.invalidateQueries({ queryKey: ["payroll-ledger"] });
      qc.invalidateQueries({ queryKey: ["time-clock-open"] });
      qc.invalidateQueries({ queryKey: ["time-clock-today"] });
    },
    onError: (e: Error) => toast.error("Update failed", { description: e.message }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("time_entries").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Time entry deleted");
      qc.invalidateQueries({ queryKey: ["timesheets"] });
      qc.invalidateQueries({ queryKey: ["payroll-ledger"] });
    },
    onError: (e: Error) => toast.error("Delete failed", { description: e.message }),
  });

  function shiftWeek(delta: number) {
    const next = new Date(weekStart);
    next.setDate(next.getDate() + delta * 7);
    setWeekStart(weekStartOf(next));
  }

  function saveRow(e: Entry) {
    const edit = edits[e.id];
    if (!edit) return;
    const patch: { clock_in?: string; clock_out?: string | null; log_date?: string } = {};
    if (edit.clock_in !== undefined) {
      const iso = fromLocalInput(edit.clock_in);
      if (!iso) { toast.error("Invalid clock-in time"); return; }
      patch.clock_in = iso;
      patch.log_date = iso.slice(0, 10);
    }
    if (edit.clock_out !== undefined) {
      if (edit.clock_out === "" || edit.clock_out === null) {
        patch.clock_out = null;
      } else {
        const iso = fromLocalInput(edit.clock_out);
        if (!iso) { toast.error("Invalid clock-out time"); return; }
        patch.clock_out = iso;
      }
    }
    saveMut.mutate({ id: e.id, patch });
  }

  const weekLabel = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(
    weekStart.getTime() + 6 * 86400000,
  ).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

  return (
    <div className="space-y-4">
      <ArcadePanel title="Timesheets · Owner Edit Mode">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => shiftWeek(-1)}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <div className="font-display text-sm text-neon px-2 tabular-nums">{weekLabel}</div>
            <Button variant="outline" size="sm" onClick={() => shiftWeek(1)}>
              <ChevronRight className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setWeekStart(weekStartOf(new Date()))}>
              This Week
            </Button>
          </div>
          <Input
            value={filterUser}
            onChange={(e) => setFilterUser(e.target.value)}
            placeholder="Filter by canvasser name…"
            className="max-w-xs"
          />
        </div>

        <div className="mt-3 flex items-start gap-2 text-[11px] text-muted-foreground border-l-2 border-warning/60 pl-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-warning shrink-0" />
          <span>
            Lunch deduction (30 min) and daily caps (7.5h M–F, 6.5h Sat) recalculate automatically on save.
            Forgotten shifts auto-close at 6:00 PM weekdays / 5:00 PM Saturdays.
          </span>
        </div>
      </ArcadePanel>

      <ArcadePanel title="Entries">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading time entries…</div>
        ) : visibleEntries.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            <Clock className="w-6 h-6 mx-auto mb-2 opacity-40" />
            No time entries for this week.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] font-display uppercase tracking-widest text-muted-foreground border-b border-border">
                  <th className="text-left py-2 pr-3">Canvasser</th>
                  <th className="text-left py-2 pr-3">Date</th>
                  <th className="text-left py-2 pr-3">Clock In</th>
                  <th className="text-left py-2 pr-3">Clock Out</th>
                  <th className="text-right py-2 pr-3">Billable</th>
                  <th className="text-right py-2 pr-3">Week Total</th>
                  <th className="text-right py-2 pr-1">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleEntries.map((e) => {
                  const name = profileById.get(e.user_id)?.display_name ?? "Unknown";
                  const edit = edits[e.id] ?? {};
                  const dirty = edit.clock_in !== undefined || edit.clock_out !== undefined;
                  const inVal = edit.clock_in ?? toLocalInput(e.clock_in);
                  const outVal =
                    edit.clock_out !== undefined
                      ? (edit.clock_out ?? "")
                      : toLocalInput(e.clock_out);
                  return (
                    <tr key={e.id} className="border-b border-border/40 hover:bg-surface-elevated">
                      <td className="py-2 pr-3 font-medium">{name}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground tabular-nums">{e.log_date}</td>
                      <td className="py-2 pr-3">
                        <Input
                          type="datetime-local"
                          value={inVal}
                          onChange={(v) =>
                            setEdits((s) => ({ ...s, [e.id]: { ...s[e.id], clock_in: v.target.value } }))
                          }
                          className="h-8 text-xs w-[170px]"
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-1">
                          <Input
                            type="datetime-local"
                            value={outVal}
                            onChange={(v) =>
                              setEdits((s) => ({ ...s, [e.id]: { ...s[e.id], clock_out: v.target.value } }))
                            }
                            className="h-8 text-xs w-[170px]"
                          />
                          {!e.clock_out && !edit.clock_out && (
                            <span className="text-[9px] font-display uppercase text-victory animate-pulse">live</span>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right font-display text-neon tabular-nums">
                        {Number(e.billable_hours ?? 0).toFixed(2)}h
                      </td>
                      <td className="py-2 pr-3 text-right font-display text-victory tabular-nums">
                        {(totalsByUser.get(e.user_id) ?? 0).toFixed(2)}h
                      </td>
                      <td className="py-2 pr-1 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant={dirty ? "default" : "outline"}
                            disabled={!dirty || saveMut.isPending}
                            onClick={() => saveRow(e)}
                            className={dirty ? "bg-victory text-background hover:bg-victory/90" : ""}
                          >
                            <Save className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={deleteMut.isPending}
                            onClick={() => {
                              if (confirm(`Delete this time entry for ${name}?`)) deleteMut.mutate(e.id);
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </ArcadePanel>
    </div>
  );
}
