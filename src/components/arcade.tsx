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
      <div className={cn("mt-3 text-3xl font-display", accentClass)}>{value}</div>
      {sublabel && <div className="mt-1 text-xs text-muted-foreground">{sublabel}</div>}
    </div>
  );
}

export function ArcadePanel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="arcade-card">
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="font-display text-xs text-neon uppercase tracking-widest">{title}</h2>
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
