import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * The ONE profiles read for the canvasser's own row. Replaces five scattered
 * fetches (["my_office"], ["profile_goals"], ["scce_rank"], the HUD's profile
 * leg, and the old level-up effect's ad-hoc read) — current_rank alone used
 * to be fetched three times per page.
 */

export type CanvasserProfile = {
  office_location: string | null;
  display_name: string | null;
  current_rank: string | null;
  monthly_goal: number | null;
  weekly_income_goal: number | null;
  avg_commission: number | null;
  consecutive_weeks_3_plus_sits: number;
  consecutive_weeks_7_plus_sits: number;
  rolling_4_week_sit_avg: number;
  recruits_count: number;
  pay_lock_status: string | null;
};

export const canvasserProfileKey = (userId: string) => ["canvasser_profile", userId] as const;

export function useCanvasserProfile(userId: string | undefined) {
  return useQuery({
    enabled: !!userId,
    queryKey: canvasserProfileKey(userId ?? ""),
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select(
          "office_location, display_name, current_rank, monthly_goal, weekly_income_goal, avg_commission, consecutive_weeks_3_plus_sits, consecutive_weeks_7_plus_sits, rolling_4_week_sit_avg, recruits_count, pay_lock_status",
        )
        .eq("id", userId!)
        .maybeSingle();
      if (error) throw error;
      return data as CanvasserProfile | null;
    },
  });
}

/** Goal inputs clamp identically everywhere they're edited. */
export const clampGoal = (draft: string) => Math.max(0, Math.round(Number(draft) || 0));
/** Commission divides the goal — never let it hit 0. */
export const clampCommission = (draft: string, fallback: number) =>
  Math.max(1, Math.round(Number(draft) || fallback));

export type GoalsPatch = {
  monthly_goal?: number;
  weekly_income_goal?: number;
  avg_commission?: number;
};

/** The single goal mutation — any subset of the three goal columns. */
export function useSaveGoals(userId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: GoalsPatch) => {
      if (!userId) throw new Error("Not signed in");
      const { error } = await supabase.from("profiles").update(patch).eq("id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      if (userId) qc.invalidateQueries({ queryKey: canvasserProfileKey(userId) });
    },
  });
}
