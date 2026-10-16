// The door script, one tap from the Active Run map (Phase 2 §1, owner
// 2026-10-15): Shai's real canvass script as a 6-step stepper — Intro/Need →
// Close → Info → Separate the Spouse → Set the Stage → Confirmation — with
// the CURRENT step big and readable in sunlight (18px body lines, solid
// surface, no glow). All copy lives in src/data/door-script.ts; this
// component renders it and never hard-codes a word.

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { SCRIPT_STEPS } from "@/data/door-script";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

export function DoorScriptSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [idx, setIdx] = useState(0);
  // Every door starts at the top — a sheet reopened mid-street should never
  // resume on Confirmation.
  useEffect(() => {
    if (open) setIdx(0);
  }, [open]);

  const step = SCRIPT_STEPS[idx];
  const last = SCRIPT_STEPS.length - 1;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined} className="max-h-[88dvh]">
        <SheetHeader className="pr-10">
          <SheetTitle className="font-display text-base uppercase tracking-widest text-neon">
            The Script
          </SheetTitle>
          <SheetDescription className="sr-only">The door script, step by step</SheetDescription>
        </SheetHeader>

        {/* Stepper chips — nav strip, horizontal scroll on the smallest phones */}
        <div className="scrollbar-hide flex gap-1 overflow-x-auto px-4 pt-2">
          {SCRIPT_STEPS.map((s, i) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setIdx(i)}
              aria-current={i === idx ? "step" : undefined}
              className={`min-h-11 shrink-0 rounded-lg px-2.5 font-display text-[10px] uppercase tracking-wider transition md:min-h-0 md:py-1.5 ${
                i === idx
                  ? "bg-neon text-background"
                  : i < idx
                    ? "bg-neon/15 text-neon"
                    : "bg-foreground/5 text-muted-foreground"
              }`}
            >
              {s.order}. {s.label}
            </button>
          ))}
        </div>

        {/* Current step — big, solid, sunlight-first */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2 pt-3">
          <div className="font-display text-xs uppercase tracking-widest text-muted-foreground">
            Step {step.order} of {SCRIPT_STEPS.length}
          </div>
          <h3 className="mt-0.5 font-display text-lg uppercase tracking-wide text-foreground">
            {step.title}
          </h3>
          <div className="mt-3 space-y-3">
            {step.lines.map((l, i) =>
              l.kind === "say" ? (
                <p key={i} className="text-lg font-semibold leading-snug text-foreground">
                  “{l.text}”
                </p>
              ) : (
                <p
                  key={i}
                  className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                >
                  {l.text}
                </p>
              ),
            )}
          </div>
        </div>

        {/* Prev / Next — thumb-sized, bottom of the sheet */}
        <div className="flex gap-2 border-t border-border/60 px-4 py-3 pb-safe">
          <button
            type="button"
            disabled={idx === 0}
            onClick={() => setIdx((i) => Math.max(0, i - 1))}
            className="flex min-h-11 flex-1 items-center justify-center gap-1 rounded-xl border border-border font-display text-xs uppercase tracking-widest text-muted-foreground disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" /> Back
          </button>
          {idx < last ? (
            <button
              type="button"
              onClick={() => setIdx((i) => Math.min(last, i + 1))}
              className="flex min-h-11 flex-[2] items-center justify-center gap-1 rounded-xl bg-neon font-display text-xs uppercase tracking-widest text-background"
            >
              {SCRIPT_STEPS[idx + 1].label} <ChevronRight className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="flex min-h-11 flex-[2] items-center justify-center rounded-xl bg-neon font-display text-xs uppercase tracking-widest text-background"
            >
              Knock the next door
            </button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
