// §6 Bounties — an owner/manager launches a time-boxed boost that shows as a
// banner for the whole field. Managers only (RLS). Since the 2026-10-15 audit
// every bounty means ONE thing, which really scores: multiplier× arcade points
// per confirmed lead set inside the window (leads carry the only sub-day
// timestamp we trust). The old sit/sale/doors category picker is gone — those
// couldn't score and made the banner lie. Game points only, never pay.

import { useState } from "react";
import { Zap } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { createBounty } from "@/hooks/useBounties";

const DURATIONS = [
  { m: 60, label: "1h" },
  { m: 120, label: "2h" },
  { m: 240, label: "4h" },
];
const MULTS = [2, 3];

export function BountyComposer() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mult, setMult] = useState(2);
  const [mins, setMins] = useState(120);
  const [busy, setBusy] = useState(false);

  const launch = async () => {
    if (!user?.id) return;
    setBusy(true);
    try {
      const durLabel = DURATIONS.find((d) => d.m === mins)?.label ?? `${mins}m`;
      await createBounty({
        label: `${mult}× pts per lead for the next ${durLabel}`,
        multiplier: mult,
        minutes: mins,
        userId: user.id,
      });
      await qc.invalidateQueries({ queryKey: ["bounties"] });
      toast.success("⏱️ Bounty is live for the field");
      setOpen(false);
    } catch {
      toast.error("Couldn't launch the bounty");
    } finally {
      setBusy(false);
    }
  };

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1.5 text-xs transition ${
      active ? "border-neon text-neon" : "border-border text-muted-foreground"
    }`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Zap className="h-4 w-4" /> Launch a bounty
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Launch a bounty</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Every confirmed lead set while the bounty runs earns the multiplier on the arcade
            boards. Game points only — pay is untouched.
          </p>
          <div>
            <label className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
              Multiplier
            </label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {MULTS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMult(m)}
                  className={chip(mult === m)}
                >
                  {m}×
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
              Runs for
            </label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {DURATIONS.map((d) => (
                <button
                  key={d.m}
                  type="button"
                  onClick={() => setMins(d.m)}
                  className={chip(mins === d.m)}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <Button onClick={launch} disabled={busy} className="w-full">
            {busy ? "Launching…" : "⏱️ Go live to the field"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
