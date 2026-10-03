// The Close Kombat title screen (owner 2026-10-02: fix the "missing image").
// A comic-book / arcade title card in the flyer house style — halftone field,
// lightning, a starburst, and the inked "CLOSE KOMBAT" wordmark — that replaces
// the old plain <Swords/> + text header. Pure CSS + inline SVG (no asset
// pipeline), so it's crisp in both themes and costs nothing to ship.

import type { ReactNode } from "react";

export function KombatHeroBanner({
  actions,
  subtitle = "Sales rep results · straight from the Monday.com Block boards",
}: {
  actions?: ReactNode;
  subtitle?: string;
}) {
  return (
    <section
      className="relative overflow-hidden rounded-xl border-2 border-kombat-red/60 bg-kombat-black px-4 py-5 sm:px-6 sm:py-6"
      style={{
        boxShadow:
          "0 0 32px -10px color-mix(in oklab, var(--kombat-red) 70%, transparent), inset 0 0 60px -30px color-mix(in oklab, var(--kombat-gold) 60%, transparent)",
      }}
    >
      {/* Halftone wash + drifting arena light behind everything. */}
      <span aria-hidden className="pop-halftone" />
      <span aria-hidden className="kombat-arena" />

      {/* Lightning bolts, flyer-style. */}
      <svg
        aria-hidden
        viewBox="0 0 40 120"
        className="pointer-events-none absolute -left-1 top-0 h-full w-10 opacity-70"
        fill="none"
      >
        <path d="M24 2 L8 54 L20 54 L10 118 L34 46 L21 46 Z" fill="var(--kombat-gold)" />
      </svg>

      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            {/* Starburst emblem with the versus mark. */}
            <span aria-hidden className="relative hidden h-12 w-12 shrink-0 sm:inline-flex">
              <span className="pop-burst absolute inset-0 bg-kombat-gold" />
              <span className="pop-burst absolute inset-[3px] bg-kombat-red" />
              <span className="absolute inset-0 grid place-items-center font-display text-[11px] text-kombat-black">
                VS
              </span>
            </span>
            <h1
              className="pop-ink font-display uppercase leading-[0.95] tracking-wide text-kombat-gold"
              style={{ fontSize: "clamp(1.4rem, 7vw, 2.6rem)" }}
            >
              Close Kombat
            </h1>
          </div>
          <p className="mt-2 max-w-prose text-xs text-muted-foreground">{subtitle}</p>
        </div>

        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </section>
  );
}
