import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock, Play, Square } from "lucide-react";
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

// Shift log_date is the LA calendar day of the instant (never viewer-local).
const isoDateLocal = (d: Date) => laDateISO(d);

export function TimeClock({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const { data: openEntry } = useQuery({
    queryKey: ["time-clock-open", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_entries")
        .select("id, clock_in, clock_out, log_date, billable_hours")
        .eq("user_id", userId)
        .is("clock_out", null)
        .order("clock_in", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const today = isoDateLocal(new Date());
  const { data: todayEntries } = useQuery({
    queryKey: ["time-clock-today", userId, today],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_entries")
        .select("id, clock_in, clock_out, billable_hours")
        .eq("user_id", userId)
        .eq("log_date", today)
        .order("clock_in", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

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
      toast.success("Clocked in");
      qc.invalidateQueries({ queryKey: ["time-clock-open", userId] });
      qc.invalidateQueries({ queryKey: ["time-clock-today", userId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const clockOut = useMutation({
    mutationFn: async () => {
      if (!openEntry) throw new Error("No open shift to clock out of");
      const { error } = await supabase
        .from("time_entries")
        .update({ clock_out: new Date().toISOString() })
        .eq("id", openEntry.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Clocked out · 30-min lunch deducted");
      qc.invalidateQueries({ queryKey: ["time-clock-open", userId] });
      qc.invalidateQueries({ queryKey: ["time-clock-today", userId] });
      qc.invalidateQueries({ queryKey: ["take-home"] });
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

  const todayHours = useMemo(
    () => (todayEntries ?? []).reduce((s, r) => s + Number(r.billable_hours ?? 0), 0),
    [todayEntries],
  );

  return (
    <ArcadePanel title="Time Clock">
      <div className="flex flex-col items-center gap-5">
        <div className="flex items-center gap-3">
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center border ${
              isClockedIn
                ? "bg-victory/10 border-victory text-victory animate-pulse"
                : "bg-surface-elevated border-border text-muted-foreground"
            }`}
          >
            <Clock className="w-4 h-4" />
          </div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            {isClockedIn ? "On the clock" : "Off the clock"}
          </div>
        </div>

        <div className="timer-display text-5xl sm:text-6xl text-center">
          {isClockedIn ? fmtDuration(liveMs) : "00:00:00"}
        </div>

        <div className="text-xs text-muted-foreground text-center">
          Today billable: <span className="text-victory">{todayHours.toFixed(2)}h</span>
          <span className="mx-2">·</span>
          {new Date(`${laTodayISO()}T12:00:00Z`).getUTCDay() === 0 ? (
            <span className="text-warning">Sundays are unpaid — today's time bills 0h</span>
          ) : (
            <>30-min lunch auto-deducted per shift</>
          )}
        </div>

        {isClockedIn ? (
          <button
            onClick={() => clockOut.mutate()}
            disabled={clockOut.isPending}
            className="arcade-btn-3d w-full sm:w-auto px-8 py-4 font-display text-sm uppercase tracking-widest flex items-center justify-center gap-2"
            style={{ ["--btn-color" as string]: "var(--destructive)", ["--btn-fg" as string]: "#fff" }}
          >
            <Square className="w-4 h-4" />
            Clock Out
          </button>
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
      </div>

      {(todayEntries?.length ?? 0) > 0 && (
        <div className="mt-5 border-t border-border pt-4 space-y-1.5">
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
            Today's shifts
          </div>
          {todayEntries!.map((e) => (
            <div key={e.id} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground tabular-nums">
                {new Date(e.clock_in).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                {" → "}
                {e.clock_out
                  ? new Date(e.clock_out).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                  : <span className="text-victory">live</span>}
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
