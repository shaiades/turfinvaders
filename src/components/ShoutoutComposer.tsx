// §6 Shoutout — an owner/manager picks a player + a praise line and broadcasts
// it to every field phone (confetti banner via the Street Feed) + logs it as a
// feed_event. Presets or a short custom line. RLS lets owner/office_staff post.

import { useState } from "react";
import { Megaphone } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useDispatchRoster } from "@/hooks/useFleetRoster";
import { writeFeedEvent } from "@/hooks/useFeed";

const PRESETS = [
  "is on FIRE today 🔥",
  "crushed it at the door",
  "set the pace — chase 'em",
  "big closer energy",
  "welcome to the grind",
];

export function ShoutoutComposer() {
  const { user } = useAuth();
  const roster = useDispatchRoster();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [line, setLine] = useState(PRESETS[0]);
  const [busy, setBusy] = useState(false);

  const people = [
    ...new Set((roster.data?.profiles ?? []).map((p) => p.display_name).filter(Boolean)),
  ].sort();

  const send = async () => {
    if (!user?.id || !name || !line.trim()) return;
    setBusy(true);
    try {
      await writeFeedEvent({
        kind: "shoutout",
        body: `${name} ${line.trim()}`,
        actorName: name,
        color: "var(--kombat-gold)",
        userId: user.id,
      });
      toast.success("📣 Shoutout sent to the field");
      setOpen(false);
    } catch {
      toast.error("Couldn't send the shoutout");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Megaphone className="h-4 w-4" /> Send a shoutout
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a shoutout</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
              Who
            </label>
            <select
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 h-11 w-full rounded-md border border-border bg-surface px-3 text-base md:h-9 md:text-sm"
            >
              <option value="">Pick a player…</option>
              {people.map((p) => (
                <option key={p} value={p!}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
              Praise
            </label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setLine(p)}
                  className={`rounded-full border px-3 py-1.5 text-xs transition ${
                    line === p ? "border-neon text-neon" : "border-border text-muted-foreground"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
            <input
              value={line}
              onChange={(e) => setLine(e.target.value)}
              maxLength={80}
              className="mt-2 h-11 w-full rounded-md border border-border bg-surface px-3 text-base md:h-9 md:text-sm"
              placeholder="or type a short line"
            />
          </div>
          <Button onClick={send} disabled={busy || !name} className="w-full">
            {busy ? "Sending…" : "📣 Broadcast to the field"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
