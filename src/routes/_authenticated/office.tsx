import { createFileRoute } from "@tanstack/react-router";
import { requireRoleBeforeLoad } from "@/lib/roles";
import { OfficePortal, type OfficeTab } from "@/components/OfficePortal";

/** The Office Portal: the whole app for the `office` role (receptionist,
 *  production, back-office — owner ask 2026-11-23). Clock in/out and lunch
 *  on one tab, time-off requests on the other. Owners are admitted so View
 *  As previews work (the guard checks REAL roles). */
export const Route = createFileRoute("/_authenticated/office")({
  head: () => ({ meta: [{ title: "Office — Turf Invaders" }] }),
  beforeLoad: requireRoleBeforeLoad(["office", "owner"]),
  validateSearch: (search: Record<string, unknown>): { tab: OfficeTab } => ({
    tab: search.tab === "timeoff" ? "timeoff" : "clock",
  }),
  component: OfficePage,
});

function OfficePage() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <OfficePortal tab={tab} onTabChange={(t) => navigate({ search: { tab: t }, replace: true })} />
  );
}
