import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { BellRing, Check, Crosshair } from "lucide-react";

/** Why an entry is in the queue → the chip a reviewer reads. Flags accumulate
 *  as history; the live meal_status decides whether a meal chip still shows. */
const FLAG_LABEL: Record<string, string> = {
  early_clock_in: "early clock-in (before 7 AM)",
  sunday_shift: "Sunday shift",
  very_long_shift: "over 12h",
  missed_meal: "worked through lunch · premium",
  unrecorded_lunch: "lunch times needed",
  missed_second_meal: "missed 2nd meal (>10h) · premium",
  missed_rest_break: "missed rest break · premium",
  captain_edit: "captain edit",
};

type QueueRow = {
  id: string;
  user_id: string;
  log_date: string;
  clock_in: string;
  clock_out: string | null;
  billable_hours: number;
  entry_source: string;
  needs_correction: boolean;
  meal_status: string;
  flag_reasons: string[];
};

// Punch times read in PACIFIC everywhere admins review them — the device's
// timezone silently shifted punches for anyone off-LA.
const fmtClock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });

/** Flagged-entry review queue ("the notification"): every entry whose punches
 *  look wrong sits here until a captain/manager approves it or fixes it in
 *  the timesheet editor — plus pending-lunch shifts (crew/manager closes the
 *  worker hasn't answered yet), because those silently block the payroll
 *  freeze. Realtime; captains see (and approve for) their own van only —
 *  the approve RPC enforces the same rule server-side. `onLocate` jumps the
 *  editor to the entry's week + person. */
export function TimeClockReviewQueue({
  teamId,
  onLocate,
}: {
  teamId?: string | null;
  onLocate?: (row: { log_date: string; name: string }) => void;
}) {
  const qc = useQueryClient();

  const queueQuery = useQuery({
    queryKey: ["time-review-queue", teamId ?? "all"],
    queryFn: async () => {
      let memberIds: string[] | null = null;
      if (teamId) {
        const { data: members, error: mErr } = await supabase
          .from("profiles")
          .select("id")
          .eq("team_id", teamId);
        if (mErr) throw mErr;
        memberIds = (members ?? []).map((m) => m.id);
        if (memberIds.length === 0) return { rows: [] as QueueRow[], names: new Map<string, string>() };
      }
      let q = supabase
        .from("time_entries")
        .select(
          "id, user_id, log_date, clock_in, clock_out, billable_hours, entry_source, needs_correction, meal_status, flag_reasons",
        )
        .or("needs_correction.eq.true,and(meal_status.eq.pending,clock_out.not.is.null)")
        .is("voided_at", null)
        .order("clock_in", { ascending: false })
        .limit(100);
      if (memberIds) q = q.in("user_id", memberIds);
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as QueueRow[];
      const ids = [...new Set(rows.map((r) => r.user_id))];
      const names = new Map<string, string>();
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, display_name")
          .in("id", ids);
        for (const p of profs ?? []) names.set(p.id, p.display_name ?? "Unknown");
      }
      return { rows, names };
    },
  });

  useRealtimeInvalidate({
    channel: `time-review-${teamId ?? "all"}`,
    tables: ["time_entries"],
    invalidateKeys: [["time-review-queue"], ["timesheets"], ["payroll-ledger"]],
    enabled: true,
  });

  const approve = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("approve_time_entry", { _id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Approved — cleared from the queue");
      qc.invalidateQueries({ queryKey: ["time-review-queue"] });
      qc.invalidateQueries({ queryKey: ["timesheets"] });
      qc.invalidateQueries({ queryKey: ["payroll-ledger"] });
    },
    onError: (e: Error) => toast.error("Couldn't approve", { description: e.message }),
  });

  const rows = queueQuery.data?.rows ?? [];
  const names = queueQuery.data?.names ?? new Map<string, string>();

  const chipsFor = useMemo(
    () => (r: QueueRow) => {
      const chips = (r.flag_reasons ?? [])
        .filter(
          // A fixed meal stops advertising itself; the flag stays in the
          // array as history but the chip follows the live status.
          (f) =>
            !(
              (f === "missed_meal" && !["missed", "taken_late"].includes(r.meal_status)) ||
              (f === "unrecorded_lunch" && r.meal_status !== "unrecorded")
            ),
        )
        .map((f) => FLAG_LABEL[f] ?? f);
      if (r.entry_source === "auto_closed") chips.unshift("auto-closed");
      if (!r.clock_out) chips.push("still on the clock");
      if (r.meal_status === "pending") chips.push("lunch ? · blocks payroll");
      return chips;
    },
    [],
  );

  // Silence when clean: no queue, no panel, nothing to dismiss.
  if (rows.length === 0) return null;

  return (
    <ArcadePanel
      title={`Time Clock Review · ${rows.length}`}
      action={<BellRing className="w-4 h-4 text-warning animate-pulse" />}
    >
      <div className="space-y-2">
        {rows.map((r) => (
          <div
            key={r.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-warning/40 bg-warning/5 p-3"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium">
                {names.get(r.user_id) ?? "Unknown"}
                <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                  {r.log_date} · {fmtClock(r.clock_in)}
                  {" → "}
                  {r.clock_out ? fmtClock(r.clock_out) : "live"}
                  {" · "}
                  {Number(r.billable_hours ?? 0).toFixed(2)}h
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {chipsFor(r).map((c) => (
                  <span
                    key={c}
                    className="text-[9px] font-display uppercase tracking-widest text-warning border border-warning/40 rounded px-1"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {onLocate && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onLocate({ log_date: r.log_date, name: names.get(r.user_id) ?? "" })
                  }
                  title="Jump to this entry in the timesheet below"
                  className="font-display text-[10px] uppercase tracking-widest"
                >
                  <Crosshair className="w-3.5 h-3.5 mr-1" />
                  Locate
                </Button>
              )}
              {r.needs_correction ? (
                <Button
                  size="sm"
                  disabled={approve.isPending}
                  onClick={() => approve.mutate(r.id)}
                  className="bg-victory text-background hover:bg-victory/90 font-display text-[10px] uppercase tracking-widest"
                >
                  <Check className="w-3.5 h-3.5 mr-1" />
                  Approve
                </Button>
              ) : (
                <span className="text-[9px] font-display uppercase tracking-widest text-muted-foreground">
                  resolve below
                </span>
              )}
            </div>
          </div>
        ))}
        <div className="text-[10px] text-muted-foreground uppercase tracking-widest">
          Approve = the punches are legit as recorded. To change times instead, fix the entry in
          Timesheets — that resolves it too. "Lunch ?" rows need Resolve (or real lunch times) on
          the row, not Approve. Unresolved entries block the week's payroll freeze.
        </div>
      </div>
    </ArcadePanel>
  );
}
