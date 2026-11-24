// "Still in house" queue — dispatch's view of the rep can't-make-it button
// (owner mandate 2026-11-20). Every row is a rep who tapped the ping on a
// lead card: WHO is stuck, WHICH lead they can't make, and — the point —
// WHERE they actually are (live GPS fix + reverse-geocoded address, tap to
// map), so "still in house" is verifiable at a glance and dispatch can put
// another rep on the lead or call the customer to push. Realtime: a ping
// pops here within a second. Renders nothing on a quiet day (owns its
// bottom margin, CoachTriggersCard pattern). Admin tier only.

import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Home, MapPin, Loader2, StickyNote } from "lucide-react";
import {
  useInHousePingsToday,
  useMarkInHousePingHandled,
  type InHousePing,
} from "@/hooks/useInHousePings";

function timeLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Los_Angeles",
    });
  } catch {
    return "";
  }
}

function PingRow({ ping }: { ping: InHousePing }) {
  const handle = useMarkInHousePingHandled();
  const handled = ping.status === "handled";
  return (
    <div
      className={`rounded-lg border p-3 space-y-2 ${
        handled
          ? "border-border/40 bg-surface/40 opacity-70"
          : "border-kombat-gold/50 bg-surface/60"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {ping.rep_name || "Unknown rep"}{" "}
            <span className="text-muted-foreground">· {timeLabel(ping.created_at)}</span>
          </p>
          <p className="truncate text-xs text-muted-foreground">
            Can’t make: {ping.lead_name || ping.monday_item_id}
            {ping.lead_address ? ` — ${ping.lead_address}` : ""}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-display uppercase tracking-widest ${
            handled
              ? "border-border text-muted-foreground"
              : "border-kombat-gold/50 text-kombat-gold"
          }`}
        >
          {handled ? "Handled" : "Needs cover"}
        </span>
      </div>

      <a
        href={`https://maps.google.com/?q=${ping.lat},${ping.lng}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-h-11 items-center gap-2 rounded-md border border-border/40 bg-background/40 px-3 text-sm text-foreground active:bg-background/70"
      >
        <MapPin className="size-4 shrink-0 text-neon" />
        <span className="min-w-0 truncate">
          {ping.located_address ?? `${ping.lat.toFixed(5)}, ${ping.lng.toFixed(5)}`}
        </span>
        {ping.accuracy_m != null && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
            ±{Math.round(ping.accuracy_m)}m
          </span>
        )}
      </a>

      {ping.note && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <StickyNote className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">{ping.note}</span>
        </p>
      )}

      {!handled && (
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={handle.isPending}
          onClick={() => handle.mutate(ping.id)}
        >
          {handle.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Mark handled (covered / pushed)
        </Button>
      )}
    </div>
  );
}

export function StillInHouseQueue() {
  const q = useInHousePingsToday();
  const pings = q.data ?? [];
  if (pings.length === 0) return null;
  const open = pings.filter((p) => p.status === "open");
  return (
    <div className="mb-4">
      <ArcadePanel
        title="Still in house — leads needing cover"
        faction="kombat"
        headline={
          <span className="flex items-center gap-2 font-display text-xs text-muted-foreground">
            <Home className="size-4 text-kombat-gold" />
            {open.length} open · {pings.length} today
          </span>
        }
      >
        <div className="grid gap-2 md:grid-cols-2">
          {pings.map((p) => (
            <PingRow key={p.id} ping={p} />
          ))}
        </div>
      </ArcadePanel>
    </div>
  );
}
