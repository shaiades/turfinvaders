import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock, Play, Square, Utensils, AlertTriangle } from "lucide-react";
import { laDateISO, laTodayISO } from "@/lib/dates";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

import { ArcadePanel } from "@/components/arcade";

function fmtDuration(ms: number) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

const fmtClock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// Shift log_date is the LA calendar day of the instant (never viewer-local).
const isoDateLocal = (d: Date) => laDateISO(d);

/** A shift owes a meal once it passes 5 worked hours (CA Wage Order 4). */
const MEAL_REQUIRED_AFTER_HOURS = 5;
const MEAL_MIN_MINUTES = 30;

type MealRow = {
  id: string;
  time_entry_id: string;
  meal_start: string;
  meal_end: string | null;
};

export function TimeClock({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  // Clock-out intercepts into the meal attestation when the shift owes one.
  const [attesting, setAttesting] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const { data: openEntry } = useQuery({
    queryKey: ["time-clock-open", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_entries")
        .select("id, clock_in, clock_out, log_date, billable_hours, meal_status")
        .eq("user_id", userId)
        .is("clock_out", null)
        .order("clock_in", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // Meals on the open shift: drives the lunch button and the attestation skip.
  const { data: openMeals } = useQuery({
    enabled: !!openEntry?.id,
    queryKey: ["time-clock-meals", openEntry?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("meal_periods")
        .select("id, time_entry_id, meal_start, meal_end")
        .eq("time_entry_id", openEntry!.id)
        .order("meal_start", { ascending: true });
      if (error) throw error;
      return (data ?? []) as MealRow[];
    },
  });

  const today = isoDateLocal(new Date());
  const { data: todayEntries } = useQuery({
    queryKey: ["time-clock-today", userId, today],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_entries")
        .select("id, clock_in, clock_out, billable_hours, meal_status, entry_source, voided_at")
        .eq("user_id", userId)
        .eq("log_date", today)
        .is("voided_at", null)
        .order("clock_in", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  // Recent auto-closes awaiting a human: the worker should see (and dispute)
  // a fabricated end time, not discover it on payday.
  const { data: flaggedEntries } = useQuery({
    queryKey: ["time-clock-flagged", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_entries")
        .select("id, clock_in, clock_out, log_date, entry_source, needs_correction")
        .eq("user_id", userId)
        .eq("needs_correction", true)
        .is("voided_at", null)
        .order("clock_in", { ascending: false })
        .limit(3);
      if (error) throw error;
      return data ?? [];
    },
  });

  const openMeal = (openMeals ?? []).find((m) => !m.meal_end) ?? null;
  const recordedMealMinutes = (openMeals ?? [])
    .filter((m) => m.meal_end)
    .reduce((s, m) => s + (new Date(m.meal_end!).getTime() - new Date(m.meal_start).getTime()) / 60000, 0);
  const hasCompliantMeal = (openMeals ?? []).some(
    (m) => m.meal_end &&
      (new Date(m.meal_end).getTime() - new Date(m.meal_start).getTime()) / 60000 >= MEAL_MIN_MINUTES,
  );

  const clockIn = useMutation({
    mutationFn: async () => {
      const nowDate = new Date();
      const { error } = await supabase.from("time_entries").insert({
        user_id: userId,
        clock_in: nowDate.toISOString(),
        log_date: isoDateLocal(nowDate),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      // Mirror of the server-side anomaly flags (compute trigger): tell the
      // worker up front when a punch will sit in the review queue.
      const laHour = Number(
        new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          hour12: false,
          timeZone: "America/Los_Angeles",
        }).format(new Date()),
      );
      const sundayNow = new Date(`${laTodayISO()}T12:00:00Z`).getUTCDay() === 0;
      if (laHour < 7) {
        toast.info("Clocked in early", {
          description: "Before 7:00 AM — your captain or manager will review and approve.",
        });
      } else if (sundayNow) {
        toast.info("Clocked in on a Sunday", {
          description: "Sundays aren't scheduled — this shift is flagged for review (and paid).",
        });
      } else {
        toast.success("Clocked in");
      }
      qc.invalidateQueries({ queryKey: ["time-clock-open", userId] });
      qc.invalidateQueries({ queryKey: ["time-clock-today", userId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const lunchStart = useMutation({
    mutationFn: async () => {
      if (!openEntry) throw new Error("Clock in before starting lunch");
      const { error } = await supabase.from("meal_periods").insert({
        time_entry_id: openEntry.id,
        user_id: userId,
        meal_start: new Date().toISOString(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Lunch started — enjoy");
      qc.invalidateQueries({ queryKey: ["time-clock-meals", openEntry?.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const lunchEnd = useMutation({
    mutationFn: async () => {
      if (!openMeal) throw new Error("No lunch in progress");
      const { error } = await supabase
        .from("meal_periods")
        .update({ meal_end: new Date().toISOString() })
        .eq("id", openMeal.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Back on the clock");
      qc.invalidateQueries({ queryKey: ["time-clock-meals", openEntry?.id] });
      qc.invalidateQueries({ queryKey: ["time-clock-open", userId] });
      qc.invalidateQueries({ queryKey: ["time-clock-today", userId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const clockOut = useMutation({
    mutationFn: async (attestation: "missed" | "unrecorded" | null) => {
      if (!openEntry) throw new Error("No open shift to clock out of");
      if (openMeal) throw new Error("End your lunch before clocking out");
      const patch: { clock_out: string; meal_status?: "missed" | "unrecorded" } = {
        clock_out: new Date().toISOString(),
      };
      if (attestation) patch.meal_status = attestation;
      const { error } = await supabase.from("time_entries").update(patch).eq("id", openEntry.id);
      if (error) throw error;
      return attestation;
    },
    onSuccess: (attestation) => {
      if (attestation === "missed") {
        toast.warning("Clocked out — missed meal recorded", {
          description: "A meal premium hour is added to this week's pay.",
        });
      } else if (attestation === "unrecorded") {
        toast.success("Clocked out", {
          description: "Your manager will enter the lunch times you took.",
        });
      } else {
        toast.success("Clocked out");
      }
      setAttesting(false);
      qc.invalidateQueries({ queryKey: ["time-clock-open", userId] });
      qc.invalidateQueries({ queryKey: ["time-clock-today", userId] });
      // Pay-engine reads: the RPC-backed month figure and the weekly paycheck.
      qc.invalidateQueries({ queryKey: ["takehome_volume_bonus"] });
      qc.invalidateQueries({ queryKey: ["earnings"] });
      // Weekly pay projection is driven by clocked hours now — refresh it.
      qc.invalidateQueries({ queryKey: ["my_clocked_hours"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const isClockedIn = !!openEntry;
  const liveMs = useMemo(() => {
    if (!openEntry) return 0;
    return now - new Date(openEntry.clock_in).getTime();
  }, [openEntry, now]);
  const shiftHours = liveMs / 3_600_000;
  const lunchMs = openMeal ? now - new Date(openMeal.meal_start).getTime() : 0;

  const todayHours = useMemo(
    () => (todayEntries ?? []).reduce((s, r) => s + Number(r.billable_hours ?? 0), 0),
    [todayEntries],
  );

  const isSunday = new Date(`${laTodayISO()}T12:00:00Z`).getUTCDay() === 0;

  // Clock Out: shifts past the meal threshold with no recorded 30-min meal
  // must attest before closing — that attestation is what replaced the old
  // blanket lunch deduction.
  const needsAttestation = shiftHours > MEAL_REQUIRED_AFTER_HOURS && !hasCompliantMeal;
  const handleClockOutTap = () => {
    if (needsAttestation) setAttesting(true);
    else clockOut.mutate(null);
  };

  return (
    <ArcadePanel title="Time Clock">
      {(flaggedEntries?.length ?? 0) > 0 && (
        <div className="mb-4 rounded-lg border border-warning/50 bg-warning/10 p-3 space-y-1">
          <div className="flex items-center gap-2 text-warning text-[10px] font-display uppercase tracking-widest">
            <AlertTriangle className="w-3.5 h-3.5" /> Auto-closed shifts — check the times
          </div>
          {flaggedEntries!.map((e) => (
            <div key={e.id} className="text-xs text-muted-foreground">
              {e.log_date}: closed at{" "}
              <span className="text-foreground">{e.clock_out ? fmtClock(e.clock_out) : "—"}</span>{" "}
              automatically. Wrong? Tell your manager — they can fix it.
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col items-center gap-5">
        <div className="flex items-center gap-3">
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center border ${
              openMeal
                ? "bg-warning/10 border-warning text-warning animate-pulse"
                : isClockedIn
                  ? "bg-victory/10 border-victory text-victory animate-pulse"
                  : "bg-surface-elevated border-border text-muted-foreground"
            }`}
          >
            {openMeal ? <Utensils className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
          </div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            {openMeal ? "On lunch" : isClockedIn ? "On the clock" : "Off the clock"}
          </div>
        </div>

        <div className="timer-display text-5xl sm:text-6xl text-center">
          {isClockedIn ? fmtDuration(liveMs) : "00:00:00"}
        </div>

        <div className="text-xs text-muted-foreground text-center">
          Today billable: <span className="text-victory">{todayHours.toFixed(2)}h</span>
          <span className="mx-2">·</span>
          {isSunday ? (
            <span className="text-warning">
              Sundays aren't scheduled — worked time is paid and flagged for review
            </span>
          ) : openMeal ? (
            <span className="text-warning">Lunch running · {fmtDuration(lunchMs)}</span>
          ) : (
            <>Punch your lunch when you take it — only punched lunches are deducted</>
          )}
        </div>

        {attesting ? (
          <div className="w-full max-w-md rounded-lg border border-warning/50 bg-warning/10 p-4 space-y-3">
            <div className="text-sm text-foreground text-center">
              This shift ran past {MEAL_REQUIRED_AFTER_HOURS} hours and no 30-minute lunch was
              punched. What happened?
            </div>
            <button
              onClick={() => clockOut.mutate("missed")}
              disabled={clockOut.isPending}
              className="arcade-btn-3d w-full px-4 py-3 font-display text-xs uppercase tracking-widest"
              style={{ ["--btn-color" as string]: "var(--warning)", ["--btn-fg" as string]: "#1a1205" }}
            >
              I worked through lunch
            </button>
            <button
              onClick={() => clockOut.mutate("unrecorded")}
              disabled={clockOut.isPending}
              className="arcade-btn-3d w-full px-4 py-3 font-display text-xs uppercase tracking-widest"
              style={{ ["--btn-color" as string]: "var(--surface-elevated)", ["--btn-fg" as string]: "var(--foreground)" }}
            >
              I took lunch but didn't punch it
            </button>
            <button
              onClick={() => setAttesting(false)}
              className="w-full text-[10px] uppercase tracking-widest text-muted-foreground py-1"
            >
              Cancel — stay clocked in
            </button>
          </div>
        ) : isClockedIn ? (
          <div className="flex flex-col sm:flex-row items-stretch gap-3 w-full sm:w-auto">
            {openMeal ? (
              <button
                onClick={() => lunchEnd.mutate()}
                disabled={lunchEnd.isPending}
                className="arcade-btn-3d px-8 py-4 font-display text-sm uppercase tracking-widest flex items-center justify-center gap-2"
                style={{ ["--btn-color" as string]: "var(--warning)", ["--btn-fg" as string]: "#1a1205" }}
              >
                <Utensils className="w-4 h-4" />
                End Lunch
              </button>
            ) : (
              <>
                <button
                  onClick={() => lunchStart.mutate()}
                  disabled={lunchStart.isPending}
                  className="arcade-btn-3d px-8 py-4 font-display text-sm uppercase tracking-widest flex items-center justify-center gap-2"
                  style={{ ["--btn-color" as string]: "var(--warning)", ["--btn-fg" as string]: "#1a1205" }}
                >
                  <Utensils className="w-4 h-4" />
                  Start Lunch
                </button>
                <button
                  onClick={handleClockOutTap}
                  disabled={clockOut.isPending}
                  className="arcade-btn-3d px-8 py-4 font-display text-sm uppercase tracking-widest flex items-center justify-center gap-2"
                  style={{ ["--btn-color" as string]: "var(--destructive)", ["--btn-fg" as string]: "#fff" }}
                >
                  <Square className="w-4 h-4" />
                  Clock Out
                </button>
              </>
            )}
          </div>
        ) : (
          <button
            onClick={() => clockIn.mutate()}
            disabled={clockIn.isPending}
            className="arcade-btn-3d w-full sm:w-auto px-8 py-4 font-display text-sm uppercase tracking-widest flex items-center justify-center gap-2"
            style={{ ["--btn-color" as string]: "var(--victory)", ["--btn-fg" as string]: "#06110a" }}
          >
            <Play className="w-4 h-4" />
            Clock In
          </button>
        )}

        {isClockedIn && !openMeal && recordedMealMinutes > 0 && (
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Lunch punched today: {Math.round(recordedMealMinutes)} min
          </div>
        )}
      </div>

      {(todayEntries?.length ?? 0) > 0 && (
        <div className="mt-5 border-t border-border pt-4 space-y-1.5">
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
            Today's shifts
          </div>
          {todayEntries!.map((e) => (
            <div key={e.id} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground tabular-nums">
                {fmtClock(e.clock_in)}
                {" → "}
                {e.clock_out ? fmtClock(e.clock_out) : <span className="text-victory">live</span>}
                {e.entry_source === "auto_closed" && (
                  <span className="ml-1.5 text-[9px] uppercase text-warning">auto</span>
                )}
                {e.meal_status === "missed" && (
                  <span className="ml-1.5 text-[9px] uppercase text-warning">no lunch</span>
                )}
              </span>
              <span className="font-display text-neon tabular-nums">
                {Number(e.billable_hours ?? 0).toFixed(2)}h
              </span>
            </div>
          ))}
        </div>
      )}
    </ArcadePanel>
  );
}
