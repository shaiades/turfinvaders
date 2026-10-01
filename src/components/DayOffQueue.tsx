import { useState } from "react";
import { toast } from "sonner";
import { CalendarClock, Check, X } from "lucide-react";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { KIND_LABEL, useDayOffMutations, useDayOffQueue } from "@/hooks/useDayOff";

/**
 * Pending day-off requests awaiting review. Captains see their own van
 * (teamId), Admins everyone; the review RPC enforces the same boundaries
 * (own team, never your own request). Silent when empty or until the
 * table ships. Pattern kin: TimeClockReviewQueue + ObjectionReviewPanel.
 */
export function DayOffQueue({ teamId }: { teamId?: string | null }) {
  const queue = useDayOffQueue(teamId);
  const { review } = useDayOffMutations();
  const [denying, setDenying] = useState<string | null>(null);
  const [denyNote, setDenyNote] = useState("");

  useRealtimeInvalidate({
    channel: `day-off-queue-${teamId ?? "all"}`,
    tables: ["day_off_requests"],
    invalidateKeys: [["day-off"]],
  });

  const rows = queue.data?.rows ?? [];
  const names = queue.data?.names ?? new Map<string, string>();
  if (!queue.data || rows.length === 0) return null;

  const act = (id: string, approve: boolean, denyReason?: string) =>
    review.mutate(
      { id, approve, denyReason },
      {
        onSuccess: () => {
          toast.success(approve ? "Approved — they're covered" : "Denied — they'll see your note");
          setDenying(null);
          setDenyNote("");
        },
        onError: (e: Error) => toast.error("Couldn't review", { description: e.message }),
      },
    );

  return (
    <ArcadePanel
      title={`Day Off Requests · ${rows.length}`}
      action={<CalendarClock className="w-4 h-4 text-warning animate-pulse" />}
    >
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="rounded border border-warning/40 bg-warning/5 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="text-sm font-medium">{names.get(r.user_id) ?? "Unknown"}</span>
                <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                  {r.absence_date} · {KIND_LABEL[r.kind]}
                </span>
                {r.reason && (
                  <div className="text-xs text-foreground/80 mt-0.5">“{r.reason}”</div>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  disabled={review.isPending}
                  onClick={() => act(r.id, true)}
                  className="min-h-11 md:min-h-8 bg-victory text-background hover:bg-victory/90 font-display text-[10px] uppercase tracking-widest"
                >
                  <Check className="w-3.5 h-3.5 mr-1" />
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={review.isPending}
                  onClick={() => setDenying(denying === r.id ? null : r.id)}
                  className="min-h-11 md:min-h-8 border-destructive/50 text-destructive font-display text-[10px] uppercase tracking-widest"
                >
                  <X className="w-3.5 h-3.5 mr-1" />
                  Deny
                </Button>
              </div>
            </div>
            {denying === r.id && (
              <div className="space-y-2">
                <Textarea
                  autoFocus
                  value={denyNote}
                  onChange={(e) => setDenyNote(e.target.value)}
                  placeholder="Why not? They read this note."
                  className="text-base md:text-sm min-h-16"
                />
                <Button
                  size="sm"
                  disabled={!denyNote.trim() || review.isPending}
                  onClick={() => act(r.id, false, denyNote.trim())}
                  className="min-h-11 md:min-h-8 bg-destructive text-destructive-foreground hover:bg-destructive/90 font-display text-[10px] uppercase tracking-widest"
                >
                  Send denial
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </ArcadePanel>
  );
}
