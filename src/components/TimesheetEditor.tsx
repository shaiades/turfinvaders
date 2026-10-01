import { Fragment, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, MobileCard, MobileCardHeader, MobileCardList } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Clock,
  ChevronLeft,
  ChevronRight,
  History,
  Save,
  Trash2,
  AlertTriangle,
  Utensils,
  CalendarPlus,
  KeyRound,
  Square,
} from "lucide-react";
import { useWeekSelector } from "@/hooks/useWeekSelector";
import { TimeClockReviewQueue } from "@/components/TimeClockReviewQueue";
import { TimeClockBackfill } from "@/components/TimeClockBackfill";
import { TimeClockExceptions } from "@/components/TimeClockExceptions";
import { ReasonDialog } from "@/components/ReasonDialog";
import { TimeEntryAuditSheet } from "@/components/TimeEntryAuditSheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { laTimeHM, laWallFromISO, laWallToUtcISO } from "@/lib/dates";
import { invalidatePunchCaches } from "@/lib/time-clock-keys";

// Weeks anchor to the LA Monday (midnight PT reset). Every editable field is
// a PACIFIC wall time (owner directive 2026-07-20) — the old helpers here
// used the viewer's device timezone, which silently shifted punches for
// anyone editing from outside LA.
const toLocalInput = laWallFromISO;
const fromLocalInput = laWallToUtcISO;
const toTimeInput = laTimeHM;

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
  onHistory,
}: {
  compact?: boolean;
  dirty: boolean;
  saving: boolean;
  deleting: boolean;
  onSave: () => void;
  onVoid: () => void;
  onHistory: () => void;
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
      <Button size="sm" variant="outline" onClick={onHistory} title="Change history (audit trail)">
        <History className="w-3.5 h-3.5" />
        {!compact && "History"}
      </Button>
    </div>
  );
}

/** Worker sign-off chip. undefined = attestation table not deployed yet
 *  (silent); null = no sign-off this week. */
