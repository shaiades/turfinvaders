// Assign one ZIP code to a captain (admin tier only — owner ask 2026-09-11:
// "assign zip codes to captains, and then they can chunk them out to their
// canvassers"). Opened by tapping a ZIP on the manager map in Assign-ZIPs
// mode. Captains then carve the ZIP into turfs with the existing drawing
// flow; this sheet only decides whose zone the ZIP is.

import { useEffect, useState } from "react";
import { Check, History, MapPinned, Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { assigneeColor, initials } from "@/lib/assignee-colors";

export type AssignableCaptain = {
  id: string;
  display_name: string;
  office_location: string | null;
};

export function AssignZipSheet({
  open,
  onOpenChange,
  zip,
  currentCaptainId,
  currentCaptainName,
  captains,
  saving,
  historyCount,
  onAssign,
  onSweepHistory,
  onUnassign,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  zip: string | null;
  currentCaptainId: string | null;
  currentCaptainName: string | null;
  captains: AssignableCaptain[];
  saving: boolean;
  /** Historic RepCard rings inside this ZIP: undefined = still counting,
   *  null = boundary unavailable (the cascade would find nothing). */
  historyCount?: number | null;
  onAssign: (captainId: string, includeHistory: boolean) => void;
  /** Hand the historic areas to the EXISTING zone captain (pre-cascade ZIPs
   *  were assigned before this sweep existed). */
  onSweepHistory?: () => void;
  onUnassign: () => void;
}) {
  // Latched copy (PinActionSheet pattern) so the closing animation doesn't
  // render an emptied sheet.
  const [view, setView] = useState<{ zip: string | null; current: string | null }>({
    zip,
    current: currentCaptainId,
  });
  // Cascade opt-out — re-armed each open (owner default: history follows the
  // ZIP, owner ask 2026-09-28).
  const [withHistory, setWithHistory] = useState(true);
  // The count is latched too: closing clears zipTarget upstream, which flips
  // the live prop back to "counting" mid-animation.
  const [count, setCount] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (open) {
      setView({ zip, current: currentCaptainId });
      setWithHistory(true);
    }
  }, [open, zip, currentCaptainId]);
  useEffect(() => {
    if (open) setCount(historyCount);
  }, [open, historyCount]);
  const sweepable = typeof count === "number" && count > 0;

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!saving) onOpenChange(v);
      }}
    >
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle className="font-display text-neon text-base uppercase tracking-widest">
            ZIP {view.zip ?? ""}
          </SheetTitle>
          <SheetDescription>
            {view.current
              ? `Zone captain: ${currentCaptainName ?? "assigned"} — tap another captain to hand it off.`
              : "Unassigned — tap a captain to make this their zone."}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-2 overflow-y-auto px-4 pt-3 pb-2">
          {/* Cascade row: assigning the ZIP can also hand over every historic
              RepCard ring inside it (owner ask 2026-09-28). Hidden when there
              is nothing to sweep or the boundary lookup failed. */}
          {count === undefined ? (
            <div className="flex min-h-11 items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground">
              <History className="h-3.5 w-3.5 shrink-0" /> Checking historic areas…
            </div>
          ) : sweepable ? (
            <button
              type="button"
              role="checkbox"
              aria-checked={withHistory}
              disabled={saving}
              onClick={() => setWithHistory((v) => !v)}
              className={`w-full min-h-11 flex items-center gap-3 px-3 py-1.5 rounded border text-left transition-colors ${
                withHistory
                  ? "border-neon bg-neon/10"
                  : "border-border bg-surface hover:border-neon/60"
              } disabled:opacity-50`}
            >
              <span
                aria-hidden
                className={`shrink-0 w-5 h-5 rounded border flex items-center justify-center ${
                  withHistory ? "border-neon bg-neon text-background" : "border-muted-foreground/50"
                }`}
              >
                {withHistory && <Check className="w-3.5 h-3.5" />}
              </span>
              <span className="min-w-0 flex-1 text-sm">
                Also assign the {count} historic area{count === 1 ? "" : "s"} in this ZIP
                <span className="block text-[10px] uppercase tracking-widest text-muted-foreground">
                  Dashed RepCard rings become their live areas
                </span>
              </span>
              <History className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ) : null}
          {captains.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No captains on the roster yet — promote one in Manage Players first.
            </div>
          ) : (
            captains.map((c) => {
              const color = assigneeColor(c.id);
              const isCurrent = view.current === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={saving || isCurrent}
                  onClick={() => onAssign(c.id, withHistory && sweepable)}
                  className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left min-h-14 ${saving ? "opacity-60" : ""}`}
                  style={{
                    borderColor: isCurrent ? color : "var(--border)",
                    background: isCurrent
                      ? `color-mix(in oklab, ${color} 14%, var(--surface))`
                      : "var(--surface)",
                    boxShadow: isCurrent ? `0 0 14px -4px ${color}` : "none",
                  }}
                >
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-display text-[10px]"
                    style={{
                      background: `color-mix(in oklab, ${color} 25%, var(--surface))`,
                      color,
                      border: `1px solid ${color}`,
                    }}
                  >
                    {initials(c.display_name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{c.display_name}</span>
                    <span className="block text-[10px] uppercase tracking-widest text-muted-foreground">
                      {c.office_location ?? "—"}
                      {isCurrent ? " · current zone captain" : ""}
                    </span>
                  </span>
                  <MapPinned className="h-4 w-4 shrink-0" style={{ color }} />
                </button>
              );
            })
          )}
        </div>

        {view.current && (
          <SheetFooter className="gap-2">
            {/* This ZIP already has a zone captain — sweep the historic areas
                to them without re-assigning the ZIP. */}
            {sweepable && onSweepHistory && (
              <Button
                variant="outline"
                className="w-full"
                disabled={saving}
                onClick={onSweepHistory}
              >
                <History className="mr-1 h-4 w-4" />
                {`Give ${count} historic area${count === 1 ? "" : "s"} to ${
                  (currentCaptainName ?? "the zone captain").trim().split(/\s+/)[0]
                }`}
              </Button>
            )}
            <Button variant="destructive" className="w-full" disabled={saving} onClick={onUnassign}>
              <Trash2 className="mr-1 h-4 w-4" />
              {saving ? "Working…" : `Unassign ZIP ${view.zip ?? ""}`}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
