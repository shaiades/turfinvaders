import { useCallback, useEffect, useRef, useState } from "react";

/** Fire-once viewport trigger for scroll-in animations (bars filling when
 *  they enter view). Returns [callbackRef, inView]; once true it stays
 *  true, so a bar never un-fills on scroll-away.
 *
 *  A CALLBACK ref on purpose: these targets mount late (skeleton → real
 *  content), and an effect that read ref.current at first mount would run
 *  while the element doesn't exist yet and never re-attach — the observer
 *  must chase the element, not the mount (God Mode bar-fill bug, v2).
 *  SSR/old-browser safe: no IntersectionObserver → in view immediately. */
export function useInView<T extends HTMLElement>(
  threshold = 0.25,
): [(el: T | null) => void, boolean] {
  const [inView, setInView] = useState(false);
  const doneRef = useRef(false);
  const obsRef = useRef<IntersectionObserver | null>(null);

  const ref = useCallback(
    (el: T | null) => {
      obsRef.current?.disconnect();
      obsRef.current = null;
      if (doneRef.current || el === null) return;
      if (typeof IntersectionObserver === "undefined") {
        doneRef.current = true;
        setInView(true);
        return;
      }
      const obs = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            doneRef.current = true;
            setInView(true);
            obs.disconnect();
            if (obsRef.current === obs) obsRef.current = null;
          }
        },
        { threshold },
      );
      obs.observe(el);
      obsRef.current = obs;
    },
    [threshold],
  );

  useEffect(() => () => obsRef.current?.disconnect(), []);

  return [ref, inView];
}
