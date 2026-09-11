import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { CalendarPlus } from "lucide-react";

type Profile = { id: string; display_name: string };

function isoFromLocal(s: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

const FIELD_LABEL = "text-[10px] font-display uppercase tracking-widest text-muted-foreground";

/** Owner/Manager backfill: create a whole time entry for anyone — the missed
 *  punch-in, the forgotten day, the new hire whose first shift predates their
 *  login. Reason required; the entry lands as manager_created on the audit
 *  trail. Clock Out may stay empty to open a LIVE shift (the worker punches
 *  out normally); an optional lunch prices the meal deduction in the same
 *  save. */
export function TimeClockBackfill({ profiles }: { profiles: Profile[] }) {
  const qc = useQueryClient();
  const [userId, setUserId] = useState("");
  const [clockIn, setClockIn] = useState("");
  const [clockOut, setClockOut] = useState("");
  const [lunchStart, setLunchStart] = useState("");
  const [lunchEnd, setLunchEnd] = useState("");
  const [reason, setReason] = useState("");

  const sorted = useMemo(
    () => [...profiles].sort((a, b) => (a.display_name ?? "").localeCompare(b.display_name ?? "")),
    [profiles],
  );

  const createMut = useMutation({
    mutationFn: async () => {
      const inISO = isoFromLocal(clockIn);
      if (!userId) throw new Error("Pick who this entry is for");
      if (!inISO) throw new Error("Clock In is required");
      const outISO = clockOut ? isoFromLocal(clockOut) : null;
      if (clockOut && !outISO) throw new Error("Invalid Clock Out time");
      if (outISO && outISO <= inISO) throw new Error("Clock Out must be after Clock In");
      const lunchInISO = lunchStart ? isoFromLocal(lunchStart) : null;
      const lunchOutISO = lunchEnd ? isoFromLocal(lunchEnd) : null;
      if (!!lunchInISO !== !!lunchOutISO) {
        throw new Error("Lunch needs both a start and an end (or leave both empty)");
      }
      if (lunchInISO && lunchOutISO && lunchOutISO <= lunchInISO) {
        throw new Error("Lunch end must be after lunch start");
      }
      const trimmed = reason.trim();
      if (!trimmed) throw new Error("A reason is required — it goes on the audit trail");

      const { data: newId, error } = await supabase.rpc("admin_create_time_entry", {
        _user_id: userId,
        _clock_in: inISO,
        _clock_out: outISO,
        _reason: trimmed,
      });
      if (error) throw error;
      if (lunchInISO && lunchOutISO && newId) {
        const { error: mealErr } = await supabase.rpc("admin_set_meal", {
          _time_entry_id: newId,
          _meal_start: lunchInISO,
          _meal_end: lunchOutISO,
          _reason: trimmed,
        });
        if (mealErr) {
          throw new Error(`Entry created, but the lunch failed: ${mealErr.message}`);
        }
      }
      return { open: !outISO };
    },
    onSuccess: ({ open }) => {
      toast.success(
        open ? "Entry created — shift is live until they punch out" : "Entry backfilled",
      );
      setClockIn("");
      setClockOut("");
      setLunchStart("");
      setLunchEnd("");
      setReason("");
      qc.invalidateQueries({ queryKey: ["timesheets"] });
      qc.invalidateQueries({ queryKey: ["payroll-ledger"] });
      qc.invalidateQueries({ queryKey: ["time-review-queue"] });
      qc.invalidateQueries({ queryKey: ["time-clock-open"] });
      qc.invalidateQueries({ queryKey: ["time-clock-today"] });
    },
    onError: (e: Error) => toast.error("Backfill failed", { description: e.message }),
  });

  return (
    <ArcadePanel
      title="Backfill · Add Entry"
      action={<CalendarPlus className="w-4 h-4 text-neon" />}
    >
      <div className="space-y-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block space-y-1 sm:col-span-2">
            <span className={FIELD_LABEL}>Player</span>
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a player…" />
              </SelectTrigger>
              <SelectContent>
                {sorted.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.display_name ?? "Unknown"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="block space-y-1">
            <span className={FIELD_LABEL}>Clock In</span>
            <Input
              type="datetime-local"
              value={clockIn}
              onChange={(e) => setClockIn(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className={FIELD_LABEL}>Clock Out · empty = leave shift live</span>
            <Input
              type="datetime-local"
              value={clockOut}
              onChange={(e) => setClockOut(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className={FIELD_LABEL}>Lunch Start · optional</span>
            <Input
              type="datetime-local"
              value={lunchStart}
              onChange={(e) => setLunchStart(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className={FIELD_LABEL}>Lunch End · optional</span>
            <Input
              type="datetime-local"
              value={lunchEnd}
              onChange={(e) => setLunchEnd(e.target.value)}
            />
          </label>
          <label className="block space-y-1 sm:col-span-2">
            <span className={FIELD_LABEL}>Reason · required, lands on the audit trail</span>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder='e.g. "forgot to punch in — captain confirmed 8 AM start"'
            />
          </label>
        </div>
        <Button
          onClick={() => createMut.mutate()}
          disabled={createMut.isPending}
          className="w-full sm:w-auto bg-victory text-background hover:bg-victory/90 font-display text-[10px] uppercase tracking-widest"
        >
          <CalendarPlus className="w-3.5 h-3.5 mr-1" />
          Add Entry
        </Button>
      </div>
    </ArcadePanel>
  );
}
