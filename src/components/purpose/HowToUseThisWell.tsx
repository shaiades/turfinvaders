// §19.4 — the leadership guidance panel. The DO / DO NOT copy is VERBATIM
// from the spec. Native <details> (no Collapsible primitive exists in ui/),
// collapsed by default, styled quietly inside the purpose scope.

import { ChevronRight } from "lucide-react";
import { PurposeLabel } from "./kit";

const DO_ITEMS = [
  "Ask questions.",
  "Reference the person’s own stated goal and Core Why.",
  "Separate skill, effort, confidence, opportunity, and life constraints.",
  "Be direct without using personal information as leverage.",
  "Recognize honest progress.",
  "Use existing CRM data as feedback, not identity.",
] as const;

const DO_NOT_ITEMS = [
  "Shame a rep for a private goal.",
  "Publicly expose their answers.",
  "Promise income.",
  "Assume every gap is a motivation problem.",
  "Use a stated family, debt, or personal reason as pressure.",
  "Treat the profile as a replacement for a real conversation.",
] as const;

export function HowToUseThisWell() {
  return (
    <details className="purpose-card group px-5 py-2 md:px-6">
      <summary className="flex min-h-11 cursor-pointer select-none list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-4 shrink-0 text-[var(--purpose-ink-dim)] transition-transform group-open:rotate-90"
          aria-hidden
        />
        <span className="text-base font-medium">How to Use This Well</span>
      </summary>
      <div className="grid gap-5 pb-4 pt-2 md:grid-cols-2">
        <div>
          <PurposeLabel>Do</PurposeLabel>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed">
            {DO_ITEMS.map((t) => (
              <li key={t} className="flex gap-2">
                <span className="text-[var(--purpose-tide)]" aria-hidden>
                  •
                </span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <PurposeLabel>Do not</PurposeLabel>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed">
            {DO_NOT_ITEMS.map((t) => (
              <li key={t} className="flex gap-2">
                <span className="text-[var(--purpose-ink-dim)]" aria-hidden>
                  •
                </span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  );
}
