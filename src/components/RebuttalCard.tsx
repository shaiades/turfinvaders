// The 3-second rebuttal card (Phase 2 §2, owner 2026-10-15): the moment a
// canvasser tags an objection after "Not Interested", the matching comeback
// flashes over the map — Empathy → Clarification → Realignment, read it on the
// walk to the next door — with a "Drill this" link into the Objection Dojo.
// Copy comes from src/data/door-script.ts (rebuttalFor); no match → renders
// nothing. Mounted inside NeonMap's overlay so it rides along in fullscreen.

import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { Swords, X } from "lucide-react";
import { rebuttalFor } from "@/data/door-script";

const SHOW_MS = 3_000;

export function RebuttalCard({
  objection,
  seq,
  onDone,
}: {
  objection: string;
  /** Changes per showing so a repeat objection re-mounts the timer. */
  seq: number;
  onDone: () => void;
}) {
  const rebuttal = rebuttalFor(objection);

  useEffect(() => {
    if (!rebuttal) {
      onDone();
      return;
    }
    const t = setTimeout(onDone, SHOW_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-arm per showing
  }, [seq]);

  if (!rebuttal) return null;

  return (
    <div
      role="status"
      className="absolute inset-x-3 top-16 z-[1000] rounded-xl border border-neon/50 bg-surface p-3 shadow-[0_8px_30px_-10px_rgba(0,0,0,0.8)]"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-semibold uppercase text-neon">
          “{rebuttal.objection}” — hit back
        </div>
        <button
          type="button"
          aria-label="Dismiss rebuttal"
          onClick={onDone}
          className="-m-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-1.5 space-y-1 text-sm font-semibold leading-snug text-foreground">
        <p>{rebuttal.empathy}</p>
        <p>{rebuttal.clarification}</p>
        <p className="text-neon">{rebuttal.realignment}</p>
      </div>
      <Link
        to="/learn"
        search={{ drill: rebuttal.objection }}
        className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-neon/40 bg-neon/10 px-3 text-xs font-semibold uppercase text-neon md:min-h-0 md:py-1.5"
      >
        <Swords className="h-3.5 w-3.5" /> Drill this
      </Link>
    </div>
  );
}
