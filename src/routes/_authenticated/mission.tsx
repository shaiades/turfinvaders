import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useAuth } from "@/hooks/useAuth";
import { isAdminRole } from "@/lib/roles";
import { CanvasserMission, isCanvasserTab, type CanvasserTab } from "@/components/CanvasserMission";

// Captains knock doors too, so they get the personal Mission surface (time
// clock, pay, Plan/Log/Stats) — the one canvasser tool their Command dashboard
// didn't cover (owner request 2026-09-09). Canvassers keep Mission on
// /dashboard (unchanged); this route only splits it out for roles whose
// /dashboard is already a management view, so Command and Mission can coexist
// as sibling nav tabs instead of colliding on one route.
export const Route = createFileRoute("/_authenticated/mission")({
  head: () => ({ meta: [{ title: "Mission — Turf Invaders" }] }),
  validateSearch: (s: Record<string, unknown>): { tab: CanvasserTab } => ({
    tab: isCanvasserTab(s.tab) ? s.tab : "log",
  }),
  component: MissionPage,
});

// Role fan-out (dashboard.tsx pattern). Reads the effective role so View As
// previews the real thing. Only door-knocking managers (captains) live here;
// canvassers have Mission on /dashboard, and the Admin tier has no personal
// mission (no team_id, no daily_logs) — both bounce to their own dashboard.
function MissionPage() {
  const { role, loading, teamId, displayName, user } = useAuth();
  const { tab: rawTab } = Route.useSearch();
  const navigate = Route.useNavigate();
  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  // Non-captains have no personal Mission here: canvassers own it on /dashboard
  // (?tab coerces to their stored Mission tab), admins land on Command. The
  // "dispatch" tab serves both — CanvasserMission coerces it away, OwnerDashboard
  // treats it as Command.
  if (role !== "captain" || isAdminRole(role)) {
    return <Navigate to="/dashboard" search={{ tab: "dispatch" }} replace />;
  }
  return user?.id ? (
    <CanvasserMission
      displayName={displayName}
      teamId={teamId}
      userId={user.id}
      rawTab={rawTab}
      setTab={(t) => navigate({ search: { tab: t }, replace: true })}
    />
  ) : (
    <div className="text-sm text-muted-foreground">Loading your mission…</div>
  );
}
