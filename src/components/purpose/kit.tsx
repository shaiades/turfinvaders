// My Purpose — the quiet kit. Deliberately NOT ArcadeCard/NeonButton: the
// workshop's register is calm and premium (spec §7). These primitives assume
// they render inside a `.purpose-surface` scope (tokens defined in
// styles.css) and stay small on purpose — restraint is the design.

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PurposeCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("purpose-card p-6 md:p-8", className)}>{children}</div>;
}

type ButtonTone = "primary" | "ghost" | "quiet";

export function PurposeButton({
  tone = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone }) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex min-h-11 items-center justify-center rounded-xl px-5 text-base font-medium",
        "transition-colors disabled:opacity-40 disabled:pointer-events-none select-none",
        tone === "primary" &&
          "bg-[var(--purpose-tide)] text-[var(--purpose-navy-deep)] hover:brightness-110 font-semibold",
        tone === "ghost" &&
          "border border-[var(--purpose-line)] text-[var(--purpose-ink)] hover:bg-[color-mix(in_oklab,var(--purpose-tide)_10%,transparent)]",
        tone === "quiet" && "text-[var(--purpose-ink-dim)] hover:text-[var(--purpose-ink)]",
        className,
      )}
    />
  );
}

/** The thin top progress rail — tidal blue on a faint track, no glow. */
export function PurposeProgress({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div
      className="h-1 w-full rounded-full bg-[color-mix(in_oklab,var(--purpose-tide)_14%,transparent)]"
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-1 rounded-full bg-[var(--purpose-tide)] transition-[width] duration-500 motion-reduce:transition-none"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/** Small uppercase label — module names, section headings. */
export function PurposeLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "text-[11px] uppercase tracking-[0.18em] text-[var(--purpose-ink-dim)] font-medium",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Tappable option card for selects — 44px+ target, quiet selected state. */
export function PurposeOptionCard({
  selected,
  onClick,
  children,
  disabled,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "w-full min-h-11 rounded-xl border px-4 py-3 text-left text-base leading-snug transition-colors",
        selected
          ? "border-[var(--purpose-tide)] bg-[color-mix(in_oklab,var(--purpose-tide)_14%,transparent)] text-[var(--purpose-ink)]"
          : "border-[var(--purpose-line)] text-[var(--purpose-ink-dim)] hover:text-[var(--purpose-ink)] hover:border-[color-mix(in_oklab,var(--purpose-tide)_45%,transparent)]",
        disabled && "opacity-40 pointer-events-none",
      )}
    >
      {children}
    </button>
  );
}

/** Chip — quick-picks that seed a textarea (Why levels, core values). */
export function PurposeChip({
  selected,
  onClick,
  children,
}: {
  selected?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={!!selected}
      className={cn(
        "min-h-9 rounded-full border px-3.5 py-1.5 text-sm transition-colors",
        selected
          ? "border-[var(--purpose-sand)] text-[var(--purpose-sand)] bg-[color-mix(in_oklab,var(--purpose-sand)_12%,transparent)]"
          : "border-[var(--purpose-line)] text-[var(--purpose-ink-dim)] hover:text-[var(--purpose-ink)]",
      )}
    >
      {children}
    </button>
  );
}

const fieldClass =
  "w-full rounded-xl border border-[var(--purpose-line)] bg-[color-mix(in_oklab,var(--purpose-navy-deep)_70%,transparent)] " +
  "px-4 py-3 text-base text-[var(--purpose-ink)] placeholder:text-[color-mix(in_oklab,var(--purpose-ink-dim)_65%,transparent)] " +
  "outline-none focus:border-[var(--purpose-tide)] focus:ring-2 focus:ring-[color-mix(in_oklab,var(--purpose-tide)_30%,transparent)]";

export function PurposeTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(fieldClass, "min-h-32 resize-y", props.className)} />;
}

export function PurposeInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(fieldClass, "min-h-11", props.className)} />;
}
