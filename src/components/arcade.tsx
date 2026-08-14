import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { Slot } from "@radix-ui/react-slot";
import { CalendarRange } from "lucide-react";
import { cn } from "@/lib/utils";

/* ── Faction design system ────────────────────────────────────────────────────
 * Two factions, one arcade. Turf Invaders = cyberpunk pink/cyan; Close Kombat
 * = blood red/gold on deep black. Tokens live in styles.css (@theme:
 * turf-pink / turf-cyan / kombat-red / kombat-gold / kombat-black, plus
 * shadow-neon-pink|cyan|red|gold). Class maps below are static literals so
 * Tailwind's scanner can see every utility.
 */

export type NeonTone = "turf-pink" | "turf-cyan" | "kombat-red" | "kombat-gold";

const NEON_BUTTON_TONE: Record<NeonTone, string> = {
  "turf-pink":
    "text-turf-pink border-turf-pink/40 hover:border-turf-pink hover:shadow-neon-pink focus-visible:shadow-neon-pink focus-visible:border-turf-pink active:bg-turf-pink/15",
  "turf-cyan":
    "text-turf-cyan border-turf-cyan/40 hover:border-turf-cyan hover:shadow-neon-cyan focus-visible:shadow-neon-cyan focus-visible:border-turf-cyan active:bg-turf-cyan/15",
  "kombat-red":
    "text-kombat-red border-kombat-red/50 hover:border-kombat-red hover:shadow-neon-red focus-visible:shadow-neon-red focus-visible:border-kombat-red active:bg-kombat-red/20",
  "kombat-gold":
    "text-kombat-gold border-kombat-gold/50 hover:border-kombat-gold hover:shadow-neon-gold focus-visible:shadow-neon-gold focus-visible:border-kombat-gold active:bg-kombat-gold/15",
};

export interface NeonButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Faction accent — defaults to the house pink. */
  tone?: NeonTone;
  /** Render the child element (e.g. a router <Link>) with NeonButton's styling. */
  asChild?: boolean;
}

/** Dark button that ignites on hover/press/keyboard focus with an outer neon
 *  glow. 44px touch target below md per the responsive rules (AGENTS.md);
 *  callers can densify from md up via className (twMerge lets them win). */
export const NeonButton = forwardRef<HTMLButtonElement, NeonButtonProps>(
  ({ tone = "turf-pink", className, type, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        type={asChild ? type : (type ?? "button")}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-md border bg-background/80 px-4 min-h-11 md:min-h-9",
          "font-display text-[10px] uppercase tracking-widest whitespace-nowrap cursor-pointer select-none",
          "transition-all duration-200 active:translate-y-px",
          "focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
          NEON_BUTTON_TONE[tone],
          className,
        )}
        {...props}
      />
    );
  },
);
NeonButton.displayName = "NeonButton";

const ARCADE_CARD_FACTION = {
  turf: {
    base: "border-turf-pink/35",
    glow: "shadow-neon-pink border-turf-pink/60",
  },
  kombat: {
    base: "bg-kombat-black border-kombat-red/40",
    glow: "bg-kombat-black shadow-neon-red border-kombat-red/70",
  },
} as const;

export interface ArcadeCardProps extends HTMLAttributes<HTMLDivElement> {
  /** Omit for the neutral house card; set to tint the border to a faction. */
  faction?: keyof typeof ARCADE_CARD_FACTION;
  /** Outer neon glow — reserve for the panel that should own the screen. */
  glow?: boolean;
  /** Render the child element (a <Link> card, a <button> card) with the
   *  card's styling instead of wrapping it in a div. */
  asChild?: boolean;
}

/** Dark rounded container on the arcade-card base (styles.css). NOTE:
 *  arcade-card clips overflow — any horizontal scroller inside needs an
 *  intact width chain (floored grid tracks / min-w-0), see AGENTS.md rule 2. */
