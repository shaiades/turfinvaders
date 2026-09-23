// /my-purpose/workshop — the guided flow itself, deep-linkable so "Continue"
// survives a reload mid-meeting. ?step=<key> re-enters ONE step in edit mode
// (from the review screen or Purpose Home); ?review=1 jumps to the final
// review. Resume position otherwise comes from the server-persisted
// current_step.

import { createFileRoute, Navigate } from "@tanstack/react-router";
import { requireRoleBeforeLoad, canUseViewAs } from "@/lib/roles";
import { useAuth } from "@/hooks/useAuth";
import { usePurposeConfig } from "@/hooks/usePurposeConfig";
import { usePurposeProfile } from "@/hooks/usePurposeProfile";
import { PurposeWorkshop } from "@/components/purpose/PurposeWorkshop";

export const Route = createFileRoute("/_authenticated/my-purpose/workshop")({
  head: () => ({ meta: [{ title: "My Purpose — Turf Invaders" }] }),
  beforeLoad: requireRoleBeforeLoad(["owner", "sales_rep"]),
  validateSearch: (s: Record<string, unknown>): { step?: string; review?: boolean } => ({
    step: typeof s.step === "string" && s.step ? s.step : undefined,
    review: s.review === true || s.review === "1" || s.review === "true" ? true : undefined,
  }),
  component: WorkshopPage,
});

function WorkshopPage() {
  const { step, review } = Route.useSearch();
  const { user, role, realRole } = useAuth();
  const isOwner = canUseViewAs(realRole);
  const configQuery = usePurposeConfig(!!user && (role === "sales_rep" || isOwner));
  const profileQuery = usePurposeProfile(user?.id);
  const profile = profileQuery.data?.row ?? null;

  if (!user || role === null || profileQuery.isLoading) return null;

  const repEnabled = configQuery.data?.sales_rep_feature_enabled === true;
  if (role === "sales_rep" && !isOwner && !configQuery.isLoading && !repEnabled) {
    return <Navigate to="/close-kombat" search={{ tab: "stats" }} replace />;
  }

  // No profile yet → the landing card owns profile creation.
  if (!profile) return <Navigate to="/my-purpose" replace />;

  // ?review=1 → jump straight to the final review step in the normal flow;
  // the engine resumes at review because everything before it is complete.
  return <PurposeWorkshop profile={profile} editStepKey={step} jumpToReview={review === true} />;
}
