// The Close Kombat title screen (owner 2026-10-02; AI key-art added 2026-10-03).
// A full-bleed arcade key-art banner (public/close-kombat-hero.jpg — two fighters
// clashing, generated with Gemini) under a legibility scrim, with the inked
// "CLOSE KOMBAT" wordmark + admin actions overlaid. The image is the real "missing
// image"; the title stays crisp + responsive as CSS text over it. Falls back to
// the kombat-black panel if the asset ever fails to load.

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
      className="relative flex min-h-[150px] items-center overflow-hidden rounded-xl border-2 border-kombat-red/60 bg-kombat-black px-4 py-5 sm:min-h-[184px] sm:px-6 sm:py-7"
      style={{
        boxShadow: "0 0 32px -10px color-mix(in oklab, var(--kombat-red) 70%, transparent)",
      }}
    >
      {/* Key-art backdrop + legibility scrim + a touch of halftone. */}
      <img
        src="/close-kombat-hero.jpg"
        alt=""
        aria-hidden
        className="absolute inset-0 z-0 h-full w-full object-cover object-center"
      />
      <span
        aria-hidden
        className="absolute inset-0 z-0"
        style={{
          background:
            "linear-gradient(90deg, rgba(10,8,12,.92) 0%, rgba(10,8,12,.42) 46%, rgba(10,8,12,.74) 100%)",
        }}
      />
      <span aria-hidden className="pop-halftone z-0 opacity-25" />

      <div className="relative z-10 flex w-full flex-wrap items-center justify-between gap-3">
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
              style={{ fontSize: "clamp(1.5rem, 7vw, 2.8rem)" }}
            >
              Close Kombat
            </h1>
          </div>
          <p className="mt-2 max-w-prose text-xs text-white/75">{subtitle}</p>
        </div>

        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </section>
  );
}
