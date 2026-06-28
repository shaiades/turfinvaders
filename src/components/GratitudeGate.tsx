import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Heart, Lock } from "lucide-react";

function todayISO() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function storageKey(userId: string) {
  return `gratitude:${userId}:${todayISO()}`;
}

export function hasPassedGratitudeGate(userId: string | undefined): boolean {
  if (!userId || typeof window === "undefined") return false;
  try { return !!window.localStorage.getItem(storageKey(userId)); } catch { return false; }
}

export function GratitudeGate({
  userId, children,
}: { userId: string | undefined; children: React.ReactNode }) {
  const [unlocked, setUnlocked] = useState<boolean>(() => hasPassedGratitudeGate(userId));
  const [text, setText] = useState("");

  useEffect(() => { setUnlocked(hasPassedGratitudeGate(userId)); }, [userId]);

  if (unlocked) return <>{children}</>;

  const submit = () => {
    const v = text.trim();
    if (v.length < 2 || !userId) return;
    try {
      window.localStorage.setItem(storageKey(userId), JSON.stringify({ text: v, at: new Date().toISOString() }));
    } catch { /* ignore */ }
    setUnlocked(true);
  };

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4">
      <div className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-[color-mix(in_oklab,var(--neon)_45%,var(--border))] bg-[linear-gradient(160deg,#08080d,#0e0a18)] p-8 md:p-10"
           style={{ boxShadow: "0 0 60px -20px var(--neon), inset 0 0 60px -20px var(--neon)" }}>
        <div className="absolute inset-0 pointer-events-none scanlines opacity-20" />
        <div className="relative space-y-6 text-center">
          <div className="inline-flex items-center gap-2 text-[10px] font-display uppercase tracking-[0.3em] text-neon">
            <Lock className="w-3 h-3" /> Gratitude Gate
          </div>
          <Heart className="w-10 h-10 mx-auto text-[#ff4d8d]"
                 style={{ filter: "drop-shadow(0 0 12px #ff4d8d)" }} />
          <h1 className="font-display text-2xl md:text-3xl text-neon leading-tight">
            What are you grateful for today?
          </h1>
          <p className="text-sm text-muted-foreground">
            One sentence is enough. The map unlocks the moment you answer.
          </p>
          <div className="space-y-3 text-left">
            <Input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="My family · waking up healthy · this opportunity…"
              className="h-14 px-4 text-base bg-background/60 border-[color-mix(in_oklab,var(--neon)_45%,var(--border))] focus-visible:ring-neon"
              style={{ boxShadow: "inset 0 0 18px -8px var(--neon)" }}
            />
            <Button
              onClick={submit}
              disabled={text.trim().length < 2}
              className="w-full h-12 font-display uppercase tracking-widest bg-neon/20 hover:bg-neon/30 text-neon border border-neon/60"
              style={{ boxShadow: "0 0 22px -6px var(--neon)" }}
            >
              Unlock the Field
            </Button>
          </div>
          <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Resets at midnight · one check-in per day
          </p>
        </div>
      </div>
    </div>
  );
}
