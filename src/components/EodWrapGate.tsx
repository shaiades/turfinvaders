// Auto-plays the personal Daily Wrap cinematic once per LA day, on the first
// app open at/after 9:00 PM PT (owner spec). Mirrors the EodRecapFx contract:
// self-gating phase machine, `heldBack` sequencing (plays AFTER the morning
// intro and the team EOD recap), `onActiveChange` so the page tour waits. The
// seen-stamp is written BEFORE playback starts so an interrupted run can't
// loop. `?eod_wrap=1` force-previews from any account and never stamps. The
// Wrap tab's Replay button re-runs it any time; this is only the auto-trigger.

import { useEffect, useState } from "react";
import { WrapShow } from "@/components/WrapShow";
import { isLaToday } from "@/lib/dates";

/** `?eod_wrap=1` — force the wrap to play for previews (no stamp, any hour). */
export function isEodWrapForced(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("eod_wrap") === "1";
}

/** Current LA wall-clock hour (0–23). */
function laHour(): number {
  const h = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour12: false,
      hour: "2-digit",
    }).format(new Date()),
  );
  return h === 24 ? 0 : h;
}

const WRAP_HOUR_PT = 21; // 9 PM PT
const seenKey = (uid: string) => `ti_eod_wrap_v1:${uid}`;

export function EodWrapGate({
  userId,
  heldBack,
  onActiveChange,
}: {
  userId: string;
  heldBack?: boolean;
  onActiveChange?: (active: boolean) => void;
}) {
  const [phase, setPhase] = useState<"checking" | "playing" | "done">("checking");
  const [forced] = useState(isEodWrapForced);

  useEffect(() => {
    if (phase !== "checking" || heldBack) return;
    if (forced) {
      setPhase("playing");
      return;
    }
    if (laHour() < WRAP_HOUR_PT) {
      setPhase("done");
      return;
    }
    let seen = false;
    try {
      seen = isLaToday(localStorage.getItem(seenKey(userId)));
    } catch {
      /* private mode — treat as unseen, but we also can't stamp, so bail to
         avoid replaying on every render tonight */
      setPhase("done");
      return;
    }
    if (seen) {
      setPhase("done");
      return;
    }
    // Stamp first so a reload mid-playback doesn't re-trigger.
    try {
      localStorage.setItem(seenKey(userId), new Date().toISOString());
    } catch {
      /* unreachable: the read above already succeeded */
    }
    setPhase("playing");
  }, [phase, heldBack, forced, userId]);

  useEffect(() => {
    onActiveChange?.(phase === "playing");
    return () => onActiveChange?.(false);
  }, [phase, onActiveChange]);

  if (phase !== "playing") return null;
  return <WrapShow scope="day" onClose={() => setPhase("done")} />;
}
