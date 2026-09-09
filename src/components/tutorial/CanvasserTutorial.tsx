import { useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { MousePointer2, X } from "lucide-react";
import confetti from "canvas-confetti";
import { supabase } from "@/integrations/supabase/client";
import {
  HELP_STEP,
  PAGE_TOURS,
  WELCOME_STEPS,
  pageIdForPathname,
  type TourPageId,
  type TutorialStep,
} from "@/components/tutorial/tutorialSteps";

/** Fired by the header "?" button: replay the current screen's tips. */
export const TUTORIAL_START_EVENT = "ti-tutorial-start";

export function startCanvasserTutorial() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(TUTORIAL_START_EVENT));
}

// Seen-flags live in BOTH localStorage (sync, works offline) and Supabase
// auth user_metadata (cross-device, zero-migration — the requested_role
// precedent). localStorage answers first; metadata stops a page from
// re-popping on a second device. profiles deliberately untouched: it's
// payroll-adjacent and its migrations are hand-applied.
const pageKey = (uid: string, page: TourPageId) => `ti_page_tour_v1:${uid}:${page}`;
const welcomeKey = (uid: string) => `ti_tour_welcome_v1:${uid}`;

type TourMeta = {
  ti_page_tours?: Record<string, string>;
  ti_tour_welcome?: string;
};

function readLocal(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return true; // can't persist "seen" → never loop the auto-pop
  }
}

function writeLocal(key: string) {
  try {
    window.localStorage.setItem(key, new Date().toISOString());
  } catch {
    /* private mode — metadata write still covers us */
  }
}

type SpotRect = { top: number; left: number; width: number; height: number };

/** A data-tour anchor can exist twice (desktop top nav + mobile bottom bar);
 *  point at whichever candidate is actually rendered. */
function findVisibleTarget(target: string | string[] | undefined): HTMLElement | null {
  if (!target || typeof document === "undefined") return null;
  for (const id of Array.isArray(target) ? target : [target]) {
    const nodes = document.querySelectorAll<HTMLElement>(`[data-tour="${id}"]`);
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
  }
  return null;
}

function measure(el: HTMLElement, padding: number): SpotRect {
  const r = el.getBoundingClientRect();
  // Clamp to the viewport: a full-width anchor (HUD, tab bar) reads as an
  // edge-to-edge band instead of a ring hanging off both sides.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const top = Math.max(r.top - padding, 2);
  const left = Math.max(r.left - padding, 2);
  return {
    top,
    left,
    width: Math.min(r.right + padding, vw - 2) - left,
    height: Math.min(r.bottom + padding, vh - 2) - top,
  };
}

function rectsDiffer(a: SpotRect | null, b: SpotRect): boolean {
  if (!a) return true;
  return (
    Math.abs(a.top - b.top) > 1 ||
    Math.abs(a.left - b.left) > 1 ||
    Math.abs(a.width - b.width) > 1 ||
    Math.abs(a.height - b.height) > 1
  );
}

/** Wordmark palette for the first-tour finale (canvas-confetti wants hex). */
const CONFETTI_COLORS = ["#ff4fd8", "#4fa3ff", "#54f06a", "#ffa438", "#ffe95e"];

