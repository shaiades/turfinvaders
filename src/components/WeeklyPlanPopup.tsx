// Weekly Action Plan popup (owner directive 2026-10-01): the first Close
// Kombat-tier login of each plan week (Sunday included — Sunday shows the
// UPCOMING week) gets a summary card with a one-tap jump to the Plan tab.
// Clones the PurposeReminderCard stamp protocol: localStorage week-key
// compared with === (the EodRecap period style), auth user_metadata as the
// cross-device backstop (1.2s race), stamp at display START, `?plan_pop=1`
// previews without stamping. EodRecap's visibilitychange re-arm covers
// installed PWAs that resume across the week boundary. Reports active while
// UNSETTLED (phase !== done, with the 8s watchdog) so AppShell can hold the
// purpose reminder and the page tour behind it without a stacking race.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { CalendarDays, Swords } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useWeeklyPlan, planClock } from "@/hooks/useWeeklyPlan";
import { NeonButton } from "@/components/arcade";

const seenKey = (uid: string) => `ti_ck_plan_week_v1:${uid}`;

type PlanMeta = { ti_ck_plan_week?: string };

export function isWeeklyPlanPopupForced(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("plan_pop") === "1";
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

export function WeeklyPlanPopup({
  userId,
  heldBack,
  onActiveChange,
}: {
  userId: string;
  heldBack?: boolean;
  onActiveChange?: (active: boolean) => void;
}) {
  const forced = isWeeklyPlanPopupForced();
  const { displayName } = useAuth();
  const router = useRouter();
  const weekKey = planClock().planWeekStart;
  const [phase, setPhase] = useState<"checking" | "ready" | "showing" | "done">(() => {
    if (typeof window === "undefined") return "done";
    if (forced) return "ready";
    return readLocalSeen(seenKey(userId), weekKey) ? "done" : "checking";
  });
  const stampedRef = useRef(false);
  const doneRef = useRef(phase === "done");
  doneRef.current = phase === "done";
  // Weeks this mount already settled (shown, empty, error or watchdog):
  // the visibilitychange re-arm must not re-cycle them — each cycle flips
  // onActiveChange and would unmount an open page tour (review 2026-10-01).
  const settledWeeksRef = useRef<Set<string>>(new Set(phase === "done" ? [weekKey] : []));

  // Plan data warms while the intro plays; only fetch while unsettled.
  const { status, plan, isSundayPreview } = useWeeklyPlan(displayName, phase !== "done");

  // Active while UNSETTLED (intro/EOD contract): the purpose reminder and
  // the page tour wait until this card either shows or bows out.
  useEffect(() => {
    onActiveChange?.(phase !== "done");
    return () => onActiveChange?.(false);
  }, [phase, onActiveChange]);

  // Cross-device backstop: a stamp for THIS plan week on any device suppresses.
  useEffect(() => {
    if (phase !== "checking") return;
    let cancelled = false;
    (async () => {
      const meta = await Promise.race([
        supabase.auth
          .getSession()
          .then(({ data }) => (data.session?.user?.user_metadata ?? {}) as PlanMeta),
        new Promise<PlanMeta>((resolve) => window.setTimeout(() => resolve({}), 1200)),
      ]).catch(() => ({}) as PlanMeta);
      if (cancelled) return;
      if (meta.ti_ck_plan_week === weekKey) {
        writeLocal(seenKey(userId), weekKey);
        setPhase("done");
      } else {
        setPhase("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, userId, weekKey]);

  // Eligibility: the plan must be real and non-empty. An ERROR bows out
  // without stamping (the next open retries); a genuinely EMPTY week stamps
  // and settles — a rep with no jobs must not re-race the metadata check on
  // every foreground (the EodRecap settled-skip doctrine).
  useEffect(() => {
    if (phase !== "ready" || heldBack) return;
    if (!forced) {
      if (status === "error") {
        settledWeeksRef.current.add(weekKey);
        setPhase("done");
        return;
      }
      if (status === "loading") return;
      if (!plan || plan.jobs.length === 0) {
        settledWeeksRef.current.add(weekKey);
        writeLocal(seenKey(userId), weekKey);
        const patch: PlanMeta = { ti_ck_plan_week: weekKey };
        supabase.auth.updateUser({ data: patch }).catch(() => {});
        setPhase("done");
        return;
      }
    }
    if (!stampedRef.current) {
      stampedRef.current = true;
      settledWeeksRef.current.add(weekKey);
      if (!forced) {
        writeLocal(seenKey(userId), weekKey);
        const patch: PlanMeta = { ti_ck_plan_week: weekKey };
        supabase.auth.updateUser({ data: patch }).catch(() => {});
      }
    }
    setPhase("showing");
  }, [phase, heldBack, forced, status, plan, userId, weekKey]);

  // Watchdog: a hung fetch must not hold the overlay chain hostage. Armed
  // only while unsettled and unheld; no stamp — the next open retries.
  useEffect(() => {
    if (phase === "done" || phase === "showing" || heldBack) return;
    const wd = window.setTimeout(() => {
      settledWeeksRef.current.add(weekKey);
      setPhase("done");
    }, 8000);
    return () => window.clearTimeout(wd);
  }, [phase, heldBack, weekKey]);

  // Re-arm on foreground: installed-PWA opens resume the SPA instead of
  // reloading, so a settled "done" re-checks when the plan week has rolled
  // past the stamp (Sunday evening → Monday morning).
  useEffect(() => {
    if (forced) return;
    const recheck = () => {
      if (document.visibilityState !== "visible") return;
      if (!doneRef.current) return; // mid-cycle — leave the machine alone
      const wk = planClock().planWeekStart;
      if (settledWeeksRef.current.has(wk)) return; // this week already settled
      if (readLocalSeen(seenKey(userId), wk)) return;
      stampedRef.current = false;
      setPhase("checking");
    };
    document.addEventListener("visibilitychange", recheck);
    return () => document.removeEventListener("visibilitychange", recheck);
  }, [forced, userId]);

  const dismiss = useCallback(() => setPhase("done"), []);
  const openPlan = useCallback(() => {
    setPhase("done");
    router.navigate({ to: "/close-kombat", search: { tab: "plan" } as never });
  }, [router]);

  if (phase !== "showing") return null;

  const jobs = plan?.jobs.length ?? 0;
  const pinned = plan?.pinned.length ?? 0;
  const route = plan?.route[0] ?? null;

  return (
    <div
      className="fixed inset-0 z-[9997] flex items-center justify-center overflow-y-auto bg-background/95 px-5 py-10 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500"
      role="dialog"
      aria-label="Weekly Action Plan"
    >
      <div className="w-full max-w-md text-center">
        <Swords className="mx-auto size-7 text-kombat-red" aria-hidden />
        <p className="mt-3 font-display text-xs uppercase tracking-widest text-kombat-gold">
          Weekly Action Plan
        </p>
        <p className="mt-5 text-2xl leading-snug font-display uppercase tracking-wider">
          {jobs} job{jobs === 1 ? "" : "s"} in progress
          {isSundayPreview ? " next week" : " this week"}
        </p>
        <div className="mt-4 space-y-1.5 text-sm text-muted-foreground">
          {pinned > 0 && (
            <p>
              <span className="text-kombat-gold">{pinned}</span> marked{" "}
              <span className="text-foreground">Do first</span>
            </p>
          )}
          {route && (
            <p>
              <CalendarDays className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />
              {isSundayPreview ? "Monday's" : "Today's"} route: {route.label} ·{" "}
              {route.jobIds.length} job{route.jobIds.length === 1 ? "" : "s"}
            </p>
          )}
          <p>Visit every job this week — referrals, reloads, photos, reviews.</p>
        </div>
        <div className="mt-8 flex flex-col items-center gap-3">
          <NeonButton tone="kombat-gold" onClick={openPlan} className="min-w-44">
            Open my plan
          </NeonButton>
          <button
            type="button"
            onClick={dismiss}
            className="min-h-11 md:min-h-0 inline-flex items-center px-4 text-sm text-muted-foreground hover:text-foreground"
          >
            Got it — later
          </button>
        </div>
      </div>
    </div>
  );
}
