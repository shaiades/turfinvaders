import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
import { fmtWallTime, laTodayISO } from "@/lib/dates";
import { KeyRound, X } from "lucide-react";

type Profile = { id: string; display_name: string };

type Pass = {
  id: string;
  user_id: string;
  exception_date: string;
  early_from: string | null;
  late_until: string | null;
  reason: string;
  granted_by: string;
};

const FIELD_LABEL = "text-[10px] font-display uppercase tracking-widest text-muted-foreground";

/** Early/Late passes: pre-approve a specific person for a specific day to
 *  clock in before 7 AM (no review-queue flag) and/or work past the auto-
 *  close cutoff (6 PM weekdays / 5 PM Saturday — the pass extends it).
 *  Times are Pacific wall clock. One active pass per person per day;
 *  granting again replaces it, revoking keeps the row as history. */
export function TimeClockExceptions({ profiles }: { profiles: Profile[] }) {
  const qc = useQueryClient();
  const today = laTodayISO();
  const [userId, setUserId] = useState("");
  const [date, setDate] = useState(today);
  const [earlyFrom, setEarlyFrom] = useState("");
  const [lateUntil, setLateUntil] = useState("");
  const [reason, setReason] = useState("");

  const sorted = useMemo(
    () => [...profiles].sort((a, b) => (a.display_name ?? "").localeCompare(b.display_name ?? "")),
    [profiles],
  );
  const nameById = useMemo(
    () => new Map(profiles.map((p) => [p.id, p.display_name ?? "Unknown"])),
    [profiles],
  );

  // Today + upcoming active passes. Errors render as a muted note instead of
  // breaking the tab (the table ships in migration 20260911120000 — until
  // the owner applies it, this read is the only thing that fails).
  const passesQuery = useQuery({
    queryKey: ["time-clock-passes", today],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_clock_exceptions")
        .select("id, user_id, exception_date, early_from, late_until, reason, granted_by")
        .is("revoked_at", null)
        .gte("exception_date", today)
        .order("exception_date", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Pass[];
    },
  });

  const grantMut = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("Pick who the pass is for");
      if (!date) throw new Error("Pick the day the pass covers");
      if (!earlyFrom && !lateUntil) {
        throw new Error("Set an early start, a late finish, or both");
      }
      const trimmed = reason.trim();
      if (!trimmed) throw new Error("A reason is required");
      const { error } = await supabase.rpc("grant_time_clock_exception", {
        _user_id: userId,
        _date: date,
        _early_from: earlyFrom || null,
        _late_until: lateUntil || null,
        _reason: trimmed,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Pass granted");
      setEarlyFrom("");
      setLateUntil("");
      setReason("");
      qc.invalidateQueries({ queryKey: ["time-clock-passes"] });
    },
    onError: (e: Error) => toast.error("Couldn't grant the pass", { description: e.message }),
  });

  const revokeMut = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("revoke_time_clock_exception", { _id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Pass revoked");
      qc.invalidateQueries({ queryKey: ["time-clock-passes"] });
    },
    onError: (e: Error) => toast.error("Couldn't revoke", { description: e.message }),
  });

  const passes = passesQuery.data ?? [];

  return (
    <ArcadePanel title="Early / Late Passes" action={<KeyRound className="w-4 h-4 text-warning" />}>
      <div className="space-y-3">
        <div className="text-[11px] text-muted-foreground">
          Pre-approve someone to clock in before 7 AM (no review flag) or work past the auto-close
          cutoff (6 PM weekdays · 5 PM Saturday). Times are Pacific. Granting again for the same day
          replaces the pass.
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block space-y-1">
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
            <span className={FIELD_LABEL}>Day</span>
            <Input type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className={FIELD_LABEL}>Clock-in OK from · PT, optional</span>
            <Input type="time" value={earlyFrom} onChange={(e) => setEarlyFrom(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className={FIELD_LABEL}>Work until · PT, optional</span>
            <Input type="time" value={lateUntil} onChange={(e) => setLateUntil(e.target.value)} />
          </label>
          <label className="block space-y-1 sm:col-span-2">
            <span className={FIELD_LABEL}>Reason · required</span>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder='e.g. "early neighborhood blitz — owner approved"'
            />
          </label>
        </div>
        <Button
          onClick={() => grantMut.mutate()}
          disabled={grantMut.isPending}
          className="w-full sm:w-auto bg-warning text-background hover:bg-warning/90 font-display text-[10px] uppercase tracking-widest"
        >
          <KeyRound className="w-3.5 h-3.5 mr-1" />
          Grant Pass
        </Button>

        {passesQuery.isError ? (
          <div className="text-[11px] text-muted-foreground">
            Passes unavailable — {(passesQuery.error as Error).message}
          </div>
        ) : passes.length > 0 ? (
          <div className="space-y-2 pt-1">
            {passes.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-surface-elevated p-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {nameById.get(p.user_id) ?? "Unknown"}
                    <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                      {p.exception_date}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {p.early_from && (
                      <span className="text-[9px] font-display uppercase tracking-widest text-victory border border-victory/40 rounded px-1">
                        in from {fmtWallTime(p.early_from)}
                      </span>
                    )}
                    {p.late_until && (
                      <span className="text-[9px] font-display uppercase tracking-widest text-warning border border-warning/40 rounded px-1">
                        out until {fmtWallTime(p.late_until)}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground truncate">
                      {p.reason}
                      {nameById.has(p.granted_by) && ` — ${nameById.get(p.granted_by)}`}
                    </span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={revokeMut.isPending}
                  onClick={() => revokeMut.mutate(p.id)}
                >
                  <X className="w-3.5 h-3.5 text-destructive" />
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        ) : passesQuery.isSuccess ? (
          <div className="text-[11px] text-muted-foreground">No active passes.</div>
        ) : null}
      </div>
    </ArcadePanel>
  );
}
