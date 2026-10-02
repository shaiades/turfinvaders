// The "WHY YOU FIGHT" strip's data: the rep's OWN Core Why (purpose_whys
// level 7) + 90-day mission (purpose_goals mission_90_day) via two light
// own-row selects — never the heavy usePurposeAnswers 5-table load, and
// never the leadership masking RPC (owner-gated; it rejects reps).
//
// Gating mirrors the reminder-card doctrine: feature flag on AND workshop
// submitted, else the caller renders nothing/a CTA — never a nag, and in
// View As preview the caller renders a placeholder (user.id would be the
// ADMIN's, and owners have no read path to a rep's whys by design).

import { useQuery } from "@tanstack/react-query";
import {
  isMissingMigration,
  purposeTable,
  type PurposeGoalRow,
  type PurposeWhyRow,
} from "@/hooks/usePurposeTable";

export type PurposeQuote = {
  coreWhy: string | null;
  missionTitle: string | null;
  missionDescription: string | null;
  missionTargetDate: string | null;
};

export const myPurposeQuoteKey = (userId: string) => ["my_purpose_quote", userId] as const;

export function useMyPurposeQuote(userId: string | undefined, enabled: boolean) {
  return useQuery({
    enabled: enabled && !!userId,
    queryKey: myPurposeQuoteKey(userId ?? ""),
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<PurposeQuote | null> => {
      const [whyRes, goalRes] = await Promise.all([
        purposeTable("purpose_whys")
          .select("answer_text, is_core_why")
          .eq("user_id", userId!)
          .eq("level_number", 7)
          .maybeSingle(),
        purposeTable("purpose_goals")
          .select("goal_title, goal_description, target_date")
          .eq("user_id", userId!)
          .eq("goal_type", "mission_90_day")
          .maybeSingle(),
      ]);
      if (whyRes.error) {
        if (isMissingMigration(whyRes.error)) return null;
        throw whyRes.error;
      }
      if (goalRes.error) {
        if (isMissingMigration(goalRes.error)) return null;
        throw goalRes.error;
      }
      const why = (whyRes.data ?? null) as unknown as Pick<
        PurposeWhyRow,
        "answer_text" | "is_core_why"
      > | null;
      const goal = (goalRes.data ?? null) as unknown as Pick<
        PurposeGoalRow,
        "goal_title" | "goal_description" | "target_date"
      > | null;
      if (!why && !goal) return null;
      return {
        coreWhy: why?.answer_text ?? null,
        missionTitle: goal?.goal_title ?? null,
        missionDescription: goal?.goal_description ?? null,
        missionTargetDate: goal?.target_date ?? null,
      };
    },
  });
}
