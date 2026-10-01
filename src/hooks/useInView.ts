import { useEffect, useRef, useState } from "react";

/** Fire-once viewport trigger for scroll-in animations (bars filling when
 *  they enter view). Returns [ref, inView]; once true it stays true, so a
 *  bar never un-fills on scroll-away. SSR/old-browser safe: no
 *  IntersectionObserver → report in view immediately. */
export function useInView<T extends HTMLElement>(
  threshold = 0.35,
): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (inView) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          obs.disconnect();
        }
      },
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView, threshold]);
  return [ref, inView];
}