function AttestChip({ a }: { a: { status: string; note?: string | null } | null | undefined }) {
  if (a === undefined) return null;
  if (a === null) {
    return (
      <span className="text-[9px] font-display uppercase tracking-widest text-muted-foreground border border-border rounded px-1">
        not attested
      </span>
    );
  }
  return a.status === "confirmed" ? (
    <span className="text-[9px] font-display uppercase tracking-widest text-victory border border-victory/40 rounded px-1">
      attested ✓
    </span>
  ) : (
    <span
      className="text-[9px] font-display uppercase tracking-widest text-destructive border border-destructive/40 rounded px-1"
      title={a.note ?? undefined}
    >
      disputed{a.note ? ` · “${a.note}”` : ""}
    </span>
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

/** Admin: the whole crew. Captains mount it with scope={{teamId}} — their
 *  van only, no Passes (a manager power); the adjust RPCs enforce the same
 *  team boundary (and never-self) server-side. */
export function TimesheetEditor({ scope }: { scope?: { teamId: string } }) {
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
  const [addEntryOpen, setAddEntryOpen] = useState(false);
  const [addEntryUserId, setAddEntryUserId] = useState<string | null>(null);
  const [passesOpen, setPassesOpen] = useState(false);
  const [weekPickerOpen, setWeekPickerOpen] = useState(false);
  const [auditFor, setAuditFor] = useState<{ ids: string[]; title: string } | null>(null);
  // The pending audited change awaiting its reason (ReasonDialog).
  const [reasonReq, setReasonReq] = useState<
    | {
        kind: "save";
        id: string;
        clock: { clock_in: string; clock_out: string | null } | null;
        meal: { start: string; end: string } | null;
        prompt: string;
      }
    | { kind: "void"; id: string; prompt: string }
    | { kind: "clockout"; id: string; clockIn: string; prompt: string }
    | null
  >(null);
  // Lunch fields are HH:MM wall times on the shift's own day; clock fields
  // stay full datetime-local strings.
  const [edits, setEdits] = useState<
    Record<
      string,
      { clock_in?: string; clock_out?: string | null; lunch_out?: string; lunch_in?: string }
    >
  >({});

  const { data, isLoading } = useQuery({
    queryKey: ["timesheets", start, end, scope?.teamId ?? "all"],
    queryFn: async () => {
      let profilesQ = supabase.from("profiles").select("id, display_name");
      if (scope) profilesQ = profilesQ.eq("team_id", scope.teamId);
      const profilesRes = await profilesQ;
      if (profilesRes.error) throw profilesRes.error;
      const profiles = (profilesRes.data ?? []) as Profile[];

      let entriesQ = supabase
        .from("time_entries")
        .select(
          "id, user_id, clock_in, clock_out, log_date, billable_hours, entry_source, needs_correction, meal_status, meal_periods (id, meal_start, meal_end)",
        )
        .gte("log_date", start)
        .lte("log_date", end)
        .is("voided_at", null)
        .order("log_date", { ascending: false })
        .order("clock_in", { ascending: false });
      if (scope) {
        const ids = profiles.map((p) => p.id);
        if (ids.length === 0) return { entries: [] as Entry[], profiles };
        entriesQ = entriesQ.in("user_id", ids);
      }
      const entriesRes = await entriesQ;
      if (entriesRes.error) throw entriesRes.error;
      return {
        entries: (entriesRes.data ?? []) as Entry[],
        profiles,
      };
    },
  });

  const profileById = useMemo(
    () => new Map((data?.profiles ?? []).map((p) => [p.id, p])),
    [data?.profiles],
  );

  // Worker sign-off per person for this week. Errors read as "not deployed
  // yet" (the attestation table ships with migration 20261002130000) — the
  // chips simply don't render until it lands.
  const attestQ = useQuery({
    queryKey: ["week-attestations", start],
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from("time_week_attestations")
        .select("user_id, status, note, hours_at_attestation")
        .eq("week_start", start)
        .is("superseded_at", null);
      if (error) return null;
      return new Map(rows.map((r) => [r.user_id, r]));
    },
  });

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
      invalidatePunchCaches(qc);
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
      invalidatePunchCaches(qc);
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
      // LA wall times on the shift's LA day — never the viewer's timezone.
      const day = laWallFromISO(clockIn).slice(0, 10);
      const startISO = laWallToUtcISO(`${day}T${outHM}`);
      const endISO = laWallToUtcISO(`${day}T${inHM}`);
      if (!startISO || !endISO) {
        toast.error("Invalid lunch time");
        return;
      }
      if (endISO <= startISO) {
        toast.error("Lunch end must be after lunch start");
        return;
      }
      if (
        new Date(startISO).getTime() < new Date(clockIn).getTime() ||
        (clockOut && new Date(endISO).getTime() > new Date(clockOut).getTime())
      ) {
        toast.error("Lunch must fall inside the shift", {
          description: "Off by design? Fix the clock-in/out times in the same save.",
        });
        return;
      }
      meal = { start: startISO, end: endISO };
    }

    if (!clockDirty && !meal) return;
    const name = profileById.get(e.user_id)?.display_name ?? "this player";
    setReasonReq({
      kind: "save",
      id: e.id,
      clock: clockDirty ? { clock_in: clockIn, clock_out: clockOut } : null,
      meal,
      prompt: `Save the corrected times on ${name}'s ${e.log_date} entry.`,
    });
  }

  function voidRow(e: Entry, name: string) {
    setReasonReq({
      kind: "void",
      id: e.id,
      prompt: `Void ${name}'s ${e.log_date} entry — it stops counting toward hours and pay.`,
    });
  }

  // One-tap version of the same reasoned save — ends the shift right now,
  // for the worker who left without punching out. Blocked mid-lunch: fix the
  // real lunch times on the row first, or the deduction comes out wrong.
  function clockOutNow(e: Entry) {
    const name = profileById.get(e.user_id)?.display_name ?? "this player";
    const { lunch } = lunchOf(e);
    if (lunch && !lunch.meal_end) {
      toast.error(`${name} is on lunch`, {
        description: "Set their real Lunch In time on this row first, then clock them out.",
      });
      return;
    }
    setReasonReq({
      kind: "clockout",
      id: e.id,
      clockIn: e.clock_in,
      prompt: `Clock ${name} out as of right now.`,
    });
  }

  function submitReason(reason: string) {
    if (!reasonReq) return;
    if (reasonReq.kind === "save") {
      saveMut.mutate({ id: reasonReq.id, clock: reasonReq.clock, meal: reasonReq.meal, reason });
    } else if (reasonReq.kind === "void") {
      voidMut.mutate({ id: reasonReq.id, reason });
    } else {
      saveMut.mutate({
        id: reasonReq.id,
        clock: { clock_in: reasonReq.clockIn, clock_out: new Date().toISOString() },
        meal: null,
        reason,
      });
    }
    setReasonReq(null);
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

  // One section per person: name, week rollup, compliance chips, and the
  // person-level tools (Add day, History). Day-ordered rows nest inside.
  const groups = useMemo(() => {
    const byUser = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byUser.get(r.e.user_id) ?? [];
      list.push(r);
      byUser.set(r.e.user_id, list);
    }
    return [...byUser.entries()]
      .map(([userId, list]) => {
        const dayTotals = new Map<string, number>();
        for (const r of list) {
          dayTotals.set(
            r.e.log_date,
            (dayTotals.get(r.e.log_date) ?? 0) + Number(r.e.billable_hours ?? 0),
          );
        }
        const weekTotal = totalsByUser.get(userId) ?? 0;
        return {
          userId,
          name: list[0].name,
          list,
          weekTotal,
          otDay: [...dayTotals.values()].some((h) => h > 8),
          over40: weekTotal > 40,
          reviewCount: list.filter((r) => r.e.needs_correction).length,
          mealCount: list.filter((r) => MEAL_ATTENTION[r.e.meal_status]).length,
          attestation: attestQ.data ? (attestQ.data.get(userId) ?? null) : undefined,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, totalsByUser, attestQ.data]);

  const groupHeaderChips = (g: (typeof groups)[number]) => (
    <span className="inline-flex flex-wrap items-center gap-1">
      {g.otDay && (
        <span className="text-[9px] font-display uppercase tracking-widest text-neon border border-neon/40 rounded px-1">
          OT
        </span>
      )}
      {g.over40 && (
        <span className="text-[9px] font-display uppercase tracking-widest text-neon border border-neon/40 rounded px-1">
          40h+
        </span>
      )}
      {g.reviewCount > 0 && (
        <span className="text-[9px] font-display uppercase tracking-widest text-destructive border border-destructive/40 rounded px-1">
          {g.reviewCount} to review
        </span>
      )}
      {g.mealCount > 0 && (
        <span className="text-[9px] font-display uppercase tracking-widest text-warning border border-warning/40 rounded px-1">
          {g.mealCount} meal
        </span>
      )}
      <AttestChip a={g.attestation} />
    </span>
  );

  const groupHeaderActions = (g: (typeof groups)[number]) => (
    <span className="inline-flex items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-[9px] font-display uppercase tracking-widest text-muted-foreground"
        onClick={() => {
          setAddEntryUserId(g.userId);
          setAddEntryOpen(true);
        }}
      >
        <CalendarPlus className="w-3 h-3 mr-1" />
        Add day
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-[9px] font-display uppercase tracking-widest text-muted-foreground"
        onClick={() =>
          setAuditFor({ ids: g.list.map((r) => r.e.id), title: `${g.name} · week history` })
        }
      >
        <History className="w-3 h-3 mr-1" />
        History
      </Button>
    </span>
  );

  return (
    <div className="space-y-4">
      {/* Flagged punches — approve here, or fix the row below. Captains see
          their own van's queue; admins see everyone. */}
      {!scope && <TimeClockReviewQueue />}

      <ArcadePanel
        title={scope ? "Crew Timesheets" : "Timesheets"}
        action={
          <div className="flex items-center gap-2">
            <Dialog
              open={addEntryOpen}
              onOpenChange={(o) => {
                setAddEntryOpen(o);
                if (!o) setAddEntryUserId(null);
              }}
            >
              <DialogTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="font-display text-[10px] tracking-widest uppercase"
                >
                  <CalendarPlus className="w-3.5 h-3.5 mr-1.5" />
                  Add Entry
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle className="font-display uppercase tracking-widest text-sm">
                    Backfill · Add Entry
                  </DialogTitle>
                  <DialogDescription>
                    Create a whole shift for anyone — a missed punch, a forgotten day, a new hire's
                    first shift.
                  </DialogDescription>
                </DialogHeader>
                <TimeClockBackfill
                  profiles={data?.profiles ?? []}
                  initialUserId={addEntryUserId ?? undefined}
                  onDone={() => setAddEntryOpen(false)}
                />
              </DialogContent>
            </Dialog>
            {!scope && (
              <Dialog open={passesOpen} onOpenChange={setPassesOpen}>
                <DialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="font-display text-[10px] tracking-widest uppercase"
                  >
                    <KeyRound className="w-3.5 h-3.5 mr-1.5" />
                    Passes
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-lg">
                  <DialogHeader>
                    <DialogTitle className="font-display uppercase tracking-widest text-sm">
                      Early / Late Passes
                    </DialogTitle>
                    <DialogDescription>
                      Pre-approve one day's early clock-in or late finish so it never flags.
                    </DialogDescription>
                  </DialogHeader>
                  <TimeClockExceptions profiles={data?.profiles ?? []} />
                </DialogContent>
              </Dialog>
            )}
          </div>
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => shiftWeek(-1)}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Popover open={weekPickerOpen} onOpenChange={setWeekPickerOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="font-display text-sm text-neon px-2 tabular-nums min-h-11 md:min-h-8 hover:underline"
                  title="Jump to a week"
                >
                  {weekLabel}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={weekStart}
                  onSelect={(d) => {
                    if (d) {
                      goToWeek(d);
                      setWeekPickerOpen(false);
                    }
                  }}
                  initialFocus
                  className="p-3 pointer-events-auto"
                />
              </PopoverContent>
            </Popover>
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
            Edit any field and hit Save — every change needs a reason and is audited. Flagged and
            auto-closed shifts need resolving before payroll can freeze the week.
          </span>
        </div>

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
              {groups.map((g) => (
                <div key={g.userId} className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-1.5 pt-2">
                    <div className="min-w-0">
                      <span className="font-display text-sm">{g.name}</span>
                      <span className="ml-2 font-display text-xs text-victory tabular-nums">
                        {g.weekTotal.toFixed(2)}h
                      </span>
                      <div className="mt-0.5">{groupHeaderChips(g)}</div>
                    </div>
                    {groupHeaderActions(g)}
                  </div>
                  {g.list.map(
                ({ e, name, edit, dirty, inVal, outVal, lunchOutVal, lunchInVal, onLunchNow }) => (
                  <MobileCard key={e.id}>
                    <MobileCardHeader
                      left={
                        <>
                          <span className="tabular-nums">{e.log_date}</span>
                          <EntryFlags e={e} />
                        </>
                      }
                      right={
                        <span className="text-neon tabular-nums">
                          {Number(e.billable_hours ?? 0).toFixed(2)}h
                        </span>
                      }
                    />
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
                          <button
                            type="button"
                            disabled={saveMut.isPending}
                            onClick={() => clockOutNow(e)}
                            className="inline-flex items-center gap-1 normal-case tracking-normal text-victory animate-pulse hover:animate-none hover:underline disabled:opacity-50"
                          >
                            <Square className="w-2.5 h-2.5" />
                            live — tap to clock out
                          </button>
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
                      onHistory={() =>
                        setAuditFor({ ids: [e.id], title: `${name} · ${e.log_date}` })
                      }
                    />
                  </MobileCard>
                ),
              )}
                </div>
              ))}
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
                  {groups.map((g) => (
                    <Fragment key={g.userId}>
                      <tr className="border-b border-border/60 bg-surface-elevated/30">
                        <td colSpan={9} className="py-1.5 pr-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-2">
                              <span className="font-display text-xs">{g.name}</span>
                              <span className="font-display text-[11px] text-victory tabular-nums">
                                {g.weekTotal.toFixed(2)}h
                              </span>
                              {groupHeaderChips(g)}
                            </span>
                            {groupHeaderActions(g)}
                          </div>
                        </td>
                      </tr>
                      {g.list.map(
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
                                <button
                                  type="button"
                                  disabled={saveMut.isPending}
                                  onClick={() => clockOutNow(e)}
                                  title="Clock them out right now"
                                  className="inline-flex items-center gap-0.5 whitespace-nowrap text-[9px] font-display uppercase text-victory animate-pulse hover:animate-none hover:underline disabled:opacity-50"
                                >
                                  <Square className="w-2.5 h-2.5" />
                                  live
                                </button>
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
                              onHistory={() =>
                                setAuditFor({ ids: [e.id], title: `${name} · ${e.log_date}` })
                              }
                            />
                          </td>
                        </tr>
                      );
                    },
                  )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </ArcadePanel>

      <ReasonDialog
        open={!!reasonReq}
        onOpenChange={(o) => !o && setReasonReq(null)}
        title={reasonReq?.kind === "void" ? "Void entry" : "Reason required"}
        prompt={reasonReq?.prompt ?? ""}
        confirmLabel={
          reasonReq?.kind === "void" ? "Void" : reasonReq?.kind === "clockout" ? "Clock Out" : "Save"
        }
        destructive={reasonReq?.kind === "void"}
        pending={saveMut.isPending || voidMut.isPending}
        onSubmit={submitReason}
      />

      <TimeEntryAuditSheet
        open={!!auditFor}
        onOpenChange={(o) => !o && setAuditFor(null)}
        entryIds={auditFor?.ids ?? []}
        title={auditFor?.title ?? "Change history"}
      />
    </div>
  );
}
