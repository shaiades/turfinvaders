import { useState } from "react";
import { toast } from "sonner";
import { CalendarCheck2, CalendarPlus } from "lucide-react";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addDaysISO, laTodayISO } from "@/lib/dates";
import { KIND_LABEL, useDayOffMutations, useMyDayOff, type DayOffKind } from "@/hooks/useDayOff";

const STATUS_TONE: Record<string, string> = {
  pending: "text-warning border-warning/40",
  approved: "text-victory border-victory/40",
  denied: "text-destructive border-destructive/40",
};

/** Self-serve day-off requests on Mission. Renders nothing until the
 *  day_off_requests table ships (query error → null). */
export function DayOffRequestCard({ userId }: { userId: string }) {
  const today = laTodayISO();
  const myRows = useMyDayOff(userId, addDaysISO(today, -14));
  const { submit, cancel } = useDayOffMutations();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(() => addDaysISO(today, 1));
  const [kind, setKind] = useState<DayOffKind>("day_off");
  const [note, setNote] = useState("");

  if (myRows.data === null || myRows.data === undefined) return null;
  const upcoming = myRows.data;

  return (
    <ArcadePanel title="Days Off">
      <div className="space-y-3">
        {upcoming.length > 0 && (
          <div className="space-y-1.5">
            {upcoming.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="tabular-nums text-muted-foreground">{r.absence_date}</span>
                <span className="flex-1 text-foreground/80">{KIND_LABEL[r.kind]}</span>
                <span
                  className={`text-[9px] font-display uppercase tracking-widest border rounded px-1 ${STATUS_TONE[r.status] ?? "text-muted-foreground border-border"}`}
                  title={r.status === "denied" ? (r.deny_reason ?? undefined) : undefined}
                >
                  {r.status}
                </span>
                {(r.status === "pending" || (r.status === "approved" && r.absence_date >= today)) && (
                  <button
                    type="button"
                    disabled={cancel.isPending}
                    onClick={() =>
                      cancel.mutate(r.id, {
                        onSuccess: () => toast.success("Cancelled"),
                        onError: (e: Error) => toast.error("Couldn't cancel", { description: e.message }),
                      })
                    }
                    className="min-h-11 md:min-h-7 px-1.5 text-[9px] font-display uppercase tracking-widest text-muted-foreground hover:text-destructive"
                  >
                    Cancel
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <Button
          variant="outline"
          onClick={() => setOpen(true)}
          className="w-full min-h-11 font-display text-[10px] uppercase tracking-widest"
        >
          <CalendarPlus className="w-3.5 h-3.5 mr-1.5" />
          Request a day off
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display uppercase tracking-widest text-sm">
              Request a day off
            </DialogTitle>
            <DialogDescription>
              Your captain gets a ping and approves or denies it — you'll get the answer as a
              notification.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                Day
              </span>
              <Input
                type="date"
                min={today}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="text-base md:text-sm"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                Kind
              </span>
              <Select value={kind} onValueChange={(v) => setKind(v as DayOffKind)}>
                <SelectTrigger className="text-base md:text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[10000]">
                  <SelectItem value="day_off">Day off</SelectItem>
                  <SelectItem value="sick">Sick</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                Note · optional
              </span>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder='e.g. "doctor appointment"'
                className="text-base md:text-sm"
              />
            </label>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="min-h-11 md:min-h-9" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!date || submit.isPending}
              onClick={() =>
                submit.mutate(
                  { userId, dates: [date], kind, reason: note.trim() || undefined },
                  {
                    onSuccess: (res) => {
                      if (res.ok > 0) {
                        toast.success("Request sent", {
                          description: "Your captain will get a ping to approve it.",
                        });
                        setOpen(false);
                        setNote("");
                      } else {
                        toast.error("Already requested for that day");
                      }
                    },
                    onError: (e: Error) =>
                      toast.error("Couldn't submit", { description: e.message }),
                  },
                )
              }
              className="min-h-11 md:min-h-9 bg-victory text-background hover:bg-victory/90"
            >
              <CalendarCheck2 className="w-3.5 h-3.5 mr-1.5" />
              Submit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ArcadePanel>
  );
}
