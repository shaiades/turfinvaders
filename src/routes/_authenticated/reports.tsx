import { createFileRoute } from "@tanstack/react-router";
import { ADMIN_ROLES, requireRoleBeforeLoad } from "@/lib/roles";
import { ReportsConsole, type ReportsTab } from "@/components/ReportsConsole";

/** Books & records: the bookkeeper's whole app, the Admin tier's export
 *  console, and HR's records view (payroll tab/card hidden inside — HR
 *  reads attendance, never dollars). Standalone route (not a dashboard
 *  ?tab): /dashboard's role fan-out is Admin-shaped, and Mary's two-item
 *  nav deep-links here. */
export const Route = createFileRoute("/_authenticated/reports")({
  head: () => ({ meta: [{ title: "Reports — Turf Invaders" }] }),
  beforeLoad: requireRoleBeforeLoad([...ADMIN_ROLES, "bookkeeper", "hr"]),
  validateSearch: (search: Record<string, unknown>): { tab: ReportsTab } => ({
    tab: search.tab === "payroll" ? "payroll" : "exports",
  }),
  component: ReportsPage,
});

function ReportsPage() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ReportsConsole
      tab={tab}
      onTabChange={(t) => navigate({ search: { tab: t }, replace: true })}
    />
  );
}
