// Street Feed (§7) — one live ticker of the field's big moments under the
// header (not on the Active Run map screen — Phase 3 §6). Tap it for the last
// 50. A new SHOUTOUT lands as a 2-second toast on every phone via the
// headless <PraiseToasts/> below (public praise that doesn't cover the door).
// Reads useFeed (realtime); writes are leaders-only.

import { useEffect, useRef, useState } from "react";
import { Megaphone } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useFeed } from "@/hooks/useFeed";
import { playArcadeSound, haptic } from "@/lib/arcade-fx";

const KIND_ICON: Record<string, string> = {
  shoutout: "📣",
  crowning: "👑",
  van_lead: "🏁",
  bounty: "⏱️",
  sale: "💰",
  boss: "⚔️",
  badge: "🏅",
  sit: "🎯",
  dojo: "🥋",
  mystery: "🎁",
};
const kindIcon = (k: string) => KIND_ICON[k] ?? "⭐";

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * Praise watcher (Phase 3 §6) — headless, mounted once in AppShell. A NEW
 * shoutout (created after mount) lands as a 2-second toast with a light
 * haptic, on EVERY screen including the Active Run map (which no longer
 * carries the ticker). Replaces the old 4.2s confetti banner — praise should
 * pat the shoulder, not cover the door. Latches the newest shoutout id seen
 * at mount so history never fires on load.
 */
export function PraiseToasts() {
  const { events } = useFeed(50);
  const seenRef = useRef<string | null>(null);
  const armed = useRef(false);
  useEffect(() => {
    const latestShout = events.find((e) => e.kind === "shoutout") ?? null;
    if (!armed.current) {
      seenRef.current = latestShout?.id ?? null;
      armed.current = true;
      return;
    }
    if (latestShout && latestShout.id !== seenRef.current) {
      seenRef.current = latestShout.id;
      playArcadeSound("coin");
      haptic([20, 40, 20]);
      toast(`📣 ${latestShout.body}`, { duration: 2000 });
    }
  }, [events]);
  return null;
}

export function StreetFeed() {
  const { events } = useFeed(50);
  const [open, setOpen] = useState(false);

  const latest = events[0];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 overflow-hidden border-b border-border bg-surface/60 px-4 py-1.5 text-left"
        aria-label="Open the street feed"
      >
        <Megaphone className="h-3.5 w-3.5 shrink-0 text-neon" />
        {latest ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden>{kindIcon(latest.kind)}</span>
            <span className="truncate text-[11px] text-foreground/90">{latest.body}</span>
            <span className="shrink-0 font-display text-[9px] uppercase tracking-widest text-muted-foreground">
              · {timeAgo(latest.created_at)}
            </span>
          </span>
        ) : (
          <span className="truncate text-[11px] text-muted-foreground">
            Street feed — crownings, lead changes and shoutouts land here live.
          </span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Street Feed</DialogTitle>
          </DialogHeader>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No moments yet — they'll stream in live.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {events.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center gap-2.5 rounded-md border border-border/50 px-3 py-2"
                >
                  <span aria-hidden className="text-base">
                    {kindIcon(e.kind)}
                  </span>
                  {e.color && (
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: e.color, boxShadow: `0 0 6px ${e.color}` }}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm">{e.body}</span>
                  <span className="shrink-0 font-display text-[9px] uppercase tracking-widest text-muted-foreground">
                    {timeAgo(e.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
