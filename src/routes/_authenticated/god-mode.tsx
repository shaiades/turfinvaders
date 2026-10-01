// /god-mode — the owner-only whole-business dashboard (owner directive
// 2026-09-30). Guard is owner ONLY — never office_staff: this page leads
// with collections money (customer payments, bank state). RLS on
// report_collections is the real boundary; this beforeLoad is the polite
// front door. ?month=YYYY-MM-01 makes a viewed month shareable between the
// two owners.

import { createFileRoute } from "@tanstack/react-router";
import { requireRoleBeforeLoad } from "@/lib/roles";
import { GodMode } from "@/components/GodMode";

const MONTH_RE = /^\d{4}-\d{2}-01$/;

export const Route = createFileRoute("/_authenticated/god-mode")({
  head: () => ({ meta: [{ title: "God Mode — Turf Invaders" }] }),
  beforeLoad: requireRoleBeforeLoad(["owner"]),
  validateSearch: (s: Record<string, unknown>): { month?: string } => ({
    month: typeof s.month === "string" && MONTH_RE.test(s.month) ? s.month : undefined,
  }),
  component: GodModePage,
});

function GodModePage() {
  const { month } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <GodMode
      monthParam={month ?? null}
      setMonthParam={(m) => navigate({ search: { month: m }, replace: true })}
    />
  );
}
