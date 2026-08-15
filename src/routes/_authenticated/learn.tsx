import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useAuth } from "@/hooks/useAuth";
import { LearnPanel } from "@/components/LearnPanel";

// Leadership window into the training library + Objection Dojo (owner
// request 2026-08-15) — the same LearnPanel canvassers get as their Mission
// Learn tab, without needing View As.
export const Route = createFileRoute("/_authenticated/learn")({
  head: () => ({ meta: [{ title: "Learn — Knockout" }] }),
  component: LearnPage,
});

function LearnPage() {
  const { role, loading } = useAuth();

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;

  // Canvassers learn inside the Mission page. NOTE: /learn must stay in
  // CANVASSER_ALLOWED — the AppShell guard fires on pathname before this
  // Navigate runs (same race as /log).
  if (role === "canvasser") {
    return <Navigate to="/dashboard" search={{ tab: "learn" }} replace />;
  }

  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Training
        </div>
        <h1 className="font-display text-2xl text-neon mt-1">LEARN</h1>
        <p className="text-xs text-muted-foreground mt-2">
          The training library and Objection Dojo — the same screen your canvassers see.
        </p>
      </div>

      <LearnPanel />
    </div>
  );
}
