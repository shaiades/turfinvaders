// /purpose-leadership/$userId — one rep's purpose profile for coaching
// (spec §19.3). Owner ONLY, same as the dashboard home — never office_staff.

import { createFileRoute } from "@tanstack/react-router";
import { requireRoleBeforeLoad } from "@/lib/roles";
import { PurposeRepProfile } from "@/components/purpose/PurposeRepProfile";

export const Route = createFileRoute("/_authenticated/purpose-leadership/$userId")({
  head: () => ({ meta: [{ title: "Purpose Leadership — Turf Invaders" }] }),
  beforeLoad: requireRoleBeforeLoad(["owner"]),
  component: PurposeRepProfilePage,
});

function PurposeRepProfilePage() {
  const { userId } = Route.useParams();
  return <PurposeRepProfile userId={userId} />;
}
