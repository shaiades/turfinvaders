// Assign one ZIP code to a captain (admin tier only — owner ask 2026-09-11:
// "assign zip codes to captains, and then they can chunk them out to their
// canvassers"). Opened by tapping a ZIP on the manager map in Assign-ZIPs
// mode. Captains then carve the ZIP into turfs with the existing drawing
// flow; this sheet only decides whose zone the ZIP is.

import { useEffect, useState } from "react";
import { MapPinned, Trash2 } from "lucide-react";
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
  onAssign,
  onUnassign,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  zip: string | null;
  currentCaptainId: string | null;
  currentCaptainName: string | null;
  captains: AssignableCaptain[];
  saving: boolean;
  onAssign: (captainId: string) => void;
  onUnassign: () => void;
}) {
  // Latched copy (PinActionSheet pattern) so the closing animation doesn't
  // render an emptied sheet.
  const [view, setView] = useState<{ zip: string | null; current: string | null }>({
    zip,
    current: currentCaptainId,
  });
  useEffect(() => {
    if (open) setView({ zip, current: currentCaptainId });
  }, [open, zip, currentCaptainId]);

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
                  onClick={() => onAssign(c.id)}
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
          <SheetFooter>
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
