import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * The reason capture for every audited time-record change (replaces the old
 * window.prompt). The reason is REQUIRED — it lands verbatim on
 * time_entry_audit next to the actor and before/after values, and it's what
 * makes a third-party edit defensible in a wage dispute. One component so
 * the copy and validation can't drift between save/void/clock-out flows.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title = "Reason required",
  prompt,
  confirmLabel = "Save",
  destructive = false,
  pending = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  /** What the change IS, e.g. "Clock Jane out as of right now". */
  prompt: string;
  confirmLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);
  const trimmed = reason.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display uppercase tracking-widest text-sm">
            {title}
          </DialogTitle>
          <DialogDescription>{prompt}</DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder='e.g. "forgot to punch out — confirmed 4:30 PM with the captain"'
          className="text-base md:text-sm min-h-20"
        />
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
          Goes on the audit trail with your name and the before/after times.
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            className="min-h-11 md:min-h-9"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={!trimmed || pending}
            onClick={() => onSubmit(trimmed)}
            className={
              destructive
                ? "min-h-11 md:min-h-9 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "min-h-11 md:min-h-9 bg-victory text-background hover:bg-victory/90"
            }
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
