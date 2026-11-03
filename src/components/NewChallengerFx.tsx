// Rivalry moment (engagement audit 2026-11-03, Tier 2): the SF2 versus
// screen. Zero new realtime — CanvasserLeaderboard's existing 60s ladder
// poll already diffs ranks; when YOUR row crosses someone it hands this the
// pair. Passed them → "NEW CHALLENGER"; got passed → "K.O. INCOMING" with
// the points to retake. Pop-art kit (pop-halftone / pop-ink / pop-ko-flash)
// + RepAvatar so missing art degrades to initials, never a broken img.
// Reduced motion → a toast. Self-clears.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { RepAvatar } from "@/components/RepAvatar";
import { rewardToast } from "@/lib/reward-toast";
import { playArcadeSound, haptic } from "@/lib/arcade-fx";
import type { RepCartoon } from "@/hooks/useRepCartoons";

export type ChallengerMoment = {
  /** "up": you passed them. "down": they passed you. */
  direction: "up" | "down";
  selfName: string;
  selfCartoon?: RepCartoon;
  rivalName: string;
  rivalCartoon?: RepCartoon;
  /** Points to retake the spot (direction "down" only). */
  deficit?: number;
};

export function NewChallengerFx({
  moment,
  onDone,
}: {
  moment: ChallengerMoment;
  onDone: () => void;
}) {
  const reduced = usePrefersReducedMotion();
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  const up = moment.direction === "up";

  useEffect(() => {
    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      onDoneRef.current();
    };
    if (reduced) {
      rewardToast(
        up
          ? `🥊 NEW CHALLENGER — you passed ${moment.rivalName.split(" ")[0]}!`
          : `⚠️ K.O. INCOMING — ${moment.rivalName.split(" ")[0]} passed you`,
        { vibrate: false },
      );
      const t = setTimeout(finish, 50);
      return () => clearTimeout(t);
    }
    playArcadeSound(up ? "rank" : "boss");
    haptic(up ? [25, 40, 25] : [60, 80, 60]);
    const t = setTimeout(finish, 2400);
    return () => clearTimeout(t);
  }, [reduced, up, moment.rivalName]);

  if (reduced) return null;
  return createPortal(
    <div
      className="pointer-events-none fixed inset-0 z-[10030] grid place-items-center bg-black/55"
      aria-hidden
    >
      <div className="pop-ko-flash relative mx-4 w-full max-w-sm overflow-hidden rounded-xl pop-panel bg-kombat-black px-4 py-5">
        <span
          className="pop-halftone"
          style={
            up
              ? { ["--pop-dot" as string]: "color-mix(in oklab, var(--turf-cyan) 45%, transparent)" }
              : undefined
          }
        />
        <div className="relative flex items-center justify-between gap-2">
          <div className="flex w-[38%] flex-col items-center gap-1">
            <RepAvatar
              name={moment.selfName}
              cartoon={moment.selfCartoon}
              variant="full"
              fit="contain"
              rounded="lg"
              className="h-28 w-full"
            />
            <span className="max-w-full truncate font-display text-[9px] uppercase tracking-wider text-turf-cyan">
              {moment.selfName.split(" ")[0]}
            </span>
          </div>
          <span className="pop-ink shrink-0 font-display text-2xl text-kombat-gold">VS</span>
          <div className="flex w-[38%] flex-col items-center gap-1">
            <RepAvatar
              name={moment.rivalName}
              cartoon={moment.rivalCartoon}
              variant="full"
              fit="contain"
              rounded="lg"
              className="h-28 w-full"
            />
            <span className="max-w-full truncate font-display text-[9px] uppercase tracking-wider text-kombat-red">
              {moment.rivalName.split(" ")[0]}
            </span>
          </div>
        </div>
        <div className="relative mt-4 text-center">
          <span
            className={`pop-ink block font-display text-xl ${up ? "text-kombat-gold" : "text-kombat-red"}`}
          >
            {up ? "NEW CHALLENGER" : "K.O. INCOMING"}
          </span>
          <span className="mt-1 block font-display text-[9px] uppercase tracking-widest text-white/85">
            {up
              ? `You passed ${moment.rivalName.split(" ")[0]} on the board`
              : moment.deficit && moment.deficit > 0
                ? `${moment.rivalName.split(" ")[0]} passed you — +${moment.deficit} pts to retake`
                : `${moment.rivalName.split(" ")[0]} passed you — take it back`}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
