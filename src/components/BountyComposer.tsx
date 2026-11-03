// §6 Bounties — an owner/manager launches a time-boxed boost that shows as a
// banner for the whole field. Managers only (RLS). A bounty may only promise
// what actually scores (the 2026-10-15 rule): with score_v2 off that is one
// thing — multiplier× arcade points per confirmed lead set in the window — so
// the picker stays "leads"-only. Once the Tier 2 flag is on, the SQL triggers
// honor the category per grant, so the doors/leads/sit/sale picker comes back
// (engagement audit 2026-11-03 — SIT WEEK bounty weeks feed the FINAL ROUND).
// Game points only, never pay.

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
import { createBounty, type BountyCategory } from "@/hooks/useBounties";
import { useArcadeScore } from "@/hooks/useArcadeScore";

const DURATIONS = [
  { m: 60, label: "1h" },
  { m: 120, label: "2h" },
  { m: 240, label: "4h" },
  { m: 1440, label: "1 day" },
  { m: 1440 * 7, label: "1 week" },
];
const MULTS = [2, 3];
const CATEGORIES: { key: BountyCategory; chip: string; per: string }[] = [
  { key: "doors", chip: "🚪 Doors", per: "per conversation" },
  { key: "leads", chip: "⚡ Leads", per: "per lead" },
  { key: "sit", chip: "🥊 Sits", per: "per sit" },
  { key: "sale", chip: "💰 Sales", per: "per sale" },
];

export function BountyComposer() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mult, setMult] = useState(2);
  const [mins, setMins] = useState(120);
  const [cat, setCat] = useState<BountyCategory>("leads");
  const [busy, setBusy] = useState(false);
  // Legacy scoring multiplies leads only — the picker opens with the flag.
  const v2 = useArcadeScore(user?.id).enabled;
  const category: BountyCategory = v2 ? cat : "leads";

  const launch = async () => {
    if (!user?.id) return;
    setBusy(true);
    try {
      const durLabel = DURATIONS.find((d) => d.m === mins)?.label ?? `${mins}m`;
      const per = CATEGORIES.find((c) => c.key === category)?.per ?? "per lead";
      await createBounty({
        label: `${mult}× pts ${per} for the next ${durLabel}`,
        category,
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
            {v2
              ? "Every scored action of the picked kind earns the multiplier on the arcade boards while the bounty runs."
              : "Every confirmed lead set while the bounty runs earns the multiplier on the arcade boards."}{" "}
            Game points only — pay is untouched.
          </p>
          {v2 && (
            <div>
              <label className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
                Boost
              </label>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {CATEGORIES.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setCat(c.key)}
                    className={chip(cat === c.key)}
                  >
                    {c.chip}
                  </button>
                ))}
              </div>
            </div>
          )}
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
