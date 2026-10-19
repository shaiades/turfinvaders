import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useAuth } from "@/hooks/useAuth";
import { DialerRun } from "@/components/DialerRun";

export const Route = createFileRoute("/_authenticated/phones")({
  head: () => ({ meta: [{ title: "Dial Run — Turf Invaders" }] }),
  component: PhonesPage,
});

// Dial Run is the confirmation department's Active Run — no map, no GPS,
// just tallies (owner mandate 2026-10-19). The fork keys on experienceRole
// (pre-collapse, View-As-aware); everyone else keeps their door screen.
function PhonesPage() {
  const { experienceRole, loading } = useAuth();
  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (experienceRole !== "confirmer") return <Navigate to="/field" replace />;
  return <DialerRun />;
}
