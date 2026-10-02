// Kombat Month — the scorecard (owner revamp 2026-10-02): the fighting-game
// "move list" of exactly what everything is worth, so a rep knows precisely
// how to rack up points. Reads live from `rules` via buildScorecard, so it
// can never drift from the owner's config.

import { ArcadePanel } from "@/components/arcade";
import { buildScorecard, fmtPts, type KombatRules } from "@/lib/kombat-month";

const GROUP_ACCENT: Record<string, string> = {
  money: "var(--kombat-gold)",
  close: "var(--kombat-red)",
  activity: "var(--accent)",
  proofs: "var(--victory)",
};

export function KombatScorecard({ rules }: { rules: KombatRules }) {
  const groups = buildScorecard(rules);
  return (
    <ArcadePanel title="Scorecard — what everything's worth" faction="kombat" status="good">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {groups.map((g, i) => {
          const accent = GROUP_ACCENT[g.key] ?? "var(--kombat-gold)";
          return (
            <div
              key={g.key}
              className="section-enter min-w-0 rounded-lg border p-3 transition-colors hover:border-[color-mix(in_oklab,var(--move-accent)_45%,transparent)]"
              style={{
                ["--move-accent" as string]: accent,
                borderColor: `color-mix(in oklab, ${accent} 25%, transparent)`,
                background: `color-mix(in oklab, ${accent} 5%, transparent)`,
                animationDelay: `${i * 60}ms`,
              }}
            >
              <div
                className="font-display text-[10px] uppercase tracking-widest"
                style={{ color: accent }}
              >
                {g.title}
              </div>
              <div className="mb-2 text-[9px] uppercase tracking-wider text-muted-foreground">
                {g.hint}
              </div>
              <ul className="space-y-0.5">
                {g.moves.map((m) => (
                  <li
                    key={m.label}
                    className="group -mx-1.5 flex items-baseline gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-[color-mix(in_oklab,var(--move-accent)_12%,transparent)]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium leading-tight">
                        {m.label}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {m.per}
                        {m.note ? ` · ${m.note}` : ""}
                      </span>
                    </span>
                    <span
                      className="shrink-0 font-mono tabular-nums text-base font-bold transition-transform group-hover:scale-110 group-hover:[text-shadow:0_0_14px_var(--move-accent)]"
                      style={{ color: accent }}
                    >
                      +{fmtPts(m.points)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </ArcadePanel>
  );
}
