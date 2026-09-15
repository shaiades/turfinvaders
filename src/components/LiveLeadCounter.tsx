import { cn } from "@/lib/utils";
import { useCountUp } from "@/hooks/useCountUp";

type Size = "sm" | "md" | "lg";

const SIZES: Record<Size, { digit: string; label: string; pad: number; gap: string; dot: string }> = {
  sm: { digit: "text-base px-1.5 py-1 min-w-[1ch]", label: "text-[8px]",  pad: 3, gap: "gap-0.5", dot: "w-1 h-1" },
  md: { digit: "text-2xl px-2 py-1.5",              label: "text-[9px]",  pad: 4, gap: "gap-1",   dot: "w-1.5 h-1.5" },
  lg: { digit: "text-5xl px-3 py-2",                label: "text-[10px]", pad: 6, gap: "gap-1.5", dot: "w-2 h-2" },
};

/**
 * Arcade-style digital score ticker for the "Live Lead Counter".
 * Animates from previous value to new value when `value` changes.
 */
export function LiveLeadCounter({
  value,
  label = "LEADS · TODAY",
  size = "md",
  className,
  accent = "neon",
}: {
  value: number;
  label?: string;
  size?: Size;
  className?: string;
  accent?: "neon" | "victory" | "warning";
}) {
  const cfg = SIZES[size];
  // Tick up/down with quick ease + increase-only bump (shared hook).
  const { display, bump } = useCountUp(value);

  const padded = String(Math.max(0, Math.floor(display))).padStart(cfg.pad, "0");
  const accentColor =
    accent === "victory" ? "text-victory" : accent === "warning" ? "text-[var(--warning)]" : "text-neon";
  const glowColor =
    accent === "victory" ? "var(--victory)" : accent === "warning" ? "var(--warning)" : "var(--neon)";

  return (
    <div
      className={cn(
        "inline-flex flex-col items-start rounded-md border border-border bg-[color-mix(in_oklab,black_55%,var(--surface))] px-2.5 py-2",
        className,
      )}
      aria-label={`${label}: ${Math.floor(display)}`}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "rounded-full bg-current",
            cfg.dot,
            accentColor,
            "shadow-[0_0_8px_currentColor] animate-pulse",
          )}
          aria-hidden
        />
        <span className={cn("font-display uppercase tracking-[0.18em] text-muted-foreground", cfg.label)}>
          {label}
        </span>
      </div>
      <div className={cn("mt-1.5 flex", cfg.gap)}>
        {padded.split("").map((d, i) => (
          <span
            key={i}
            className={cn(
              "inline-grid place-items-center rounded font-display tabular-nums leading-none",
              "border border-border/60 bg-black/40",
              cfg.digit,
              accentColor,
              bump && "transition-transform duration-200 scale-105",
            )}
            style={{ textShadow: `0 0 10px ${glowColor}` }}
          >
            {d}
          </span>
        ))}
      </div>
    </div>
  );
}
