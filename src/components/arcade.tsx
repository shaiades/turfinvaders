import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function StatCard({
  label, value, sublabel, accent, className,
}: { label: string; value: ReactNode; sublabel?: string; accent?: "neon" | "victory" | "warning" | "accent"; className?: string }) {
  const accentClass = {
    neon: "text-neon",
    victory: "text-victory",
    warning: "text-[var(--warning)]",
    accent: "text-[var(--accent)]",
  }[accent ?? "neon"];
  return (
    <div className={cn("arcade-card p-5", className)}>
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-display">{label}</div>
      <div className={cn("mt-3 text-2xl sm:text-3xl font-display tabular-nums break-words", accentClass)}>{value}</div>
      {sublabel && <div className="mt-1 text-xs text-muted-foreground">{sublabel}</div>}
    </div>
  );
}

export function ArcadePanel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="arcade-card">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-5 py-3">
        <h2 className="min-w-0 font-display text-xs text-neon uppercase tracking-widest">{title}</h2>
        {action}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function TeamBadge({ name, color }: { name: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium border"
      style={{ borderColor: color, color, background: `color-mix(in oklab, ${color} 10%, transparent)` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {name}
    </span>
  );
}

/* ── Mobile card-table primitives ─────────────────────────────────────────────
 * Wide data tables keep their desktop markup untouched behind `hidden md:block`
 * and render a sibling <MobileCardList> from the SAME precomputed rows.
 * Visibility is pure CSS (md:hidden / hidden md:block) — never useIsMobile(),
 * which would flash/mismatch under SSR.
 *
 * Card layout convention:
 *   Row 1  MobileCardHeader — identity left (truncates), ONE headline metric
 *          right (text-victory for money, text-neon for points/hours).
 *   Row 2  optional badges — flex flex-wrap gap-1.5 of RankPill/TeamBadge/etc.
 *   Row 3  MobileStatGrid — remaining numerics in desktop-column order.
 *   Row 4  optional controls — full-width inputs stacked, then flex gap-2
 *          button row (flex-1 buttons).
 *   tfoot totals → trailing <MobileCard className="border-neon/40">.
 */

export function MobileCardList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("md:hidden space-y-2", className)}>{children}</div>;
}

export function MobileCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-border/40 bg-surface/50 p-3 space-y-2.5", className)}>
      {children}
    </div>
  );
}

export function MobileCardHeader({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0 flex-1 truncate text-sm font-medium">{left}</div>
      {right != null && <div className="shrink-0 font-display text-sm">{right}</div>}
    </div>
  );
}

export function MobileStatGrid({
  children, cols = 3, className,
}: { children: ReactNode; cols?: 2 | 3 | 4; className?: string }) {
  const colsClass = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" }[cols];
  return <div className={cn("grid gap-x-3 gap-y-2", colsClass, className)}>{children}</div>;
}

export function MobileStat({
  label, value, className,
}: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={cn("text-sm tabular-nums", className)}>{value}</div>
    </div>
  );
}
