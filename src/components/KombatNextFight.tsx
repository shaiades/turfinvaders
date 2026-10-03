// "YOUR NEXT FIGHT" (Close Kombat character-select, owner 2026-10-02): the
// rivalry made personal — YOU vs the rep one rank ahead, both as full-body
// Street Fighter cartoons, a tug-of-war bar, and the exact points to overtake.
// When you're #1 it flips to "DEFEND THE BELT" against the challenger below.

import { ArcadePanel } from "@/components/arcade";
import { RepAvatar } from "@/components/RepAvatar";
import type { RepCartoon } from "@/hooks/useRepCartoons";
import { fmtPts } from "@/lib/kombat-month";

const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;

export type Fighter = { name: string; total: number; cartoon?: RepCartoon };

export function KombatNextFight({
  matched,
  me,
  rival,
  defending,
}: {
  /** Is the viewer on the board yet? */
  matched: boolean;
  me: Fighter | null;
  /** The rep one rank ahead (chasing) or the challenger below (defending). */
  rival: Fighter | null;
  defending: boolean;
}) {
  if (!matched || !me) {
    return (
      <ArcadePanel title="Your next fight" faction="kombat" status="warn">
        <p className="text-sm text-muted-foreground">
          You're not in the ring yet — your first synced October sale drops you onto the roster and
          sets your first opponent.
        </p>
      </ArcadePanel>
    );
  }

  if (!rival) {
    return (
      <ArcadePanel title="Your next fight" faction="kombat" status="good">
        <p className="text-sm text-muted-foreground">
          👑 Top of the board with no challengers yet — keep stacking points before someone steps
          up.
        </p>
      </ArcadePanel>
    );
  }

  const gap = Math.abs(rival.total - me.total);
  // Tug-of-war: your share of the combined score (0.5 = dead even).
  const combined = me.total + rival.total;
  const yourShare = combined > 0 ? me.total / combined : 0.5;

  return (
    <ArcadePanel
      title="Your next fight"
      faction="kombat"
      status="good"
      headline={
        <span className="font-display text-[10px] uppercase tracking-widest text-kombat-red">
          {defending ? "Defend the belt" : "Challenger"}
        </span>
      }
    >
      <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-2 sm:gap-3">
        <FighterTile fighter={me} side="you" />
        <div className="flex flex-col items-center justify-center">
          <span
            className="font-display text-2xl text-kombat-red sm:text-3xl"
            style={{
              textShadow: "0 0 14px color-mix(in oklab, var(--kombat-red) 70%, transparent)",
            }}
          >
            VS
          </span>
        </div>
        <FighterTile fighter={rival} side={defending ? "challenger" : "ahead"} />
      </div>

      {/* Tug-of-war bar: gold (you) vs red (rival). */}
      <div className="mt-4">
        <div
          className="pop-panel relative h-4 w-full overflow-hidden rounded-full"
          role="img"
          aria-label={`${fmtPts(me.total)} to ${fmtPts(rival.total)}`}
        >
          <div
            className="h-full transition-[width] duration-700 ease-out"
            style={{
              width: `${Math.max(6, Math.min(94, yourShare * 100))}%`,
              background:
                "linear-gradient(90deg, color-mix(in oklab, var(--kombat-gold) 70%, transparent), var(--kombat-gold))",
              boxShadow: "0 0 14px var(--kombat-gold)",
            }}
          />
          <span className="absolute inset-y-0 left-2 flex items-center font-display text-[9px] uppercase tracking-widest text-kombat-black">
            You
          </span>
          <span className="absolute inset-y-0 right-2 flex items-center font-display text-[9px] uppercase tracking-widest text-kombat-gold">
            {firstName(rival.name)}
          </span>
        </div>
        <p className="mt-2 text-center text-sm">
          {defending ? (
            <>
              <span className="font-semibold text-kombat-gold tabular-nums">{fmtPts(gap)} pts</span>{" "}
              ahead of {firstName(rival.name)} — don't let the belt slip.
            </>
          ) : (
            <>
              <span className="font-semibold text-kombat-gold tabular-nums">{fmtPts(gap)} pts</span>{" "}
              to <span className="font-display uppercase tracking-wide">overtake</span>{" "}
              {firstName(rival.name)}.
            </>
          )}
        </p>
      </div>
    </ArcadePanel>
  );
}

function FighterTile({
  fighter,
  side,
}: {
  fighter: Fighter;
  side: "you" | "ahead" | "challenger";
}) {
  const isYou = side === "you";
  const accent = isYou ? "var(--kombat-gold)" : "var(--kombat-red)";
  return (
    <div
      className="pop-panel relative flex min-w-0 flex-col items-center rounded-lg bg-kombat-black/60 p-2"
      style={{ borderColor: accent }}
    >
      <RepAvatar
        name={fighter.name}
        cartoon={fighter.cartoon}
        variant="full"
        rounded="lg"
        className="h-28 w-full sm:h-36"
        textClassName="text-2xl"
      />
      <div
        className="mt-2 w-full truncate text-center font-display text-[10px] uppercase tracking-widest"
        style={{ color: accent }}
      >
        {isYou ? "You" : firstName(fighter.name)}
      </div>
      <div className="font-mono text-sm font-bold tabular-nums" style={{ color: accent }}>
        {fmtPts(fighter.total)}
      </div>
    </div>
  );
}
