// Kombat Month — the arcade "arena" layer (owner directive 2026-10-02):
// drifting red/gold spotlights behind the whole tab and the "make it rain"
// gold-coin shower on the hero. Pure garnish — absolutely positioned,
// pointer-events-none, and gated on prefers-reduced-motion by the CSS
// utilities in styles.css (kombat-arena / kombat-coin). Nothing here renders
// real data, so it can never be wrong; it only dresses the stage.

import { useMemo, type CSSProperties } from "react";

/** Drifting blood-red/trophy-gold arena spotlights. Drop as the first child of
 *  a `relative` wrapper and keep the real content in a sibling with
 *  `relative z-10` so it sits above the glow. */
export function ArenaBackdrop() {
  // Self-clipping: the inner glow bleeds 15% past the edges so the drift never
  // shows a hard border, and this wrapper clips that bleed to the tab bounds
  // so it can never leak into a stray scrollbar (AGENTS.md rule 2).
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      <div className="kombat-arena" />
    </div>
  );
}

/** A clipped layer of gold coins raining down. Make the parent `relative`
 *  (this fills it at z-0, behind the content); the CSS utility clips the
 *  overflow. Count stays low — a garnish, not a particle system. */
export function CoinRain({ count = 14, className }: { count?: number; className?: string }) {
  const coins = useMemo(() => {
    // Cheap deterministic jitter (sine hash on the index) so coins scatter but
    // don't re-roll on every parent re-render — only when `count` changes.
    const r = (i: number, seed: number) => (Math.sin((i + 1) * seed) + 1) / 2;
    return Array.from({ length: count }, (_, i) => ({
      "--coin-left": `${Math.round(r(i, 12.9) * 100)}%`,
      "--coin-size": `${9 + Math.round(r(i, 78.2) * 9)}px`,
      "--coin-dur": `${(2.8 + r(i, 3.3) * 2.6).toFixed(2)}s`,
      "--coin-delay": `${(r(i, 5.1) * -5).toFixed(2)}s`,
      "--coin-opacity": (0.35 + r(i, 9.7) * 0.4).toFixed(2),
      "--coin-drop": `${440 + Math.round(r(i, 1.7) * 260)}%`,
    }));
  }, [count]);

  return (
    <div
      aria-hidden
      className={"pointer-events-none absolute inset-0 overflow-hidden " + (className ?? "")}
    >
      {coins.map((style, i) => (
        <span key={i} className="kombat-coin" style={style as CSSProperties} />
      ))}
    </div>
  );
}
