// /my-purpose — the entry surface. Deliberately NO beforeLoad role guard:
// canvassers and captains must reach the component so it can show the spec's
// "coming later" message instead of a silent bounce (the AppShell cages
// allow the path through for the same reason). RLS on the purpose_* tables
// is the real privacy boundary either way.

import { useMemo } from "react";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useAuth } from "@/hooks/useAuth";
import { canUseViewAs, privilegeRole } from "@/lib/roles";
import { usePurposeConfig } from "@/hooks/usePurposeConfig";
import { usePurposeProfile } from "@/hooks/usePurposeProfile";
import { usePurposeAnswers } from "@/hooks/usePurposeAnswers";
import { progressPct, resolveSteps, resumeIndex } from "@/lib/purpose/engine";
import { ALL_STEPS, MODULES } from "@/data/purpose-workshop-content";
import { CanvasserComingLater } from "@/components/purpose/CanvasserComingLater";
import { PurposeLanding, PurposeResumeCard } from "@/components/purpose/PurposeLanding";
import { PurposeHome } from "@/components/purpose/PurposeHome";

export const Route = createFileRoute("/_authenticated/my-purpose/")({
  head: () => ({ meta: [{ title: "My Purpose — Turf Invaders" }] }),
  component: MyPurposePage,
});

function MyPurposePage() {
  const { user, role, realRole, displayName, realDisplayName } = useAuth();
  const isOwner = canUseViewAs(realRole); // owner-only helper — true real owners
  const configQuery = usePurposeConfig(!!user && (role === "sales_rep" || isOwner));
  const profileQuery = usePurposeProfile(user?.id);
  const profile = profileQuery.data?.row ?? null;
  const answersQuery = usePurposeAnswers(
    profile && profile.status === "in_progress" ? profile.id : undefined,
  );

  const resumePct = useMemo(() => {
    if (!profile || !answersQuery.data) return null;
    const steps = resolveSteps(ALL_STEPS, answersQuery.data);
    return progressPct(MODULES, steps, resumeIndex(steps, answersQuery.data, profile.current_step));
  }, [profile, answersQuery.data]);

  // Role still resolving — never flash the wrong state.
  if (!user || role === null) return null;

  const tier = privilegeRole(role);
  if (tier === "canvasser" || tier === "captain") return <CanvasserComingLater />;
  if (role === "office_staff" && !isOwner) return <CanvasserComingLater unauthorized />;

  // Pre-launch: reps see nothing here (the nav item is hidden too; this
  // covers shared links). Owners always pass — they're the test crew.
  const repEnabled = configQuery.data?.sales_rep_feature_enabled === true;
  if (role === "sales_rep" && !isOwner) {
    if (configQuery.isLoading) return null;
    if (!repEnabled) return <Navigate to="/close-kombat" search={{ tab: "stats" }} replace />;
  }

  if (profileQuery.isLoading) return null;

  if (profileQuery.data?.missingMigration) {
    return <CanvasserComingLater notReady />;
  }

  if (!profile || profile.status === "not_started") {
    return <PurposeLanding userId={user.id} />;
  }
  if (profile.status === "in_progress") {
    return <PurposeResumeCard profile={profile} pct={resumePct} />;
  }
  return (
    <PurposeHome
      profile={profile}
      displayName={displayName}
      isPreviewingOtherName={!!displayName && !!realDisplayName && displayName !== realDisplayName}
    />
  );
}
