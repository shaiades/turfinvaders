// The Close Kombat title screen (owner 2026-10-02; AI key-art added 2026-10-03;
// centered + VS-badge removed 2026-10-05). A full-bleed arcade key-art banner
// (public/close-kombat-hero.jpg — two fighters clashing, generated with Gemini)
// under a legibility scrim, with the inked "CLOSE KOMBAT" wordmark + admin
// actions centered over it. Owner 2026-10-05: the original art IS the wow, so
// it's left vivid and untouched (the original scrim) — the only changes are the
// centered wordmark and the dropped VS badge. The title stays crisp +
// responsive as CSS text over the image.

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
      className="relative flex min-h-[150px] items-center justify-center overflow-hidden rounded-xl border-2 border-kombat-red/60 bg-kombat-black px-4 py-5 sm:min-h-[184px] sm:px-6 sm:py-7"
      style={{
        boxShadow: "0 0 32px -10px color-mix(in oklab, var(--kombat-red) 70%, transparent)",
      }}
    >
      {/* Key-art backdrop — the full clash scene, left vivid (this is the wow). */}
      <img
        src="/close-kombat-hero.jpg"
        alt=""
        aria-hidden
        className="absolute inset-0 z-0 h-full w-full object-cover object-center"
      />
      {/* Original legibility scrim — keeps the art bright; the inked wordmark
          carries its own contrast over the clash. */}
      <span
        aria-hidden
        className="absolute inset-0 z-0"
        style={{
          background:
            "linear-gradient(90deg, rgba(10,8,12,.92) 0%, rgba(10,8,12,.42) 46%, rgba(10,8,12,.74) 100%)",
        }}
      />
      <span aria-hidden className="pop-halftone z-0 opacity-25" />

      <div className="relative z-10 flex w-full flex-col items-center gap-3 text-center">
        <div>
          <h1
            className="pop-ink font-display uppercase leading-[0.95] tracking-wide text-kombat-gold"
            style={{ fontSize: "clamp(1.5rem, 7vw, 2.8rem)" }}
          >
            Close Kombat
          </h1>
          <p
            className="mx-auto mt-2 max-w-prose text-xs text-white/80"
            style={{ textShadow: "0 1px 3px rgba(0,0,0,.85)" }}
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
