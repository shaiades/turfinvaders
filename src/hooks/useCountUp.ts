import { useEffect, useRef, useState } from "react";

/** Eased count-up toward `value` with a 320ms increase-only `bump` flag —
 *  LiveLeadCounter's tick generalized to one text run (extracted from
 *  PiggyBankHUD so the Close Kombat hero can tween money too). Pass
 *  `instant` (e.g. prefers-reduced-motion) to snap without animating. */
export function useCountUp(value: number, instant = false) {
  const [display, setDisplay] = useState(value);
  const [bump, setBump] = useState(false);
  const prevRef = useRef(value);
  useEffect(() => {
    const from = prevRef.current;
    const to = value;
    if (from === to) return;
    prevRef.current = to;
    if (instant) {
      setDisplay(to);
      return;
    }
    const start = performance.now();
    const duration = Math.min(800, 120 + Math.abs(to - from) * 18);
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    if (to > from) {
      setBump(true);
      const id = window.setTimeout(() => setBump(false), 320);
      return () => {
        cancelAnimationFrame(raf);
        window.clearTimeout(id);
      };
    }
    return () => cancelAnimationFrame(raf);
  }, [value, instant]);
  return { display, bump };
}
