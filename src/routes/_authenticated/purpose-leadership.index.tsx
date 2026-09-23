// /purpose-leadership — the owner-only coaching command center (spec §19).
// Guard is owner ONLY — never office_staff: this page holds every rep's
// direction, beliefs, and support requests. RLS on the purpose_* tables is
// the real boundary; this beforeLoad is the polite front door.

import { createFileRoute } from "@tanstack/react-router";
import { requireRoleBeforeLoad } from "@/lib/roles";
import { PurposeLeadership } from "@/components/purpose/PurposeLeadership";

export const Route = createFileRoute("/_authenticated/purpose-leadership/")({
  head: () => ({ meta: [{ title: "Purpose Leadership — Turf Invaders" }] }),
  beforeLoad: requireRoleBeforeLoad(["owner"]),
  component: PurposeLeadershipPage,
});

function PurposeLeadershipPage() {
  return <PurposeLeadership />;
}
