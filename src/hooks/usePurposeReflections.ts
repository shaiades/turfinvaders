import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Visibility } from "@/lib/purpose/types";
import { purposeTable, type PurposeReflectionRow } from "./usePurposeTable";

/** Weekly reflections — the rep's optional journal on Purpose Home. Private
 *  by default; each entry carries its own visibility choice. */

export const purposeReflectionsKey = (profileId: string) =>
  ["purpose_reflections", profileId] as const;

export function usePurposeReflections(profileId: string | undefined) {
  return useQuery({
    enabled: !!profileId,
    queryKey: purposeReflectionsKey(profileId ?? ""),
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await purposeTable("purpose_reflections")
        .select("*")
        .eq("purpose_profile_id", profileId!)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as unknown as PurposeReflectionRow[];
    },
  });
}

export function useSaveReflection(profile: { id: string; user_id: string } | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { answer_text: string; visibility: Visibility }) => {
      if (!profile) throw new Error("No purpose profile yet");
      const { error } = await purposeTable("purpose_reflections").insert({
        purpose_profile_id: profile.id,
        user_id: profile.user_id,
        answer_text: input.answer_text,
        visibility: input.visibility,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      if (profile) qc.invalidateQueries({ queryKey: purposeReflectionsKey(profile.id) });
    },
  });
}

export function useDeleteReflection(profileId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await purposeTable("purpose_reflections").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      if (profileId) qc.invalidateQueries({ queryKey: purposeReflectionsKey(profileId) });
    },
  });
}
