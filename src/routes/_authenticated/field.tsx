import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useAuth } from "@/hooks/useAuth";
import { isAdminRole } from "@/lib/roles";
import { ActiveRun } from "@/components/ActiveRun";

export const Route = createFileRoute("/_authenticated/field")({
  head: () => ({ meta: [{ title: "Active Run — Turf Invaders" }] }),
  component: FieldPage,
});

// Role fan-out (dashboard.tsx pattern). Reads the effective role so View As
// previews the real thing.
function FieldPage() {
  const { role, loading } = useAuth();
  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  // Admin tier never canvasses from here — a stray tally tap would insert a
  // field_pins row under their uid and bump their daily_logs via trigger.
  if (isAdminRole(role)) return <Navigate to="/my-territory" replace />;
  // Captains normally live on their Territory tab (which adds Turf Tools),
  // but a hand-typed /field still gives them the canvass screen.
  return <ActiveRun variant={role === "captain" ? "captain" : "canvasser"} />;
}
