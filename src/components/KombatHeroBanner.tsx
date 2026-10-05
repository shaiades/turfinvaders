// The Close Kombat title screen (owner 2026-10-02; AI key-art added 2026-10-03;
// centered + VS-badge removed 2026-10-05). A full-bleed arcade key-art banner
// (public/close-kombat-hero.jpg — two fighters clashing, generated with Gemini)
// under a legibility scrim, with the inked "CLOSE KOMBAT" wordmark + admin
// actions centered over it. The art is a symmetric VS scene, so the wordmark
// sits dead-center in the arena with a fighter framing each edge; a center-
// weighted scrim keeps the title legible over the bright clash while the
// flanking fighters stay visible. The title stays crisp + responsive as CSS
// text over the image.

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
      className="relative flex min-h-[168px] items-center justify-center overflow-hidden rounded-xl border-2 border-kombat-red/60 bg-kombat-black px-4 py-6 sm:min-h-[208px] sm:px-6 sm:py-8"
      style={{
        boxShadow: "0 0 32px -10px color-mix(in oklab, var(--kombat-red) 70%, transparent)",
      }}
    >
      {/* Key-art backdrop — the FULL clash scene (both fighters + the arena),
          shown whole so the art reads (owner 2026-10-05: the original image is
          the amazing part; just lose the VS badge and center the title). */}
      <img
        src="/close-kombat-hero.jpg"
        alt=""
        aria-hidden
        className="absolute inset-0 z-0 h-full w-full object-cover object-center"
      />
      {/* Center-weighted legibility scrim: darkens behind the wordmark over the
          bright clash, fading out toward the flanking fighters so they show. */}
      <span
        aria-hidden
        className="absolute inset-0 z-0"
        style={{
          background:
            "radial-gradient(ellipse 58% 135% at 50% 46%, rgba(10,8,12,.9) 0%, rgba(10,8,12,.5) 52%, rgba(10,8,12,.12) 80%), linear-gradient(180deg, rgba(10,8,12,.28), rgba(10,8,12,.6))",
        }}
      />
      <span aria-hidden className="pop-halftone z-0 opacity-20" />

      <div className="relative z-10 flex w-full flex-col items-center gap-3 text-center">
        <div>
          <h1
            className="pop-ink font-display uppercase leading-[0.95] tracking-wide text-kombat-gold"
            style={{ fontSize: "clamp(1.75rem, 8vw, 3.25rem)" }}
          >
            Close Kombat
          </h1>
          <p
            className="mx-auto mt-2 max-w-prose text-xs text-white/85 sm:text-sm"
            style={{ textShadow: "0 1px 3px rgba(0,0,0,.9)" }}
          >
            {subtitle}
          </p>
        </div>

        {actions && (
          <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div>
        )}
      </div>
    </section>
  );
}
