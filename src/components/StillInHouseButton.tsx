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
import { Home, Loader2, MapPin, CheckCircle2, AlertTriangle } from "lucide-react";
import {
  useReportStillInHouse,
  useMyInHousePingsToday,
  LocationRequiredError,
  type InHousePing,
} from "@/hooks/useInHousePings";
import type { MyLeadCard } from "@/hooks/useMyLeads";

/**
 * "Still in house — can't make it" (owner mandate 2026-11-20). A rep mid-sit
 * who can't run their next lead taps this on the lead's card. The tap works
 * ONLY with a live GPS fix: the dialog says up front that their current
 * location + address go to dispatch, the submit captures the fix, and the
 * confirmation shows the rep exactly what was logged — so the button can't be
 * juiced from somewhere else, and dispatch knows to cover the lead or call
 * the customer to push. Location denied / unavailable = no ping, by design.
 * Mobile-first: ≥44px targets, ≥16px note input so iOS doesn't zoom-jump.
 */

function timeLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Los_Angeles",
    });
  } catch {
    return "";
  }
}

function PingSummary({ ping }: { ping: InHousePing }) {
  return (
    <div className="space-y-1 rounded-md border border-victory/40 bg-victory/5 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-victory">
        <CheckCircle2 className="size-4 shrink-0" /> Logged at {timeLabel(ping.created_at)}
      </p>
      <a
        href={`https://maps.google.com/?q=${ping.lat},${ping.lng}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-h-11 items-center gap-2 rounded-md border border-border/40 bg-background/40 px-3 text-foreground active:bg-background/70"
      >
        <MapPin className="size-4 shrink-0 text-neon" />
        <span className="min-w-0 truncate">
          {ping.located_address ?? `${ping.lat.toFixed(5)}, ${ping.lng.toFixed(5)}`}
        </span>
      </a>
      <p className="text-xs text-muted-foreground">
        Your location and address were sent to dispatch — they’ll cover the lead or call the
        customer to push the appointment.
      </p>
    </div>
  );
}

export function StillInHouseButton({
  card,
  repName,
  className,
}: {
  card: MyLeadCard;
  repName: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const report = useReportStillInHouse();
  const myPings = useMyInHousePingsToday();

  // Latest ping for THIS lead today, if any — the card shows "flagged" state.
  const existing = (myPings.data ?? []).find((p) => p.monday_item_id === card.monday_item_id);
  // The fix just captured in this dialog session (takes precedence for display).
  const justLogged = report.data && report.data.monday_item_id === card.monday_item_id;
  const latest = justLogged ? report.data : existing;

  useEffect(() => {
    if (open) {
      setNote("");
      report.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const locationDenied = report.error instanceof LocationRequiredError;

  return (
    <>
      <Button variant="outline" className={className} onClick={() => setOpen(true)}>
        <Home className="size-4" />
        {existing
          ? `Still in house · ${timeLabel(existing.created_at)}`
          : "Still in house — can’t make it"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display uppercase tracking-widest text-sm">
              Still in house?
            </DialogTitle>
            <DialogDescription>
              Can’t make {card.lead_name || "this lead"}
              {card.address ? ` (${card.address})` : ""} because you’re still in your current sit?
              This logs your <strong>current GPS location and address</strong> and sends it to
              dispatch so they can cover the lead or push the appointment.
            </DialogDescription>
          </DialogHeader>

          {latest ? (
            <PingSummary ping={latest} />
          ) : (
            <>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note — e.g. “closing now, need 45 more min”"
                className="min-h-20 text-base md:text-sm"
                maxLength={300}
              />
              {report.isError && (
                <p className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  {locationDenied
                    ? "Couldn’t get your location — the ping needs it. Turn on Location Services for your browser and try again."
                    : "Couldn’t log the ping. Check your signal and try again."}
                </p>
              )}
            </>
          )}

          <DialogFooter>
            {latest ? (
              <Button className="w-full" onClick={() => setOpen(false)}>
                Done
              </Button>
            ) : (
              <Button
                className="w-full"
                disabled={report.isPending}
                onClick={() =>
                  report.mutate({
                    mondayItemId: card.monday_item_id,
                    leadName: card.lead_name,
                    leadAddress: card.address,
                    repName,
                    note,
                  })
                }
              >
                {report.isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Getting your location…
                  </>
                ) : (
                  <>
                    <MapPin className="size-4" /> Share my location &amp; notify dispatch
                  </>
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