export function CanvasserTutorial({ userId }: { userId: string }) {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<TutorialStep[]>([]);
  const [tourPage, setTourPage] = useState<TourPageId | null>(null);
  const [withWelcome, setWithWelcome] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<SpotRect | null>(null);
  // settled = target found + measured; gates the cursor/card fade-in so they
  // never point at a half-loaded page.
  const [settled, setSettled] = useState(false);

  const runRef = useRef(0); // cancels stale step activations on fast taps
  const openRef = useRef(false);
  openRef.current = open;
  const stepIndexRef = useRef(0);
  stepIndexRef.current = stepIndex;
  // Auth user_metadata, fetched once per mount and kept current on writes.
  const metaRef = useRef<TourMeta | null>(null);

  const step: TutorialStep | undefined = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;

  const fetchTourMeta = useCallback(async (): Promise<TourMeta> => {
    if (metaRef.current) return metaRef.current;
    try {
      const { data } = await supabase.auth.getUser();
      metaRef.current = (data.user?.user_metadata ?? {}) as TourMeta;
    } catch {
      metaRef.current = {};
    }
    return metaRef.current;
  }, []);

  const persistSeen = useCallback(
    (page: TourPageId, includeWelcome: boolean) => {
      const now = new Date().toISOString();
      writeLocal(pageKey(userId, page));
      if (includeWelcome) writeLocal(welcomeKey(userId));
      const cur = metaRef.current ?? {};
      // "?" replays of an already-recorded page shouldn't re-hit the network.
      if (cur.ti_page_tours?.[page] && (!includeWelcome || cur.ti_tour_welcome)) return;
      const patch: TourMeta = {
        ti_page_tours: { ...(cur.ti_page_tours ?? {}), [page]: now },
        ...(includeWelcome ? { ti_tour_welcome: now } : {}),
      };
      metaRef.current = { ...cur, ...patch };
      // Fire-and-forget: localStorage already has it; metadata is the
      // cross-device backstop.
      supabase.auth.updateUser({ data: patch }).catch(() => {});
    },
    [userId],
  );

  const close = useCallback(
    (reason: "finished" | "skipped" | "aborted") => {
      runRef.current++;
      setOpen(false);
      if (reason === "aborted" || !tourPage) return;
      // Finish and skip both count as seen — never nag. The "?" replays.
      persistSeen(tourPage, withWelcome);
      if (reason === "finished" && withWelcome) {
        confetti({
          particleCount: 150,
          spread: 75,
          startVelocity: 42,
          origin: { y: 0.7 },
          colors: CONFETTI_COLORS,
          zIndex: 10500,
          disableForReducedMotion: true,
        });
      }
    },
    [tourPage, withWelcome, persistSeen],
  );

  /** Point at the step's anchor: switch Mission tab if the step asks,
   *  wait for the anchor, scroll it into view, measure. */
  const activateStep = useCallback(
    (index: number, stepList: TutorialStep[]) => {
      const s = stepList[index];
      if (!s) return;
      const run = ++runRef.current;
      setSettled(false);

      if (s.route) {
        const here = router.state.location;
        const wantTab = s.search?.tab;
        const hereTab = (here.search as { tab?: string } | undefined)?.tab;
        if (here.pathname !== s.route || (wantTab && hereTab !== wantTab)) {
          router.navigate({ to: s.route, search: s.search as never, replace: true });
        }
      }

      if (!s.target) {
        setRect(null);
        setSettled(true);
        return;
      }

      const startedAt = Date.now();
      const poll = () => {
        if (run !== runRef.current || !openRef.current) return;
        const el = findVisibleTarget(s.target);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.top < 0 || r.bottom > window.innerHeight) {
            el.scrollIntoView({ block: "center", behavior: "smooth" });
          }
          // Measure once the anchor stops moving (2 quiet ticks) — a fixed
          // delay under-waits long smooth scrolls and mis-pins the ring.
          // setTimeout, not rAF: rAF stalls in a backgrounded tab and would
          // freeze the step half-activated.
          let lastTop: number | null = null;
          let quiet = 0;
          const settleTick = () => {
            if (run !== runRef.current || !openRef.current) return;
            const now = el.getBoundingClientRect().top;
            quiet = lastTop !== null && Math.abs(now - lastTop) < 0.5 ? quiet + 1 : 0;
            lastTop = now;
            if (quiet >= 2 || Date.now() - startedAt > 3000) {
              setRect(measure(el, s.padding ?? 8));
              setSettled(true);
            } else {
              window.setTimeout(settleTick, 50);
            }
          };
          window.setTimeout(settleTick, 50);
          return;
        }
        if (Date.now() - startedAt > 4000) {
          // Anchor never appeared (slow query, layout change) — degrade to a
          // centered card instead of hanging.
          setRect(null);
          setSettled(true);
          return;
        }
        window.setTimeout(poll, 120);
      };
      poll();
    },
    [router],
  );

  const begin = useCallback(
    (page: TourPageId, opts: { welcome: boolean }) => {
      const base = PAGE_TOURS[page];
      const full = opts.welcome ? [...WELCOME_STEPS, ...base, HELP_STEP] : base;
      // Anchors for the current page are all mounted (or legitimately absent)
      // by now — drop `optional` steps whose anchor isn't on screen, e.g. the
      // pin picker hiding behind the Gratitude Gate.
      const visible = full.filter((s) => !s.optional || findVisibleTarget(s.target));
      if (visible.length === 0) return;
      setSteps(visible);
      setTourPage(page);
      setWithWelcome(opts.welcome);
      setStepIndex(0);
      setRect(null);
      setSettled(false);
      setOpen(true);
      window.setTimeout(() => activateStep(0, visible), 30);
    },
    [activateStep],
  );

  const goTo = useCallback(
    (index: number) => {
      if (index < 0) return;
      if (index >= steps.length) {
        close("finished");
        return;
      }
      setStepIndex(index);
      activateStep(index, steps);
    },
    [steps, activateStep, close],
  );

  // ---- triggers -----------------------------------------------------------

  // Discovery auto-pop: first time this account opens this screen. localStorage
  // answers synchronously; auth metadata catches "seen it on another phone".
  useEffect(() => {
    const page = pageIdForPathname(pathname);
    if (!page) return;
    if (readLocal(pageKey(userId, page))) return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      if (cancelled || openRef.current) return;
      const meta = await fetchTourMeta();
      if (cancelled || openRef.current) return;
      if (meta.ti_page_tours?.[page]) {
        writeLocal(pageKey(userId, page)); // sync the device, skip the pop
        return;
      }
      const welcome = !readLocal(welcomeKey(userId)) && !meta.ti_tour_welcome;
      begin(page, { welcome });
    }, 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [pathname, userId, fetchTourMeta, begin]);

  // Manual replay via the header "?" — current screen's tips only.
  useEffect(() => {
    const onStart = () => {
      const page = pageIdForPathname(pathname);
      if (page) begin(page, { welcome: false });
    };
    window.addEventListener(TUTORIAL_START_EVENT, onStart);
    return () => window.removeEventListener(TUTORIAL_START_EVENT, onStart);
  }, [pathname, begin]);

  // Safety: if the route changes under an open tour (redirects — user input
  // is blocked), fold quietly without marking anything seen.
  useEffect(() => {
    if (!open || !tourPage) return;
    if (pageIdForPathname(pathname) !== tourPage) close("aborted");
  }, [open, tourPage, pathname, close]);

  // ---- keep the spotlight glued -------------------------------------------

  // Async data loads shift layout after we measure; a cheap re-measure loop
  // keeps the ring on the anchor without observers on every page.
  useEffect(() => {
    if (!open || !settled || !step?.target) return;
    const id = window.setInterval(() => {
      const el = findVisibleTarget(step.target);
      if (!el) return;
      const next = measure(el, step.padding ?? 8);
      setRect((prev) => (rectsDiffer(prev, next) ? next : prev));
    }, 350);
    return () => window.clearInterval(id);
  }, [open, settled, step]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => activateStep(stepIndexRef.current, steps);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, steps, activateStep]);

  // Keyboard: → / Enter next, ← back, Esc skip.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "Enter") goTo(stepIndexRef.current + 1);
      else if (e.key === "ArrowLeft") goTo(stepIndexRef.current - 1);
      else if (e.key === "Escape") close("skipped");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, goTo, close]);

  if (!open || !step) return null;

  // ---- layout math --------------------------------------------------------

  const vw = typeof window !== "undefined" ? window.innerWidth : 390;
  const vh = typeof window !== "undefined" ? window.innerHeight : 780;

  // Card pins near the bottom unless the anchor lives in the lower part of
  // the screen (e.g. the bottom tab bar), then it flips top. Welcome/finale
  // (no anchor) floats dead center.
  const centerCard = !rect;
  const cardOnTop = !!rect && rect.top + rect.height / 2 > vh * 0.55;

  const at = step.cursorAt ?? { x: 0.5, y: 0.5 };
  const tipX = rect ? Math.min(Math.max(rect.left + rect.width * at.x, 20), vw - 20) : vw / 2;
  const tipY = rect ? Math.min(Math.max(rect.top + rect.height * at.y, 20), vh - 20) : vh / 2;

  return (
    // z-[10010]: over the bottom nav (30), Leaflet panes (1000) and sheets
    // (9999/10001) — the map page must dim like everything else.
    <div
      className="fixed inset-0 z-[10010]"
      style={{ touchAction: "none" }}
      data-no-swipe
      role="dialog"
      aria-modal="true"
      aria-label="Screen tips"
    >
      {/* click-catcher: tap anywhere outside the card to advance */}
      <div className="absolute inset-0" onClick={() => goTo(stepIndex + 1)} />

      {/* spotlight — the giant box-shadow dims everything but the anchor */}
      <div
        className="ti-tour-spot"
        style={
          rect
            ? {
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height,
                borderColor: "color-mix(in oklab, var(--neon) 85%, white)",
              }
            : {
                top: vh / 2,
                left: vw / 2,
                width: 0,
                height: 0,
                borderColor: "transparent",
              }
        }
      />

      {/* the guiding cursor — stays visible while gliding between anchors
          (every tour is single-page, so the old position is never junk) */}
      <div
        className="ti-tour-cursor"
        style={{ left: tipX, top: tipY, opacity: rect ? 1 : 0 }}
        aria-hidden
      >
        <span className="ti-tour-cursor-ring" />
        <MousePointer2 className="ti-tour-cursor-icon" strokeWidth={1.5} />
      </div>

      {/* step card */}
      <div
        key={stepIndex}
        className={`ti-tour-card fixed left-3 right-3 mx-auto max-w-md rounded-xl border bg-[var(--surface)] shadow-arcade ${
          centerCard
            ? "top-1/2 -translate-y-1/2"
            : cardOnTop
              ? "ti-tour-card-top"
              : "ti-tour-card-bottom"
        }`}
        style={{ opacity: settled ? 1 : 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="text-[9px] font-display uppercase tracking-widest text-muted-foreground pt-0.5">
              {stepIndex + 1} / {steps.length}
            </div>
            <button
              onClick={() => close("skipped")}
              className="min-w-9 min-h-9 -mt-1.5 -mr-1.5 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-surface-elevated"
              aria-label="Skip tips"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {step.showWordmark && (
            <img
              src="/turf-invaders-wordmark.png"
              alt="Turf Invaders"
              className="h-12 w-auto object-contain mx-auto mb-3 drop-shadow-[0_0_14px_color-mix(in_oklab,var(--neon)_55%,transparent)]"
            />
          )}

          <h2 className="font-display text-[13px] leading-relaxed text-[var(--neon)] mb-2">
            {step.title}
          </h2>
          <p className="text-sm leading-relaxed text-foreground/90">{step.body}</p>
        </div>

        {/* progress dots */}
        {steps.length > 1 && (
          <div className="flex items-center justify-center gap-1.5 px-4 pb-3">
            {steps.map((s, i) => (
              <span
                key={s.id}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === stepIndex ? "w-4 bg-[var(--neon)]" : "w-1.5 bg-border"
                }`}
              />
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 px-4 pb-4">
          {stepIndex > 0 && (
            <button
              onClick={() => goTo(stepIndex - 1)}
              className="min-h-11 px-4 rounded-md border border-border text-xs font-display uppercase tracking-wider text-muted-foreground hover:text-foreground hover:bg-surface-elevated"
            >
              Back
            </button>
          )}
          {stepIndex === 0 && steps.length > 1 && (
            <button
              onClick={() => close("skipped")}
              className="min-h-11 px-4 rounded-md border border-border text-xs font-display uppercase tracking-wider text-muted-foreground hover:text-foreground hover:bg-surface-elevated"
            >
              Skip
            </button>
          )}
          <button
            onClick={() => goTo(stepIndex + 1)}
            className="flex-1 min-h-11 px-4 rounded-md bg-[var(--neon)] text-[var(--neon-foreground)] text-xs font-display uppercase tracking-wider shadow-neon-pink hover:brightness-110"
          >
            {withWelcome && stepIndex === 0
              ? "Start Tour"
              : isLast
                ? withWelcome
                  ? "Let's Go!"
                  : "Done"
                : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
