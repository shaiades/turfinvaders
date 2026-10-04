// Respawn reminder (owner directive 2026-10-03): from Friday 6 PM through
// Sunday 12 PM PT, any sales rep with no shift-off request on file for the
// COMING week gets a one-time nudge — "Request days off" or "I'm working every
// shift", and either answer settles it. Clones the WeeklyPlanPopup stamp
// protocol exactly: localStorage week-key compared with ===, auth
// user_metadata as the cross-device backstop (1.2s race), stamp at display
// START, `?respawn_pop=1` previews without stamping, and visibilitychange
// re-arm for installed PWAs. Reports active while UNSETTLED so AppShell can
// hold the page tour behind it. Outside the Fri–Sun window it settles silently
// WITHOUT stamping, so it can still appear once the window opens.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { CalendarOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { NeonButton } from "@/components/arcade";
import { comingWeekStartISO, inReminderWindow } from "@/lib/respawn";

const seenKey = (uid: string) => `ti_ck_respawn_week_v1:${uid}`;

type RespawnMeta = { ti_ck_respawn_week?: string };

export function isRespawnPopupForced(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("respawn_pop") === "1";
}

function readLocalSeen(key: string, weekKey: string): boolean {
  try {
    return window.localStorage.getItem(key) === weekKey;
  } catch {
    return true; // can't persist "seen" → never loop the card
  }
}

function writeLocal(key: string, weekKey: string) {
  try {
    window.localStorage.setItem(key, weekKey);
  } catch {
    /* private mode — the metadata write still covers us */
  }
}

export function RespawnPopup({
  userId,
  heldBack,
  onActiveChange,
}: {
  userId: string;
  heldBack?: boolean;
  onActiveChange?: (active: boolean) => void;
}) {
  const forced = isRespawnPopupForced();
  const router = useRouter();
  const weekKey = comingWeekStartISO();
  const [phase, setPhase] = useState<"checking" | "ready" | "showing" | "done">(() => {
    if (typeof window === "undefined") return "done";
    if (forced) return "ready";
    return readLocalSeen(seenKey(userId), weekKey) ? "done" : "checking";
  });
  const stampedRef = useRef(false);
  const doneRef = useRef(phase === "done");
  doneRef.current = phase === "done";
  const settledWeeksRef = useRef<Set<string>>(new Set(phase === "done" ? [weekKey] : []));

  // Active while UNSETTLED so the page tour waits until this bows out.
  useEffect(() => {
    onActiveChange?.(phase !== "done");
    return () => onActiveChange?.(false);
  }, [phase, onActiveChange]);

  // Cross-device backstop + "already requested this week?" check.
  useEffect(() => {
    if (phase !== "checking") return;
    let cancelled = false;
    (async () => {
      const meta = await Promise.race([
        supabase.auth
          .getSession()
          .then(({ data }) => (data.session?.user?.user_metadata ?? {}) as RespawnMeta),
        new Promise<RespawnMeta>((resolve) => window.setTimeout(() => resolve({}), 1200)),
      ]).catch(() => ({}) as RespawnMeta);
      if (cancelled) return;
      if (meta.ti_ck_respawn_week === weekKey) {
        writeLocal(seenKey(userId), weekKey);
        setPhase("done");
        return;
      }
      // A request already on file for the coming week settles it too.
      const { data } = await supabase
        .from("respawn_requests")
        .select("id")
        .eq("user_id", userId)
        .eq("week_start", weekKey)
        .maybeSingle();
      if (cancelled) return;
      if (data) {
        writeLocal(seenKey(userId), weekKey);
        supabase.auth
          .updateUser({ data: { ti_ck_respawn_week: weekKey } as RespawnMeta })
          .catch(() => {});
        setPhase("done");
        return;
      }
      setPhase("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, userId, weekKey]);

  // Gate on the Fri 6 PM → Sun 12 PM window. Outside it, settle silently with
  // NO stamp (so the window can still open it later); inside it, stamp at show
  // start and display.
  useEffect(() => {
    if (phase !== "ready" || heldBack) return;
    if (!forced && !inReminderWindow()) {
      setPhase("done"); // not stamped, not added to settledWeeks → re-checkable
      return;
    }
    if (!stampedRef.current) {
      stampedRef.current = true;
      settledWeeksRef.current.add(weekKey);
      if (!forced) {
        writeLocal(seenKey(userId), weekKey);
        supabase.auth
          .updateUser({ data: { ti_ck_respawn_week: weekKey } as RespawnMeta })
          .catch(() => {});
      }
    }
    setPhase("showing");
  }, [phase, heldBack, forced, userId, weekKey]);

  // Watchdog: a hung session read must not hold the overlay chain.
  useEffect(() => {
    if (phase === "done" || phase === "showing" || heldBack) return;
    const wd = window.setTimeout(() => setPhase("done"), 8000);
    return () => window.clearTimeout(wd);
  }, [phase, heldBack]);

  // Re-arm on foreground (installed PWAs resume the SPA): re-check when the
  // week has rolled or the window just opened.
  useEffect(() => {
    if (forced) return;
    const recheck = () => {
      if (document.visibilityState !== "visible") return;
      if (!doneRef.current) return;
      const wk = comingWeekStartISO();
      if (readLocalSeen(seenKey(userId), wk)) return;
      stampedRef.current = false;
      setPhase("checking");
    };
    document.addEventListener("visibilitychange", recheck);
    return () => document.removeEventListener("visibilitychange", recheck);
  }, [forced, userId]);

  const dismiss = useCallback(() => setPhase("done"), []);
  const openRespawn = useCallback(() => {
    setPhase("done");
    router.navigate({ to: "/close-kombat", search: { tab: "respawn" } as never });
  }, [router]);

  if (phase !== "showing") return null;

  return (
    <div
      className="fixed inset-0 z-[9996] flex items-center justify-center overflow-y-auto bg-background/95 px-5 py-10 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500"
      role="dialog"
      aria-label="Shifts off for next week"
    >
      <div className="w-full max-w-md text-center">
        <CalendarOff className="mx-auto size-7 text-kombat-gold" aria-hidden />
        <p className="mt-3 font-display text-xs uppercase tracking-widest text-kombat-gold">
          Next week's shifts
        </p>
        <p className="mt-5 text-2xl leading-snug font-display uppercase tracking-wider">
          Need any shifts off next week?
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          Requests for next week are due <span className="text-foreground">Sunday 12 PM</span>. Lock
          it in now so the lineup is right.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3">
          <NeonButton tone="kombat-gold" onClick={openRespawn} className="min-w-44">
            Request days off
          </NeonButton>
          <button
            type="button"
            onClick={dismiss}
            className="min-h-11 md:min-h-0 inline-flex items-center px-4 text-sm text-muted-foreground hover:text-foreground"
          >
            I'm working every shift
          </button>
        </div>
      </div>
    </div>
  );
}
