// One-tap knock logging for a house bubble (owner ask 2026-09-10, D2DU-video
// parity): tap the house on the map, tap the result — that's the whole knock.
// A house that already has a result today opens in switch mode (corrections
// adjust stats via the bump trigger); "Knocked again" arms a fresh drop for
// genuine re-knocks so a second visit counts a second door.

import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { PIN_LABELS, type PinType } from "@/lib/pin-results";
import type { OsmHouse } from "@/components/HouseBubbles";

export function HouseResultSheet({
  open,
  onOpenChange,
  house,
  results,
  busy,
  onDrop,
  onSwitch,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  house: OsmHouse | null;
  /** The knock-result vocabulary (the page's KNOCK_RESULTS list). */
  results: Array<{ type: PinType; label: string; color: string; icon: React.ReactNode }>;
  busy: boolean;
  /** Log a fresh knock on this house with the tapped result. */
  onDrop: (house: OsmHouse, pin_type: PinType) => void;
  /** Correct today's existing result on this house. */
  onSwitch: (pinId: string, pin_type: PinType) => void;
}) {
  // Latched copy (PinActionSheet pattern): the parent clears the house while
  // the close animation plays — rendering from `view` keeps it from emptying.
  const [view, setView] = useState<OsmHouse | null>(house);
  // Switch mode is the default when today already logged this house;
  // "Knocked again" flips one interaction to drop mode.
  const [again, setAgain] = useState(false);

  useEffect(() => {
    if (open) {
      setView(house);
      setAgain(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, house?.id]);

  const hasCurrent = !!view?.currentPinId && !again;
  const title = view?.num ? `House ${view.num}` : "This house";

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!busy) onOpenChange(v);
      }}
    >
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle className="font-display text-neon text-base uppercase tracking-widest">
            {title}
          </SheetTitle>
          <SheetDescription>
            {hasCurrent && view?.currentType
              ? `Today: ${PIN_LABELS[view.currentType]} — tap a result to switch it (stats adjust)`
              : "Tap what happened at this door — one tap logs the knock and the result."}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-3 overflow-y-auto px-4 pt-3 pb-4">
          <div className="grid grid-cols-3 gap-2" data-tour="house-results">
            {results.map((r) => {
              const current = hasCurrent && view?.currentType === r.type;
              return (
                <button
                  key={r.type}
                  type="button"
                  disabled={busy || current}
                  onClick={() => {
                    if (!view) return;
                    if (hasCurrent && view.currentPinId) {
                      onSwitch(view.currentPinId, r.type);
                    } else {
                      onDrop(view, r.type);
                    }
                    onOpenChange(false);
                  }}
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

          {!!view?.currentPinId && !again && (
            <Button
              variant="outline"
              className="w-full gap-2"
              disabled={busy}
              onClick={() => setAgain(true)}
            >
              <RotateCcw className="w-4 h-4" />
              Knocked again — log a new result
            </Button>
          )}
          {again && (
            <div className="text-xs text-muted-foreground text-center">
              Next tap logs a fresh knock on this house.
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
