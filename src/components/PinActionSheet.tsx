// Pin action sheet — same-day pin corrections for canvassers. Tapping a pin
// on the Territory map opens this: switch the knock result or delete the pin;
// the extended bump_daily_log_from_pin trigger keeps daily_logs counters in
// step with either correction. Deliberately leaflet-free (ui/sheet renders at
// z-[9999], above Leaflet's z-1000 panes).

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { PIN_LABELS, type PinType } from "@/lib/pin-results";
import { laDateTimeLabel } from "@/lib/dates";

export type EditablePin = {
  id: string;
  pin_type: PinType;
  is_remote_drop?: boolean;
  created_at?: string;
};

export function PinActionSheet({
  open,
  onOpenChange,
  pin,
  results,
  updating,
  deleting,
  onSelect,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  pin: EditablePin | null;
  /** The knock-result vocabulary (the page's KNOCK_RESULTS list). */
  results: Array<{ type: PinType; label: string; color: string; icon: React.ReactNode }>;
  updating: boolean;
  deleting: boolean;
  onSelect: (pin_type: PinType) => void;
  onDelete: () => void;
}) {
  const busy = updating || deleting;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Latched copy (AreaDetailsSheet pattern): while the close animation plays
  // the parent clears editingPinId — rendering from `view` keeps the closing
  // sheet from visibly emptying.
  const [view, setView] = useState<EditablePin | null>(pin);

  useEffect(() => {
    if (open) {
      setView(pin);
      setConfirmingDelete(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pin?.id, pin?.pin_type]);

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!busy) onOpenChange(v);
      }}
    >
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle className="font-display text-neon text-base">EDIT PIN</SheetTitle>
          <SheetDescription>
            {view
              ? `Currently ${PIN_LABELS[view.pin_type]}${view.created_at ? ` · dropped ${laDateTimeLabel(view.created_at)}` : ""}`
              : ""}
          </SheetDescription>
          {view?.is_remote_drop && (
            <div className="rounded border border-yellow-500/50 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-500">
              Remote drop — this pin never counts toward stats, whatever its result.
            </div>
          )}
        </SheetHeader>

        <div className="space-y-3 overflow-y-auto px-4 pt-3">
          <div className="text-sm font-medium">Switch result to</div>
          <div className="grid grid-cols-3 gap-2">
            {results.map((r) => {
              const current = view?.pin_type === r.type;
              return (
                <button
                  key={r.type}
                  type="button"
                  disabled={busy || current}
                  onClick={() => onSelect(r.type)}
                  className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-lg border p-2 ${busy ? "opacity-60" : ""}`}
                  style={{
                    color: r.color,
                    borderColor: current ? r.color : "var(--border)",
                    background: current
                      ? `color-mix(in oklab, ${r.color} 14%, var(--surface))`
                      : "var(--surface)",
                    boxShadow: current ? `0 0 14px -4px ${r.color}` : "none",
                  }}
                >
                  {r.icon}
                  <span className="font-display text-[9px] uppercase tracking-widest">
                    {r.label}
                  </span>
                  {current && (
                    <span className="text-[8px] uppercase tracking-widest text-muted-foreground">
                      Current
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <SheetFooter>
          {confirmingDelete ? (
            <div className="flex w-full gap-2">
              <Button
                variant="outline"
                className="flex-1"
                disabled={busy}
                onClick={() => setConfirmingDelete(false)}
              >
                Keep pin
              </Button>
              <Button variant="destructive" className="flex-1" disabled={busy} onClick={onDelete}>
                <Trash2 className="w-4 h-4 mr-1" />
                {deleting ? "Deleting…" : "Yes, delete"}
              </Button>
            </div>
          ) : (
            <Button
              variant="destructive"
              className="w-full"
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 className="w-4 h-4 mr-1" />
              Delete pin
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
