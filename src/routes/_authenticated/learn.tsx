import { createFileRoute } from "@tanstack/react-router";
import { LearnPanel } from "@/components/LearnPanel";

// The training library + Objection Dojo. First-class for every role since
// 2026-09-08 (owner decision): canvassers get it as their own bottom-bar tab
// now — the old redirect into Mission's Learn tab is gone along with that tab.
export const Route = createFileRoute("/_authenticated/learn")({
  head: () => ({ meta: [{ title: "Learn — Turf Invaders" }] }),
  component: LearnPage,
});

function LearnPage() {
  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Training
        </div>
        <h1 className="font-display text-2xl text-neon mt-1">LEARN</h1>
        <p className="text-xs text-muted-foreground mt-2">
          Training videos, scripts, and the Objection Dojo.
        </p>
      </div>

      <LearnPanel />
    </div>
  );
}
