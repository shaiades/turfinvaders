// Kombat Month — the scorecard (owner revamp 2026-10-02): the fighting-game
// "move list" of exactly what everything is worth, so a rep knows precisely
// how to rack up points. Reads live from `rules` via buildScorecard, so it
// can never drift from the owner's config.

import { ArcadePanel } from "@/components/arcade";
import { buildScorecard, fmtPts, type KombatRules } from "@/lib/kombat-month";

const GROUP_ACCENT: Record<string, string> = {
  money: "var(--kombat-gold)",
  activity: "var(--kombat-red)",
  proofs: "var(--accent)",
};

export function KombatScorecard({ rules }: { rules: KombatRules }) {
  const groups = buildScorecard(rules);
  return (
    <ArcadePanel title="Scorecard — what everything's worth" faction="kombat" status="good">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {groups.map((g) => {
          const accent = GROUP_ACCENT[g.key] ?? "var(--kombat-gold)";
          return (
            <div key={g.key} className="min-w-0">
              <div
                className="mb-2 border-b pb-1.5 font-display text-[10px] uppercase tracking-widest"
                style={{
                  color: accent,
                  borderColor: `color-mix(in oklab, ${accent} 30%, transparent)`,
                }}
              >
                {g.title}
              </div>
              <ul className="space-y-0.5">
                {g.moves.map((m) => (
                  <li
                    key={m.label}
                    className="flex items-center gap-2 rounded px-1.5 py-1.5 hover:bg-[color-mix(in_oklab,var(--foreground)_4%,transparent)]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{m.label}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {m.per}
                        {m.note ? ` · ${m.note}` : ""}
                      </span>
                    </span>
                    <span
                      className="shrink-0 font-mono tabular-nums text-sm font-bold"
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