export const ArcadeCard = forwardRef<HTMLDivElement, ArcadeCardProps>(
  ({ faction, glow = false, asChild = false, className, ...props }, ref) => {
    const Comp = asChild ? Slot : "div";
    return (
      <Comp
        ref={ref}
        className={cn(
          "arcade-card p-4 transition-all duration-200",
          faction && ARCADE_CARD_FACTION[faction].base,
          faction && glow && ARCADE_CARD_FACTION[faction].glow,
          !faction && glow && "arcade-card-glow",
          className,
        )}
        {...props}
      />
    );
  },
);
ArcadeCard.displayName = "ArcadeCard";

/** Dim-at-zero stat coloring: zeros/nulls sink into the background, positive
 *  values ignite in the given utility class. The table twin of
 *  FleetDispatch's metricClass — use for every numeric grid cell. */
export function metricText(value: number | null | undefined, lit: string): string {
  return (value ?? 0) > 0 ? lit : "text-muted-foreground/40";
}

const PILL_TONE = {
  neon: {
    active: "bg-neon text-background border-neon",
    idle: "hover:border-neon/40",
  },
  "kombat-gold": {
    active: "bg-kombat-gold text-background border-kombat-gold",
    idle: "hover:border-kombat-gold/40",
  },
} as const;

export interface ArcadePillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  /** Faction accent for the lit state — turf pages use neon, Close Kombat gold. */
  tone?: keyof typeof PILL_TONE;
  /** md = primary range tabs, sm = secondary preset chips. */
  size?: "md" | "sm";
}

/** The Day/Week/Month pill — one source for every range strip (RangeTabs,
 *  Close Kombat) so sizing, 44px mobile targets, and tones can't drift. */
export function ArcadePill({
  active = false,
  tone = "neon",
  size = "md",
  className,
  type,
  ...props
}: ArcadePillProps) {
  return (
    <button
      type={type ?? "button"}
      className={cn(
        "min-h-11 md:min-h-0 rounded-full text-[10px] font-display uppercase tracking-widest whitespace-nowrap border transition-colors duration-200",
        size === "md" ? "px-3 py-2" : "px-2.5 py-1.5",
        active
          ? PILL_TONE[tone].active
          : cn("border-border text-muted-foreground hover:text-foreground", PILL_TONE[tone].idle),
        className,
      )}
      {...props}
    />
  );
}

/** The pinned range label between pager arrows on Week/Month strips. */
export function RangeChip({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 py-1 rounded border border-neon/40 bg-neon/5 flex items-center gap-2 whitespace-nowrap">
      <CalendarRange className="w-4 h-4 text-neon shrink-0" />
      <span className="text-xs font-display">{children}</span>
    </div>
  );
}

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

export function ArcadePanel({
  title,
  action,
  children,
  faction,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  /** Faction skin: kombat = gold title on deep black with blood-red chrome. */
  faction?: keyof typeof ARCADE_CARD_FACTION;
}) {
  return (
    <section className={cn("arcade-card", faction && ARCADE_CARD_FACTION[faction].base)}>
      <header
        className={cn(
          "flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-5 py-3",
          faction === "kombat" ? "border-kombat-red/30" : "border-border",
        )}
      >
        <h2
          className={cn(
            "min-w-0 font-display text-xs uppercase tracking-widest",
            faction === "kombat" ? "text-kombat-gold" : "text-neon",
          )}
        >
          {title}
        </h2>
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
  label,
  value,
  className,
  lit,
}: {
  label: string;
  value: ReactNode;
  className?: string;
  lit?: string;
}) {
  // lit = dim-at-zero: numeric zeros sink into the background, positive
  // values ignite in the given class (metricText, same rule as the tables).
  const ignite =
    lit !== undefined && typeof value === "number" ? metricText(value, lit) : undefined;
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className={cn("text-sm tabular-nums", ignite, className)}>{value}</div>
    </div>
  );
}
