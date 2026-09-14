import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CrewMap } from "@/components/CrewMap";
import { MANAGER_ROLES, requireRoleBeforeLoad } from "@/lib/roles";

export const Route = createFileRoute("/_authenticated/crew-map")({
  head: () => ({ meta: [{ title: "Crew Map — Turf Invaders" }] }),
  // Leadership-only (real DB roles): canvassers/sales reps bounce in
  // beforeLoad, before the page mounts or fires any queries.
  beforeLoad: requireRoleBeforeLoad(MANAGER_ROLES),
  component: CrewMapPage,
});

// Deep-linkable home for the live map (owner ask 2026-09-14) — reachable
// from the leadership hamburger and the captain's ActiveRun header. The two
// in-page mounts on /my-territory stay for muscle memory; Back lands on
// Territory for both tiers.
function CrewMapPage() {
  const navigate = useNavigate();
  return <CrewMap onBack={() => navigate({ to: "/my-territory" })} />;
}
