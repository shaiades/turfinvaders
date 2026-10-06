// §6 Bounties — the field banner for any active bounty (a time-boxed category
// push). Renders nothing when none are live. Mounted under the header for field
// roles alongside the Street Feed.

import { useActiveBounties, type Bounty } from "@/hooks/useBounties";

const CAT_LABEL: Record<Bounty["category"], string> = { sit: "SIT", sale: "SALE", doors: "DOOR" };

function endsIn(iso: string): string {
  const m = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
  if (m < 60) return `${m}m left`;
  return `${Math.floor(m / 60)}h ${m % 60}m left`;
}

export function BountyBanner() {
  const bounties = useActiveBounties();
  if (bounties.length === 0) return null;
  return (
    <div className="space-y-1 border-b border-border bg-surface/60 px-3 py-1.5">
      {bounties.map((b) => (
        <div
          key={b.id}
          className="flex items-center gap-2 rounded-md px-2 py-1"
          style={{ background: "color-mix(in oklab, var(--warning) 14%, transparent)" }}
        >
          <span aria-hidden>⏱️</span>
          <span className="shrink-0 font-display text-[11px] uppercase tracking-widest text-[var(--warning)]">
            {b.multiplier}× {CAT_LABEL[b.category]} pts
          </span>
          <span className="truncate text-[11px] text-foreground/90">· {b.label}</span>
          <span className="ml-auto shrink-0 font-display text-[9px] uppercase tracking-widest text-muted-foreground">
            {endsIn(b.ends_at)}
          </span>
        </div>
      ))}
    </div>
  );
}
