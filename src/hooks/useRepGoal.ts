import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/** The sales rep's weekly VOLUME goal in dollars — profiles.weekly_volume_goal
 *  (20260922230000, superseding the count goal). Mirrors useCanvasserProfile's
 *  useSaveGoals shape, scoped to the one column reps need. */

export const repGoalKey = (userId: string) => ["rep_weekly_volume_goal", userId] as const;

export function useRepGoal(userId: string | undefined) {
  return useQuery({
    enabled: !!userId,
    queryKey: repGoalKey(userId ?? ""),
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("weekly_volume_goal")
        .eq("id", userId!)
        .maybeSingle();
      if (error) throw error;
      return (data?.weekly_volume_goal ?? null) as number | null;
    },
  });
}

/** Goal input clamps identically everywhere it's edited — whole dollars,
 *  never negative (mirrors clampGoal in useCanvasserProfile.ts). */
export const clampVolumeGoal = (draft: string) => Math.max(0, Math.round(Number(draft) || 0));

export function useSaveRepGoal(userId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (weekly_volume_goal: number) => {
      if (!userId) throw new Error("Not signed in");
      const { error } = await supabase
        .from("profiles")
        .update({ weekly_volume_goal })
        .eq("id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      if (userId) qc.invalidateQueries({ queryKey: repGoalKey(userId) });
    },
  });
}
