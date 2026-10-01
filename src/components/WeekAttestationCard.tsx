import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { addDaysISO, laWeekStartISO } from "@/lib/dates";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { BadgeCheck, CircleAlert } from "lucide-react";

const fmtDay = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  });

/**
 * The worker's weekly sign-off on LAST week's hours — the contemporaneous
 * confirmation that makes captain/manager-entered punches defensible, and
 * the flare that surfaces a problem BEFORE payroll instead of months later.
 * Ships dark: renders nothing until the attestation table exists, when the
 * week had no hours, or once the week is signed (a quiet chip instead).
 */
export function WeekAttestationCard({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const wkStart = addDaysISO(laWeekStartISO(), -7);
  const wkEnd = addDaysISO(wkStart, 6);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [note, setNote] = useState("");

  const attestation = useQuery({
    queryKey: ["week-attestation", userId, wkStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_week_attestations")
        .select("id, status, created_at")
        .eq("user_id", userId)
        .eq("week_start", wkStart)
        .is("superseded_at", null)
        .maybeSingle();
      // Table not deployed yet (or any read failure) → the card stays dark.
      if (error) return { unavailable: true as const, row: null };
      return { unavailable: false as const, row: data };
    },
  });

  const week = useQuery({
    enabled: attestation.data?.unavailable === false && !attestation.data.row,
    queryKey: ["week-attestation-hours", userId, wkStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_entries")
        .select("log_date, billable_hours, meal_status")
        .eq("user_id", userId)
        .gte("log_date", wkStart)
        .lte("log_date", wkEnd)
        .is("voided_at", null)
        .not("clock_out", "is", null)
        .order("log_date", { ascending: true });
      if (error) throw error;
      const byDay = new Map<string, number>();
      for (const r of data ?? []) {
        byDay.set(r.log_date, (byDay.get(r.log_date) ?? 0) + Number(r.billable_hours ?? 0));
      }
      return {
        days: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)),
        total: [...byDay.values()].reduce((s, h) => s + h, 0),
      };
    },
  });

  const attest = useMutation({
    mutationFn: async ({ confirm, note }: { confirm: boolean; note?: string }) => {
      const { error } = await supabase.rpc("attest_week", {
        _week_start: wkStart,
        _confirm: confirm,
        _note: note ?? null,
      });
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success(
        vars.confirm
          ? "Hours confirmed — thanks for signing off"
          : "Dispute recorded — the office will review it before payroll",
      );
      setDisputeOpen(false);
      setNote("");
      qc.invalidateQueries({ queryKey: ["week-attestation"] });
      qc.invalidateQueries({ queryKey: ["week-attestations"] });
    },
    onError: (e: Error) => toast.error("Couldn't record that", { description: e.message }),
  });

  if (!attestation.data || attestation.data.unavailable) return null;

  const row = attestation.data.row;
  if (row) {
    return (
      <div className="flex items-center gap-2 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        {row.status === "confirmed" ? (
          <>
            <BadgeCheck className="w-3.5 h-3.5 text-victory" />
            Week of {fmtDay(wkStart)} confirmed
          </>
        ) : (
          <>
            <CircleAlert className="w-3.5 h-3.5 text-warning" />
            Week of {fmtDay(wkStart)} disputed — the office is on it
          </>
        )}
      </div>
    );
  }

  if (!week.data || week.data.total === 0) return null;

  return (
    <ArcadePanel title="Confirm Last Week's Hours">
      <div className="space-y-3">
        <div className="text-xs text-muted-foreground">
          Week of {fmtDay(wkStart)} — check your hours before payroll runs. This is your official
          sign-off.
        </div>
        <div className="space-y-1">
          {week.data.days.map(([day, hours]) => (
            <div key={day} className="flex items-center justify-between text-xs tabular-nums">
              <span className="text-muted-foreground">{fmtDay(day)}</span>
              <span className="font-display text-neon">{hours.toFixed(2)}h</span>
            </div>
          ))}
          <div className="flex items-center justify-between text-xs tabular-nums border-t border-border pt-1 mt-1">
            <span className="font-display uppercase tracking-widest text-muted-foreground">
              Total
            </span>
            <span className="font-display text-victory">{week.data.total.toFixed(2)}h</span>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <button
            onClick={() => attest.mutate({ confirm: true })}
            disabled={attest.isPending}
            className="arcade-btn-3d flex-1 px-4 py-3 font-display text-xs uppercase tracking-widest"
            style={{ ["--btn-color" as string]: "var(--victory)", ["--btn-fg" as string]: "#06110a" }}
          >
            These hours are right
          </button>
          <button
            onClick={() => setDisputeOpen(true)}
            disabled={attest.isPending}
            className="min-h-11 flex-1 px-4 rounded border border-warning/50 text-warning font-display text-[10px] uppercase tracking-widest"
          >
            Something's wrong
          </button>
        </div>
      </div>

      <Dialog open={disputeOpen} onOpenChange={setDisputeOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display uppercase tracking-widest text-sm">
              What's wrong?
            </DialogTitle>
            <DialogDescription>
              Tell us what's off — missing day, wrong times, lunch recorded wrong. The office sees
              this before payroll runs.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder='e.g. "Tuesday shows 6 hours but I worked until 5 — about 8.5"'
            className="text-base md:text-sm min-h-20"
          />
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              className="min-h-11 md:min-h-9"
              onClick={() => setDisputeOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={!note.trim() || attest.isPending}
              onClick={() => attest.mutate({ confirm: false, note: note.trim() })}
              className="min-h-11 md:min-h-9 bg-warning text-background hover:bg-warning/90"
            >
              Submit dispute
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ArcadePanel>
  );
}
