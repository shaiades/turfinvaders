import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Radio, Square, Utensils } from "lucide-react";

type LiveEntry = {
  id: string;
  user_id: string;
  clock_in: string;
  log_date: string;
};
type Profile = { id: string; display_name: string };

const fmtClock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function fmtRunning(ms: number) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** Everyone punched in right now, with a one-tap manager clock-out — for the
 *  worker who left early without punching, or the shift a manager is ending.
 *  Closing goes through admin_update_time_entry (reason required, audited,
 *  arrives resolved), exactly like typing the time into the row below — this
 *  is just the fast path. A shift on lunch can't be one-tapped: set the real
 *  lunch times first (Lunch on the entry row) so the deduction is right. */
export function TimeClockLiveShifts({ profiles }: { profiles: Profile[] }) {
  const qc = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const nameById = useMemo(
    () => new Map(profiles.map((p) => [p.id, p.display_name ?? "Unknown"])),
    [profiles],
  );

  const liveQuery = useQuery({
    queryKey: ["live-shifts"],
    queryFn: async () => {
      const { data: entries, error } = await supabase
        .from("time_entries")
        .select("id, user_id, clock_in, log_date")
        .is("clock_out", null)
        .is("voided_at", null)
        .order("clock_in", { ascending: true });
      if (error) throw error;
      const rows = (entries ?? []) as LiveEntry[];
      let onLunch = new Set<string>();
      if (rows.length > 0) {
        const { data: meals, error: mErr } = await supabase
          .from("meal_periods")
          .select("time_entry_id")
          .is("meal_end", null)
          .in(
            "time_entry_id",
            rows.map((r) => r.id),
          );
        if (mErr) throw mErr;
        onLunch = new Set((meals ?? []).map((m) => m.time_entry_id));
      }
      return { rows, onLunch };
    },
  });

  useRealtimeInvalidate({
    channel: "live-shifts",
    tables: ["time_entries"],
    invalidateKeys: [["live-shifts"]],
    enabled: true,
  });

  const clockOutMut = useMutation({
    mutationFn: async ({ e, reason }: { e: LiveEntry; reason: string }) => {
      const { error } = await supabase.rpc("admin_update_time_entry", {
        _id: e.id,
        _clock_in: e.clock_in,
        _clock_out: new Date().toISOString(),
        _reason: reason,
      });
      if (error) throw error;
    },
    onSuccess: (_d, { e }) => {
      toast.success(`${nameById.get(e.user_id) ?? "Player"} clocked out`);
      qc.invalidateQueries({ queryKey: ["live-shifts"] });
      qc.invalidateQueries({ queryKey: ["timesheets"] });
      qc.invalidateQueries({ queryKey: ["payroll-ledger"] });
      qc.invalidateQueries({ queryKey: ["time-review-queue"] });
      qc.invalidateQueries({ queryKey: ["time-clock-open"] });
      qc.invalidateQueries({ queryKey: ["time-clock-today"] });
    },
    onError: (e: Error) => toast.error("Clock-out failed", { description: e.message }),
  });

  function clockOutNow(e: LiveEntry, lunchRunning: boolean) {
    const name = nameById.get(e.user_id) ?? "this player";
    if (lunchRunning) {
      toast.error(`${name} is on lunch`, {
        description:
          "Set their real lunch times first (Lunch on the entry row below), then clock them out — otherwise the deduction is wrong.",
      });
      return;
    }
    const reason = window.prompt(
      `Clock ${name} out as of right now? Enter the reason (required — it goes on the audit trail):`,
    );
    if (!reason || !reason.trim()) return;
    clockOutMut.mutate({ e, reason: reason.trim() });
  }

  const rows = liveQuery.data?.rows ?? [];
  const onLunch = liveQuery.data?.onLunch ?? new Set<string>();

  return (
    <ArcadePanel
      title={`On the Clock · ${rows.length}`}
      action={
        <Radio
          className={`w-4 h-4 ${rows.length > 0 ? "text-victory animate-pulse" : "text-muted-foreground"}`}
        />
      }
    >
      {liveQuery.isLoading ? (
        <div className="text-sm text-muted-foreground">Checking who's punched in…</div>
      ) : rows.length === 0 ? (
        <div className="text-[11px] text-muted-foreground">No one is on the clock right now.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((e) => {
            const lunchRunning = onLunch.has(e.id);
            return (
              <div
                key={e.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-victory/40 bg-victory/5 p-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {nameById.get(e.user_id) ?? "Unknown"}
                    <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                      {e.log_date} · in {fmtClock(e.clock_in)} · running{" "}
                      {fmtRunning(now - new Date(e.clock_in).getTime())}h
                    </span>
                    {lunchRunning && (
                      <span className="ml-2 inline-flex items-center gap-1 text-[9px] font-display uppercase tracking-widest text-warning border border-warning/40 rounded px-1 align-middle">
                        <Utensils className="w-2.5 h-2.5" />
                        on lunch
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={clockOutMut.isPending}
                  onClick={() => clockOutNow(e, lunchRunning)}
                  className="font-display text-[10px] uppercase tracking-widest"
                >
                  <Square className="w-3.5 h-3.5 mr-1 text-destructive" />
                  Clock Out Now
                </Button>
              </div>
            );
          })}
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest">
            Ends the shift at this moment with your reason on the audit trail. Left earlier than
            now? Type the real time into their entry row below instead.
          </div>
        </div>
      )}
    </ArcadePanel>
  );
}
