import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, MobileCard, MobileCardHeader, MobileCardList } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Clock,
  ChevronLeft,
  ChevronRight,
  Save,
  Trash2,
  AlertTriangle,
  Utensils,
} from "lucide-react";
import { useWeekSelector } from "@/hooks/useWeekSelector";
import { TimeClockReviewQueue } from "@/components/TimeClockReviewQueue";
import { TimeClockBackfill } from "@/components/TimeClockBackfill";
import { TimeClockExceptions } from "@/components/TimeClockExceptions";
import { TimeClockLiveShifts } from "@/components/TimeClockLiveShifts";
import { PushAlertsCard } from "@/components/PushAlertsCard";

// Weeks anchor to the LA Monday (midnight PT reset).
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
function toTimeInput(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Meal = { id: string; meal_start: string; meal_end: string | null };
type Entry = {
  id: string;
  user_id: string;
  clock_in: string;
  clock_out: string | null;
  log_date: string;
  billable_hours: number;
  entry_source: string;
  needs_correction: boolean;
  meal_status: string;
  meal_periods: Meal[];
};
type Profile = { id: string; display_name: string };

/** The lunch a row shows and edits: the earliest still-open or real-length
 *  meal. admin_set_meal always rewrites the earliest row and collapses any
 *  extras to zero length, so after a manager fix this IS the recorded lunch;
 *  `extra` counts additional worker-punched breaks still deducting time. */
function lunchOf(e: Entry) {
  const meals = (e.meal_periods ?? [])
    .filter((m) => m.meal_end === null || m.meal_end !== m.meal_start)
    .sort((a, b) => a.meal_start.localeCompare(b.meal_start));
  return { lunch: meals[0] ?? null, extra: Math.max(0, meals.length - 1) };
}

/** Meal states that need a human before payroll can approve the week. */
const MEAL_ATTENTION: Record<string, string> = {
  pending: "meal ?",
  unrecorded: "lunch times needed",
  missed: "no lunch · premium",
  taken_late: "late lunch · premium",
};

/** Save/Void pair — one component for the mobile card (labeled, full-width)
 *  and the desktop row (compact icons) so the dirty styling, disabled logic,
 *  and the reason prompts can never drift between views. Lunch edits ride the
 *  same Save: the row's Lunch Out/In fields are part of the form. */
function TimeEntryActions({
  compact = false,
  dirty,
  saving,
  deleting,
  onSave,
  onVoid,
}: {
  compact?: boolean;
  dirty: boolean;
  saving: boolean;
  deleting: boolean;
  onSave: () => void;
  onVoid: () => void;
}) {
  return (
    <div className={compact ? "flex items-center justify-end gap-1" : "flex gap-2"}>
      <Button
        size="sm"
        variant={dirty ? "default" : "outline"}
        disabled={!dirty || saving}
        onClick={onSave}
        className={cn(
          !compact && "flex-1",
          dirty && "bg-victory text-background hover:bg-victory/90",
        )}
      >
        <Save className="w-3.5 h-3.5" />
        {!compact && "Save"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={deleting}
        onClick={onVoid}
        className={cn(!compact && "flex-1")}
      >
        <Trash2 className="w-3.5 h-3.5 text-destructive" />
        {!compact && "Void"}
      </Button>
    </div>
  );
}

/** Chip row under a name: provenance + meal state that needs eyes. */
function EntryFlags({ e }: { e: Entry }) {
  const meal = MEAL_ATTENTION[e.meal_status];
  const { extra } = lunchOf(e);
  if (e.entry_source !== "auto_closed" && !e.needs_correction && !meal && extra === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1 ml-2 align-middle">
      {e.entry_source === "auto_closed" && (
        <span className="text-[9px] font-display uppercase tracking-widest text-warning border border-warning/40 rounded px-1">
          auto-closed
        </span>
      )}
      {e.needs_correction && (
        <span className="text-[9px] font-display uppercase tracking-widest text-destructive border border-destructive/40 rounded px-1">
          needs review
        </span>
      )}
      {meal && (
        <span className="text-[9px] font-display uppercase tracking-widest text-warning border border-warning/40 rounded px-1">
          {meal}
        </span>
      )}
      {extra > 0 && (
        <span
          className="text-[9px] font-display uppercase tracking-widest text-warning border border-warning/40 rounded px-1"
          title="Extra punched breaks also deduct time. Saving the lunch fields folds everything into that one lunch."
        >
          +{extra} break{extra > 1 ? "s" : ""}
        </span>
      )}
    </span>
  );
}

export function TimesheetEditor() {
  const qc = useQueryClient();
  const {
    weekStart,
    weekEnd,
    weekStartISO: start,
    weekEndISO: end,
    shiftWeek,
    goToWeek,
  } = useWeekSelector({ endOffsetDays: 6 });
  const [filterUser, setFilterUser] = useState<string>("");
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  // Lunch fields are HH:MM wall times on the shift's own day; clock fields
  // stay full datetime-local strings.
  const [edits, setEdits] = useState<
    Record<
      string,
      { clock_in?: string; clock_out?: string | null; lunch_out?: string; lunch_in?: string }
    >
  >({});

  const { data, isLoading } = useQuery({
    queryKey: ["timesheets", start, end],
    queryFn: async () => {
      const [entriesRes, profilesRes] = await Promise.all([
        supabase
          .from("time_entries")
          .select(
            "id, user_id, clock_in, clock_out, log_date, billable_hours, entry_source, needs_correction, meal_status, meal_periods (id, meal_start, meal_end)",
          )
          .gte("log_date", start)
          .lte("log_date", end)
          .is("voided_at", null)
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
    let list = data?.entries ?? [];
    if (needsReviewOnly) {
      list = list.filter(
        (e) => e.needs_correction || e.meal_status === "pending" || e.meal_status === "unrecorded",
      );
    }
    if (!filterUser) return list;
    const q = filterUser.toLowerCase();
    return list.filter((e) => {
      const n = profileById.get(e.user_id)?.display_name?.toLowerCase() ?? "";
      return n.includes(q);
    });
  }, [data?.entries, filterUser, needsReviewOnly, profileById]);

  const totalsByUser = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of data?.entries ?? []) {
      m.set(e.user_id, (m.get(e.user_id) ?? 0) + Number(e.billable_hours ?? 0));
    }
    return m;
  }, [data?.entries]);

  // All history edits flow through the reasoned RPCs: the database rejects a
  // privileged time edit without a reason, and every change lands in
  // time_entry_audit with actor + before/after. log_date is stamped
  // server-side from the LA calendar day of the new clock-in. One save
  // commits the whole row — punch times via admin_update_time_entry, lunch
  // via admin_set_meal — under the same reason.
  const saveMut = useMutation({
    mutationFn: async ({
      id,
      clock,
      meal,
      reason,
    }: {
      id: string;
      clock: { clock_in: string; clock_out: string | null } | null;
      meal: { start: string; end: string } | null;
      reason: string;
    }) => {
      if (clock) {
        const { error } = await supabase.rpc("admin_update_time_entry", {
          _id: id,
          _clock_in: clock.clock_in,
          _clock_out: clock.clock_out,
          _reason: reason,
        });
        if (error) throw error;
      }
      if (meal) {
        const { error } = await supabase.rpc("admin_set_meal", {
          _time_entry_id: id,
          _meal_start: meal.start,
          _meal_end: meal.end,
          _reason: reason,
        });
        if (error)
          throw new Error(
            clock ? `Punch times saved, but the lunch didn't: ${error.message}` : error.message,
          );
      }
    },
    onSuccess: (_d, vars) => {
      toast.success("Entry saved — hours repriced");
      setEdits((e) => {
        const { [vars.id]: _omit, ...rest } = e;
        return rest;
      });
      qc.invalidateQueries({ queryKey: ["timesheets"] });
      qc.invalidateQueries({ queryKey: ["payroll-ledger"] });
      qc.invalidateQueries({ queryKey: ["time-clock-open"] });
      qc.invalidateQueries({ queryKey: ["time-clock-today"] });
      qc.invalidateQueries({ queryKey: ["live-shifts"] });
    },
    onError: (e: Error) => toast.error("Update failed", { description: e.message }),
  });

  const voidMut = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc("void_time_entry", { _id: id, _reason: reason });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Time entry voided");
      qc.invalidateQueries({ queryKey: ["timesheets"] });
      qc.invalidateQueries({ queryKey: ["payroll-ledger"] });
    },
    onError: (e: Error) => toast.error("Void failed", { description: e.message }),
  });

  function saveRow(e: Entry) {
    const edit = edits[e.id];
    if (!edit) return;
    let clockIn = e.clock_in;
    let clockOut: string | null = e.clock_out;
    const clockDirty = edit.clock_in !== undefined || edit.clock_out !== undefined;
    if (edit.clock_in !== undefined) {
      const iso = fromLocalInput(edit.clock_in);
      if (!iso) {
        toast.error("Invalid clock-in time");
        return;
      }
      clockIn = iso;
    }
    if (edit.clock_out !== undefined) {
      if (edit.clock_out === "" || edit.clock_out === null) {
        clockOut = null;
      } else {
        const iso = fromLocalInput(edit.clock_out);
        if (!iso) {
          toast.error("Invalid clock-out time");
          return;
        }
        clockOut = iso;
      }
    }

    // Lunch: HH:MM fields anchored to the shift's day AS SAVED (edited
    // clock-in included), so fixing a wrong punch date moves the lunch with
    // it in the same save. An untouched field falls back to the recorded
    // lunch so editing just one side works.
    let meal: { start: string; end: string } | null = null;
    if (edit.lunch_out !== undefined || edit.lunch_in !== undefined) {
      const { lunch } = lunchOf(e);
      const outHM = edit.lunch_out ?? toTimeInput(lunch?.meal_start ?? null);
      const inHM = edit.lunch_in ?? toTimeInput(lunch?.meal_end ?? null);
      if (!outHM && !inHM) {
        toast.error(
          lunch
            ? "Recorded lunches can't be erased — type the corrected times instead."
            : "Enter both lunch times, or leave them blank.",
        );
        return;
      }
      if (!outHM || !inHM) {
        toast.error("Lunch needs both times — out and back in.");
        return;
      }
      const day = toLocalInput(clockIn).slice(0, 10);
      const start = new Date(`${day}T${outHM}:00`);
      const endD = new Date(`${day}T${inHM}:00`);
      if (isNaN(start.getTime()) || isNaN(endD.getTime())) {
        toast.error("Invalid lunch time");
        return;
      }
      if (endD <= start) {
        toast.error("Lunch end must be after lunch start");
        return;
      }
      if (
        start.getTime() < new Date(clockIn).getTime() ||
        (clockOut && endD.getTime() > new Date(clockOut).getTime())
      ) {
        toast.error("Lunch must fall inside the shift", {
          description: "Off by design? Fix the clock-in/out times in the same save.",
        });
        return;
      }
      meal = { start: start.toISOString(), end: endD.toISOString() };
    }

    if (!clockDirty && !meal) return;
    const reason = window.prompt("Reason for this change (required — it goes on the audit trail):");
    if (!reason || !reason.trim()) return;
    saveMut.mutate({
      id: e.id,
      clock: clockDirty ? { clock_in: clockIn, clock_out: clockOut } : null,
      meal,
      reason: reason.trim(),
    });
  }

  function voidRow(e: Entry, name: string) {
    const reason = window.prompt(
      `Void this ${e.log_date} entry for ${name}? Enter the reason (required):`,
    );
    if (!reason || !reason.trim()) return;
    voidMut.mutate({ id: e.id, reason: reason.trim() });
  }

  const weekLabel = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${weekEnd.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

  // One handler for every editable field (mobile/desktop × clock/lunch).
  const editField = (
    id: string,
    field: "clock_in" | "clock_out" | "lunch_out" | "lunch_in",
    value: string,
  ) => setEdits((s) => ({ ...s, [id]: { ...s[id], [field]: value } }));

  // Shared by the desktop table and mobile card list so both render identical
  // edit state through the same handlers.
  const rows = useMemo(
    () =>
      visibleEntries.map((e) => {
        const edit = edits[e.id] ?? {};
        const { lunch } = lunchOf(e);
        return {
          e,
          name: profileById.get(e.user_id)?.display_name ?? "Unknown",
          edit,
          dirty:
            edit.clock_in !== undefined ||
            edit.clock_out !== undefined ||
            edit.lunch_out !== undefined ||
            edit.lunch_in !== undefined,
          inVal: edit.clock_in ?? toLocalInput(e.clock_in),
          outVal: edit.clock_out !== undefined ? (edit.clock_out ?? "") : toLocalInput(e.clock_out),
          lunchOutVal: edit.lunch_out ?? toTimeInput(lunch?.meal_start ?? null),
          lunchInVal: edit.lunch_in ?? toTimeInput(lunch?.meal_end ?? null),
          // Open meal punch = they're at lunch right now.
          onLunchNow: !!lunch && !lunch.meal_end && edit.lunch_in === undefined,
        };
      }),
    [visibleEntries, edits, profileById],
  );

  return (
    <div className="space-y-4">
      {/* All-crew flagged punches — approve here or fix a row below. */}
      <TimeClockReviewQueue />
      <PushAlertsCard />

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
            <Button variant="ghost" size="sm" onClick={() => goToWeek()}>
              This Week
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={needsReviewOnly}
                onChange={(e) => setNeedsReviewOnly(e.target.checked)}
                className="accent-[var(--warning)]"
              />
              Needs review
            </label>
            <Input
              value={filterUser}
              onChange={(e) => setFilterUser(e.target.value)}
              placeholder="Filter by canvasser name…"
              className="max-w-xs"
            />
          </div>
        </div>

        <div className="mt-3 flex items-start gap-2 text-[11px] text-muted-foreground border-l-2 border-warning/60 pl-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-warning shrink-0" />
          <span>
            Every row shows the punches: clock in, lunch out/in, clock out. Hours are paid in full —
            only punched (or manager-entered) lunches are deducted, and Sundays pay when worked.
            Type corrections straight into the row and hit Save; every save and void needs a reason
            and lands on the audit trail. Auto-closed shifts are flagged; resolve them (fix the time
            or confirm it) before approving the week's payroll run.
          </span>
        </div>
      </ArcadePanel>

      {/* Owner/Manager tools beyond row edits: one-tap clock-out of anyone
          currently punched in, create whole entries for anyone (backfill),
          and pre-approve early starts / late finishes so known exceptions
          never flag or auto-close. */}
      <TimeClockLiveShifts profiles={data?.profiles ?? []} />
      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <TimeClockBackfill profiles={data?.profiles ?? []} />
        <TimeClockExceptions profiles={data?.profiles ?? []} />
      </div>

      <ArcadePanel title="Entries">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading time entries…</div>
        ) : visibleEntries.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            <Clock className="w-6 h-6 mx-auto mb-2 opacity-40" />
            No time entries for this week.
          </div>
        ) : (
          <>
            <MobileCardList>
              {rows.map(
                ({ e, name, edit, dirty, inVal, outVal, lunchOutVal, lunchInVal, onLunchNow }) => (
                  <MobileCard key={e.id}>
                    <MobileCardHeader
                      left={
                        <>
                          {name}
                          <EntryFlags e={e} />
                        </>
                      }
                      right={
                        <span className="text-neon tabular-nums">
                          {Number(e.billable_hours ?? 0).toFixed(2)}h
                        </span>
                      }
                    />
                    <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
                      <span className="text-muted-foreground">{e.log_date}</span>
                      <span className="font-display text-victory">
                        Week {(totalsByUser.get(e.user_id) ?? 0).toFixed(2)}h
                      </span>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                        Clock In
                      </span>
                      <Input
                        type="datetime-local"
                        value={inVal}
                        onChange={(v) => editField(e.id, "clock_in", v.target.value)}
                        className="w-full"
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block space-y-1">
                        <span className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                          <Utensils className="w-3 h-3 text-warning" />
                          Lunch Out
                        </span>
                        <Input
                          type="time"
                          value={lunchOutVal}
                          onChange={(v) => editField(e.id, "lunch_out", v.target.value)}
                          className="w-full"
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                          Lunch In
                          {onLunchNow && (
                            <span className="text-[9px] text-warning animate-pulse">out now</span>
                          )}
                        </span>
                        <Input
                          type="time"
                          value={lunchInVal}
                          onChange={(v) => editField(e.id, "lunch_in", v.target.value)}
                          className="w-full"
                        />
                      </label>
                    </div>
                    <label className="block space-y-1">
                      <span className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                        Clock Out
                        {!e.clock_out && !edit.clock_out && (
                          <span className="text-[9px] text-victory animate-pulse">live</span>
                        )}
                      </span>
                      <Input
                        type="datetime-local"
                        value={outVal}
                        onChange={(v) => editField(e.id, "clock_out", v.target.value)}
                        className="w-full"
                      />
                    </label>
                    <TimeEntryActions
                      dirty={dirty}
                      saving={saveMut.isPending}
                      deleting={voidMut.isPending}
                      onSave={() => saveRow(e)}
                      onVoid={() => voidRow(e, name)}
                    />
                  </MobileCard>
                ),
              )}
            </MobileCardList>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] font-display uppercase tracking-widest text-muted-foreground border-b border-border">
                    <th className="text-left py-2 pr-3">Canvasser</th>
                    <th className="text-left py-2 pr-3">Date</th>
                    <th className="text-left py-2 pr-3">Clock In</th>
                    <th className="text-left py-2 pr-3">Lunch Out</th>
                    <th className="text-left py-2 pr-3">Lunch In</th>
                    <th className="text-left py-2 pr-3">Clock Out</th>
                    <th className="text-right py-2 pr-3">Billable</th>
                    <th className="text-right py-2 pr-3">Week Total</th>
                    <th className="text-right py-2 pr-1">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(
                    ({
                      e,
                      name,
                      edit,
                      dirty,
                      inVal,
                      outVal,
                      lunchOutVal,
                      lunchInVal,
                      onLunchNow,
                    }) => {
                      return (
                        <tr
                          key={e.id}
                          className="border-b border-border/40 transition-colors duration-200 hover:bg-surface-elevated"
                        >
                          <td className="py-2 pr-3 font-medium">
                            {name}
                            <EntryFlags e={e} />
                          </td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground tabular-nums">
                            {e.log_date}
                          </td>
                          <td className="py-2 pr-3">
                            <Input
                              type="datetime-local"
                              value={inVal}
                              onChange={(v) => editField(e.id, "clock_in", v.target.value)}
                              className="h-8 text-xs w-full min-w-[150px]"
                            />
                          </td>
                          <td className="py-2 pr-3">
                            <Input
                              type="time"
                              value={lunchOutVal}
                              onChange={(v) => editField(e.id, "lunch_out", v.target.value)}
                              className="h-8 text-xs w-[92px]"
                            />
                          </td>
                          <td className="py-2 pr-3">
                            <div className="flex items-center gap-1">
                              <Input
                                type="time"
                                value={lunchInVal}
                                onChange={(v) => editField(e.id, "lunch_in", v.target.value)}
                                className="h-8 text-xs w-[92px]"
                              />
                              {onLunchNow && (
                                <span className="text-[9px] font-display uppercase text-warning animate-pulse">
                                  out now
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-2 pr-3">
                            <div className="flex items-center gap-1">
                              <Input
                                type="datetime-local"
                                value={outVal}
                                onChange={(v) => editField(e.id, "clock_out", v.target.value)}
                                className="h-8 text-xs w-full min-w-[150px]"
                              />
                              {!e.clock_out && !edit.clock_out && (
                                <span className="text-[9px] font-display uppercase text-victory animate-pulse">
                                  live
                                </span>
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
                            <TimeEntryActions
                              compact
                              dirty={dirty}
                              saving={saveMut.isPending}
                              deleting={voidMut.isPending}
                              onSave={() => saveRow(e)}
                              onVoid={() => voidRow(e, name)}
                            />
                          </td>
                        </tr>
                      );
                    },
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </ArcadePanel>
    </div>
  );
}
