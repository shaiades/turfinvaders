// A light XP / level + badge strip for the canvasser's profile — the
// progression layer, kept to one compact panel so the leaderboard stays the
// hero. Reads useWrapData (monthly) so the level, XP and badges match exactly
// what the Daily Wrap shows. Cosmetic only; XP never touches pay.

import { ArcadePanel, ArcadeSkeleton } from "@/components/arcade";
import { useWrapData } from "@/hooks/useWrapData";

export function CanvasserProgress() {
  const d = useWrapData("month");

  if (d.loading) {
    return (
      <ArcadePanel title="Your Fighter">
        <ArcadeSkeleton className="h-24 w-full" />
      </ArcadePanel>
    );
  }

  const earned = d.badges.filter((b) => b.unlocked).length;

  return (
    <ArcadePanel
      title="Your Fighter"
      action={
        <span className="font-display text-[10px] uppercase tracking-widest text-[var(--kombat-gold)]">
          Lvl {d.level.level}
        </span>
      }
    >
      <div className="space-y-3">
        {/* Level + XP bar */}
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-display text-xs uppercase tracking-widest text-neon">
              {d.level.title}
            </span>
            <span className="font-display text-[10px] uppercase tracking-widest text-muted-foreground tabular-nums">
              {d.level.intoLevel}/{d.level.levelSpan} XP
            </span>
          </div>
          <div className="mt-2 h-3 w-full overflow-hidden rounded-full border border-border bg-foreground/5">
            <div
              className="h-full rounded-full bg-neon transition-[width] duration-700 ease-out"
              style={{ width: `${d.level.pct * 100}%`, boxShadow: "0 0 12px var(--neon)" }}
            />
          </div>
        </div>

        {/* Badge strip */}
        <div>
          <p className="mb-1.5 font-display text-[9px] uppercase tracking-widest text-muted-foreground">
            Badges · {earned}/{d.badges.length}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {d.badges.map((b) => (
              <span
                key={b.def.id}
                title={`${b.def.label} — ${b.def.blurb}`}
                className={`flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] ${
                  b.unlocked
                    ? "border-[var(--kombat-gold)]/60 text-foreground"
                    : "border-border text-muted-foreground/40"
                }`}
              >
                <span aria-hidden className={b.unlocked ? "" : "opacity-40 grayscale"}>
                  {b.def.icon}
                </span>
                {b.def.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </ArcadePanel>
  );
}
