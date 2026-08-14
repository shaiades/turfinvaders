import { useEffect } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";

export type SwipeRoute = { to: string; search?: Record<string, string> };

/** Elements whose own horizontal gestures must win over page navigation.
 *  Swipes that START inside any of these never navigate: form fields, the
 *  Leaflet map (pans), and every intentional overflow-x-auto scroller. */
const SWIPE_BLOCKERS =
  "input, textarea, select, [data-no-swipe], .overflow-x-auto, .leaflet-container";

/**
 * Field-mode swipe navigation: swipe left/right anywhere on the page to move
 * between the bottom-bar tabs (canvassers walk fast — reaching the tab bar
 * mid-stride is friction). Deliberately dependency-free — two passive touch
 * listeners, no framer-motion/react-swipeable payload on a field phone.
 *
 * Guards: single-finger only; horizontal intent (≥64px travel and ≥2× the
 * vertical drift, so page scrolling never misfires); gestures starting inside
 * SWIPE_BLOCKERS are ignored so maps and data scrollers keep their own drag.
 */
export function useSwipeNav(routes: SwipeRoute[], enabled: boolean) {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const routeKey = routes.map((r) => r.to).join("|");

  useEffect(() => {
    if (!enabled || routes.length < 2) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;

    function onTouchStart(e: TouchEvent) {
      tracking = false;
      if (e.touches.length !== 1) return;
      const target = e.target as Element | null;
      if (target?.closest(SWIPE_BLOCKERS)) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
    }

    function onTouchEnd(e: TouchEvent) {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) < 64 || Math.abs(dx) < 2 * Math.abs(dy)) return;
      const current = routes.findIndex((r) => r.to === pathname);
      if (current < 0) return;
      const next = dx < 0 ? current + 1 : current - 1;
      if (next < 0 || next >= routes.length) return;
      const dest = routes[next];
      router.navigate({ to: dest.to, search: dest.search as never });
    }

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
    };
    // routeKey stands in for the routes array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, routeKey, pathname, router]);
}
