import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Thermometer, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { addDaysISO, laTodayISO, laWeekStartISO } from "@/lib/dates";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KIND_LABEL, useDayOffMutations, type DayOffKind } from "@/hooks/useDayOff";

const DAY_LABEL = ["M", "T", "W", "T", "F", "S", "S"];

/** The production manager's console (Austin — owner ask 2026-11-24), on the
 *  Office Portal's Production tab. Three jobs, nothing else: see production
 *  staff's time cards (read-only — fixing punches stays with HR/owners),
 *  approve or deny their pending time-off, and record a sick day. RLS lets a
 *  production_manager read only production-role workers' rows, and the
 *  submit/review RPCs enforce the same scope server-side. */
export function ProductionTeamPanel() {
  const qc = useQueryClient();
  const today = laTodayISO();
  const [weekStart, setWeekStart] = useState(laWeekStartISO());
  const weekEnd = addDaysISO(weekStart, 6);
  const { submit, review } = useDayOffMutations();

  // Production-role workers (user_roles is world-readable; profiles too).
  const teamQ = useQuery({
    queryKey: ["production-team"],
    queryFn: async () => {
      const { data: roleRows, error: rErr } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("role", "production");
      if (rErr) throw rErr;
      const ids = (roleRows ?? []).map((r) => r.user_id);
      if (ids.length === 0) return [] as Array<{ id: string; name: string }>;
      const { data: profs, error: pErr } = await supabase
        .from("profiles")
        .select("id, display_name, is_active")
        .in("id", ids);
      if (pErr) throw pErr;
      return (profs ?? [])
        .filter((p) => p.is_active !== false)
        .map((p) => ({ id: p.id, name: p.display_name ?? "Unknown" }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  });
  const team = teamQ.data ?? [];

  // The week's hours, one query for the whole crew.
  const hoursQ = useQuery({
    enabled: team.length > 0,
    queryKey: ["production-team-hours", weekStart, team.map((t) => t.id).join("|")],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_entries")
        .select("user_id, log_date, billable_hours, clock_out")
        .in(
          "user_id",
          team.map((t) => t.id),
        )
        .gte("log_date", weekStart)
        .lte("log_date", weekEnd)
        .is("voided_at", null);
      if (error) throw error;
      const byUser = new Map<string, Map<string, { hours: number; open: boolean }>>();
      for (const row of data ?? []) {
        const days = byUser.get(row.user_id) ?? new Map();
        const prev = days.get(row.log_date) ?? { hours: 0, open: false };
        days.set(row.log_date, {
          hours: prev.hours + Number(row.billable_hours ?? 0),
          open: prev.open || row.clock_out === null,
        });
        byUser.set(row.user_id, days);
      }
      return byUser;
    },
  });

  // Pending time-off from production staff (RLS already scopes the read).
  const pendingQ = useQuery({
    enabled: team.length > 0,
    queryKey: ["production-team-pending", team.map((t) => t.id).join("|")],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("day_off_requests")
        .select("id, user_id, absence_date, kind, reason")
        .in(
          "user_id",
          team.map((t) => t.id),
        )
        .eq("status", "pending")
        .order("absence_date");
      if (error) throw error;
      return data ?? [];
    },
  });

  const nameOf = (id: string) => team.find((t) => t.id === id)?.name ?? "Unknown";
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["production-team-pending"] });
    qc.invalidateQueries({ queryKey: ["day-off"] });
  };

  // ---- Mark sick ----
  const [sickFor, setSickFor] = useState<string>("");
  const [sickDate, setSickDate] = useState<string>(today);
  const [sickNote, setSickNote] = useState("");
  const [denyFor, setDenyFor] = useState<{ id: string; name: string } | null>(null);
  const [denyNote, setDenyNote] = useState("");

  async function markSick() {
    if (!sickFor) {
      toast.error("Pick who's out sick");
      return;
    }
    try {
      const res = await submit.mutateAsync({
        userId: sickFor,
        dates: [sickDate],
        kind: "sick" as DayOffKind,
        reason: sickNote.trim() || undefined,
      });
      if (res.ok > 0) {
        toast.success(`${nameOf(sickFor)} marked sick · ${sickDate}`);
        setSickFor("");
        setSickNote("");
        setSickDate(today);
        refresh();
      } else {
        toast.error("Already marked for that day");
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function decide(id: string, approve: boolean, note?: string) {
    try {
      await review.mutateAsync({ id, approve, denyReason: note });
      toast.success(approve ? "Approved" : "Denied — they'll see your note");
      setDenyFor(null);
      setDenyNote("");
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const pending = pendingQ.data ?? [];

  return (
    <>
      {/* ---- Pending time off ---- */}
      <ArcadePanel title={`Time-Off Requests${pending.length ? ` · ${pending.length}` : ""}`}>
        {pending.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing waiting on you.</p>
        ) : (
          <div className="space-y-2">
            {pending.map((r) => (
              <div key={r.id} className="rounded-md border border-border bg-surface p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{nameOf(r.user_id)}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.absence_date} · {KIND_LABEL[r.kind as DayOffKind] ?? r.kind}
                      {r.reason ? ` — “${r.reason}”` : ""}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={review.isPending}
                      onClick={() => decide(r.id, true)}
                      className="min-h-11 md:min-h-8 bg-victory text-background hover:bg-victory/90 font-display text-[10px] uppercase tracking-widest"
                    >
                      <Check className="w-3.5 h-3.5 mr-1" /> Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={review.isPending}
                      onClick={() => setDenyFor({ id: r.id, name: nameOf(r.user_id) })}
                      className="min-h-11 md:min-h-8 border-destructive/60 text-destructive font-display text-[10px] uppercase tracking-widest"
                    >
                      <X className="w-3.5 h-3.5 mr-1" /> Deny
                    </Button>
                  </div>
                </div>
                {denyFor?.id === r.id ? (
                  <div className="mt-2 space-y-2">
                    <Textarea
                      value={denyNote}
                      onChange={(e) => setDenyNote(e.target.value)}
                      placeholder={`Note to ${denyFor.name} (required)`}
                      className="text-base md:text-sm"
                      rows={2}
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={!denyNote.trim() || review.isPending}
                        onClick={() => decide(r.id, false, denyNote.trim())}
                        className="min-h-11 md:min-h-8 font-display text-[10px] uppercase tracking-widest"
                      >
                        Send denial
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDenyFor(null)}
                        className="min-h-11 md:min-h-8 font-display text-[10px] uppercase tracking-widest"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </ArcadePanel>

      {/* ---- Mark sick ---- */}
      <ArcadePanel title="Mark Sick">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Select value={sickFor || undefined} onValueChange={setSickFor}>
            <SelectTrigger className="text-base md:text-sm">
              <SelectValue placeholder="Who's out?" />
            </SelectTrigger>
            <SelectContent className="bg-background">
              {team.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="date"
            value={sickDate}
            onChange={(e) => setSickDate(e.target.value)}
            className="text-base md:text-sm"
          />
        </div>
        <Input
          value={sickNote}
          onChange={(e) => setSickNote(e.target.value)}
          placeholder="Note (optional)"
          className="mt-2 text-base md:text-sm"
        />
        <Button
          onClick={markSick}
          disabled={submit.isPending}
          className="mt-2 w-full sm:w-auto min-h-11 md:min-h-9 font-display text-[10px] uppercase tracking-widest"
        >
          <Thermometer className="w-3.5 h-3.5 mr-1" />
          {submit.isPending ? "Saving…" : "Mark sick"}
        </Button>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Goes on their record as an approved sick day and draws from their sick bank. They get a
          push so nothing is entered behind their back.
        </p>
      </ArcadePanel>

      {/* ---- Week of time cards ---- */}
      <ArcadePanel
        title="Time Cards"
        action={
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setWeekStart(addDaysISO(weekStart, -7))}
              className="min-h-11 md:min-h-7 px-2"
              aria-label="Previous week"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="font-mono text-xs text-muted-foreground whitespace-nowrap">
              {weekStart}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={addDaysISO(weekStart, 7) > today}
              onClick={() => setWeekStart(addDaysISO(weekStart, 7))}
              className="min-h-11 md:min-h-7 px-2"
              aria-label="Next week"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        }
      >
        {team.length === 0 ? (
          <p className="text-xs text-muted-foreground">No production staff yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  <th className="text-left py-1.5 pr-2">Name</th>
                  {DAY_LABEL.map((d, i) => (
                    <th key={i} className="text-right px-1.5 py-1.5 font-mono">
                      {d}
                    </th>
                  ))}
                  <th className="text-right pl-2 py-1.5">Total</th>
                </tr>
              </thead>
              <tbody>
                {team.map((t) => {
                  const days = hoursQ.data?.get(t.id);
                  let total = 0;
                  return (
                    <tr key={t.id} className="border-t border-border/60">
                      <td className="py-1.5 pr-2 truncate max-w-[9rem]">{t.name}</td>
                      {DAY_LABEL.map((_, i) => {
                        const iso = addDaysISO(weekStart, i);
                        const d = days?.get(iso);
                        if (d) total += d.hours;
                        return (
                          <td key={i} className="text-right px-1.5 py-1.5 font-mono">
                            {d ? (
                              <span className={d.open ? "text-neon" : undefined}>
                                {d.hours.toFixed(1)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground/40">·</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="text-right pl-2 py-1.5 font-mono text-victory">
                        {total.toFixed(1)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">
          Hours are read-only here — punch fixes go through HR. Green = on the clock now.
        </p>
      </ArcadePanel>
    </>
  );
}
