import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A badge that bumps (scales + glows) when its `count` value increases.
 * Ignores decreases and zero-holding (only visual feedback for landing pins).
 * Honors `prefers-reduced-motion` → no animation.
 */
export function BumpBadge({
  count,
  color,
  className,
}: {
  count: number;
  color: string;
  className?: string;
}) {
  const [bump, setBump] = useState(false);
  const [reduced, setReduced] = useState(
    typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );
  const prevRef = useRef(count);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    if (count > prevRef.current && !reduced) {
      prevRef.current = count;
      setBump(true);
      const id = window.setTimeout(() => setBump(false), 250);
      return () => window.clearTimeout(id);
    }
    prevRef.current = count;
  }, [count, reduced]);

  return (
    <span
      className={cn(
        "absolute -top-1 -right-1 min-w-4 rounded-full bg-surface px-1 text-center font-display text-[9px] leading-4",
        bump && !reduced && "transition-transform duration-250 scale-125",
        className,
      )}
      style={{ color }}
    >
      {count}
    </span>
  );
}
